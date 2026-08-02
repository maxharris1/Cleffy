import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';

import { TICKS_PER_QUARTER } from './scoreData.js';
import type { ScoreNote, ScoreTimeSig } from './scoreData.js';
import { ERROR_CODES, JobError } from './errors.js';

/** Musical content extracted from MusicXML — geometry-free (that comes from the .omr). */
export interface MusicalScore {
    notes: ScoreNote[];
    /** In score order; geometry is zipped on later. */
    measures: Array<{ n: number; tick: number; dTicks: number }>;
    timeSignatures: ScoreTimeSig[];
    defaultBpm: number | null;
    totalTicks: number;
    warnings: string[];
}

const STEP_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

type Elem = NonNullable<ReturnType<DOMParser['parseFromString']>['documentElement']>;

const childElements = (parent: Elem, name?: string): Elem[] => {
    const out: Elem[] = [];
    for (let i = 0; i < parent.childNodes.length; i++) {
        const node = parent.childNodes[i];
        if (node && node.nodeType === 1 && (!name || node.nodeName === name)) {
            out.push(node as Elem);
        }
    }
    return out;
};

const firstChild = (parent: Elem, name: string): Elem | null => childElements(parent, name)[0] ?? null;

const childText = (parent: Elem, name: string): string | null => {
    const el = firstChild(parent, name);
    return el ? (el.textContent ?? '').trim() : null;
};

const childInt = (parent: Elem, name: string): number | null => {
    const text = childText(parent, name);
    if (text === null || text === '') {
        return null;
    }
    const value = Number.parseInt(text, 10);
    return Number.isFinite(value) ? value : null;
};

/** MIDI pitch from a <pitch> element (null for unpitched). */
const midiFromPitch = (pitch: Elem): number | null => {
    const step = childText(pitch, 'step');
    const octave = childInt(pitch, 'octave');
    if (!step || octave === null) {
        return null;
    }
    const semitone = STEP_SEMITONES[step.toUpperCase()];
    if (semitone === undefined) {
        return null;
    }
    const alterText = childText(pitch, 'alter');
    const alter = alterText ? Math.round(Number.parseFloat(alterText)) : 0;
    const midi = (octave + 1) * 12 + semitone + alter;
    return midi >= 0 && midi <= 127 ? midi : null;
};

/** Extract the (first) score XML from a compressed .mxl container. */
export const extractMxl = (mxlBytes: Buffer): string => {
    const zip = new AdmZip(mxlBytes);
    const container = zip.getEntry('META-INF/container.xml');
    if (container) {
        const doc = new DOMParser().parseFromString(container.getData().toString('utf8'), 'text/xml');
        const rootfiles = doc.getElementsByTagName('rootfile');
        const first = rootfiles.item(0);
        const path = first?.getAttribute('full-path');
        if (path) {
            const entry = zip.getEntry(path);
            if (entry) {
                return entry.getData().toString('utf8');
            }
        }
    }
    const fallback = zip
        .getEntries()
        .find((entry) => entry.entryName.toLowerCase().endsWith('.xml') && !entry.entryName.startsWith('META-INF'));
    if (!fallback) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'No score XML inside .mxl');
    }
    return fallback.getData().toString('utf8');
};

interface PartParseTarget {
    part: Elem;
    /** Hand for single-staff parts (multi-staff parts derive hand from <staff>). */
    fallbackHand: 0 | 1;
}

/**
 * Parse one exported MusicXML document (score-partwise) into musical content.
 * Time base: everything is normalized to 480 ticks/quarter regardless of the
 * file's <divisions>. Ties are merged; grace notes are skipped; repeats are
 * ignored (linear playthrough) with a warning.
 */
export const parseMusicXmlString = (xml: string, tickOffset = 0): MusicalScore => {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.documentElement;
    if (!root || root.nodeName !== 'score-partwise') {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, `Unsupported root <${root?.nodeName ?? 'none'}>`);
    }

    const warnings = new Set<string>();
    const parts = childElements(root, 'part');
    if (parts.length === 0) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'No <part> elements');
    }

    const lead = parts[0];
    if (!lead) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'No lead part');
    }
    const leadStaves = countDeclaredStaves(lead);
    const targets: PartParseTarget[] = [{ part: lead, fallbackHand: 0 }];
    if (leadStaves < 2 && parts.length >= 2 && parts[1]) {
        // Two single-staff parts: treat the second as the left hand.
        targets.push({ part: parts[1], fallbackHand: 1 });
    }
    if (parts.length > targets.length) {
        warnings.add('multi_part_collapsed');
    }

    // The lead part is the timeline authority: its measures define barlines.
    const leadResult = parsePart(lead, { fallbackHand: 0, timeline: null, tickOffset, warnings });
    const notes = [...leadResult.notes];
    for (const target of targets.slice(1)) {
        const secondary = parsePart(target.part, {
            fallbackHand: target.fallbackHand,
            timeline: leadResult.measures,
            tickOffset,
            warnings,
        });
        notes.push(...secondary.notes);
    }

    if (leadStaves < 2 && targets.length === 1) {
        warnings.add('single_staff_all_rh');
    }

    notes.sort((a, b) => a.t - b.t || a.h - b.h || a.p - b.p);
    const lastMeasure = leadResult.measures[leadResult.measures.length - 1];
    return {
        notes,
        measures: leadResult.measures,
        timeSignatures: leadResult.timeSignatures,
        defaultBpm: leadResult.defaultBpm,
        totalTicks: lastMeasure ? lastMeasure.tick + lastMeasure.dTicks : tickOffset,
        warnings: [...warnings],
    };
};

const countDeclaredStaves = (part: Elem): number => {
    let staves = 1;
    for (const measure of childElements(part, 'measure')) {
        for (const attributes of childElements(measure, 'attributes')) {
            const declared = childInt(attributes, 'staves');
            if (declared !== null) {
                staves = Math.max(staves, declared);
            }
        }
    }
    return staves;
};

interface PartContext {
    fallbackHand: 0 | 1;
    /** Barline authority from the lead part (secondary parts snap to it). */
    timeline: Array<{ n: number; tick: number; dTicks: number }> | null;
    tickOffset: number;
    warnings: Set<string>;
}

interface PartResult {
    notes: ScoreNote[];
    measures: Array<{ n: number; tick: number; dTicks: number }>;
    timeSignatures: ScoreTimeSig[];
    defaultBpm: number | null;
}

const parsePart = (part: Elem, ctx: PartContext): PartResult => {
    const notes: ScoreNote[] = [];
    const measures: Array<{ n: number; tick: number; dTicks: number }> = [];
    const timeSignatures: ScoreTimeSig[] = [];
    let defaultBpm: number | null = null;

    let divisions = 1;
    let currentSig = { num: 4, den: 4 };
    let measureStart = ctx.tickOffset;
    let runningNumber: number | null = null;
    /** Ties still waiting for their stop, keyed by staff:voice:midi. */
    const openTies = new Map<string, ScoreNote>();

    const measureElems = childElements(part, 'measure');
    for (let index = 0; index < measureElems.length; index++) {
        const measure = measureElems[index];
        if (!measure) {
            continue;
        }
        if (ctx.timeline) {
            const slot = ctx.timeline[index];
            if (slot) {
                measureStart = slot.tick;
            }
        }
        let cursor = measureStart;
        let maxCursor = measureStart;
        let lastNoteStart = measureStart;

        for (const child of childElements(measure)) {
            switch (child.nodeName) {
                case 'attributes': {
                    const declaredDivisions = childInt(child, 'divisions');
                    if (declaredDivisions && declaredDivisions > 0) {
                        divisions = declaredDivisions;
                    }
                    const time = firstChild(child, 'time');
                    if (time) {
                        const num = childInt(time, 'beats');
                        const den = childInt(time, 'beat-type');
                        if (num && den) {
                            currentSig = { num, den };
                            if (!ctx.timeline) {
                                const last = timeSignatures[timeSignatures.length - 1];
                                if (!last || last.num !== num || last.den !== den) {
                                    timeSignatures.push({ tick: measureStart, num, den });
                                }
                            }
                        }
                    }
                    break;
                }
                case 'direction': {
                    const sound = firstChild(child, 'sound');
                    const tempo = sound?.getAttribute('tempo');
                    if (defaultBpm === null && tempo) {
                        const parsed = Number.parseFloat(tempo);
                        if (Number.isFinite(parsed) && parsed > 0) {
                            defaultBpm = Math.round(parsed);
                        }
                    }
                    if (defaultBpm === null) {
                        const perMinute = child.getElementsByTagName('per-minute').item(0);
                        const parsed = perMinute ? Number.parseFloat(perMinute.textContent ?? '') : NaN;
                        if (Number.isFinite(parsed) && parsed > 0) {
                            defaultBpm = Math.round(parsed);
                        }
                    }
                    break;
                }
                case 'backup': {
                    const dur = childInt(child, 'duration') ?? 0;
                    cursor = Math.max(measureStart, cursor - ticksOf(dur, divisions));
                    break;
                }
                case 'forward': {
                    const dur = childInt(child, 'duration') ?? 0;
                    cursor += ticksOf(dur, divisions);
                    maxCursor = Math.max(maxCursor, cursor);
                    break;
                }
                case 'barline': {
                    if (firstChild(child, 'repeat')) {
                        ctx.warnings.add('repeats_ignored');
                    }
                    break;
                }
                case 'note': {
                    if (firstChild(child, 'grace')) {
                        ctx.warnings.add('grace_notes_skipped');
                        break;
                    }
                    const isChord = firstChild(child, 'chord') !== null;
                    const durTicks = ticksOf(childInt(child, 'duration') ?? 0, divisions);
                    const start = isChord ? lastNoteStart : cursor;
                    const isRest = firstChild(child, 'rest') !== null;

                    if (!isRest && durTicks > 0) {
                        const pitch = firstChild(child, 'pitch');
                        const midi = pitch ? midiFromPitch(pitch) : null;
                        if (midi !== null) {
                            const staffNum = childInt(child, 'staff') ?? 1;
                            const hand: 0 | 1 = staffNum >= 2 ? 1 : ctx.fallbackHand;
                            const voice = childText(child, 'voice') ?? '1';
                            const tieTypes = childElements(child, 'tie').map((tie) => tie.getAttribute('type'));
                            const tieKey = `${staffNum}:${voice}:${midi}`;

                            if (tieTypes.includes('stop') && openTies.has(tieKey)) {
                                const open = openTies.get(tieKey);
                                if (open) {
                                    open.d += durTicks;
                                    if (!tieTypes.includes('start')) {
                                        openTies.delete(tieKey);
                                    }
                                }
                            } else {
                                const note: ScoreNote = { t: start, d: durTicks, p: midi, h: hand };
                                notes.push(note);
                                if (tieTypes.includes('start')) {
                                    openTies.set(tieKey, note);
                                }
                            }
                        }
                    }
                    if (!isChord) {
                        lastNoteStart = start;
                        cursor += durTicks;
                        maxCursor = Math.max(maxCursor, cursor);
                    }
                    break;
                }
                default:
                    break;
            }
        }

        let length = maxCursor - measureStart;
        if (ctx.timeline) {
            length = ctx.timeline[index]?.dTicks ?? length;
        } else if (length <= 0) {
            // Empty/unreadable measure: assume a full measure of the active signature.
            length = Math.max(1, Math.round(currentSig.num * ((TICKS_PER_QUARTER * 4) / currentSig.den)));
        }

        const numberAttr = measure.getAttribute('number');
        const parsedNumber = numberAttr ? Number.parseInt(numberAttr, 10) : NaN;
        const displayNumber: number = Number.isFinite(parsedNumber) ? parsedNumber : (runningNumber ?? 0) + 1;
        runningNumber = displayNumber;

        measures.push({ n: displayNumber, tick: measureStart, dTicks: length });
        measureStart += length;
    }

    if (timeSignatures.length === 0 && !ctx.timeline) {
        timeSignatures.push({ tick: ctx.tickOffset, num: currentSig.num, den: currentSig.den });
    }

    return { notes, measures, timeSignatures, defaultBpm };
};

const ticksOf = (duration: number, divisions: number): number =>
    Math.max(0, Math.round((duration * TICKS_PER_QUARTER) / Math.max(1, divisions)));

/**
 * Parse one or more exported .mxl files (Audiveris writes one per detected
 * movement) into a single tick-continuous MusicalScore.
 */
export const parseMxlFiles = (files: Buffer[]): MusicalScore => {
    if (files.length === 0) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'No MusicXML produced');
    }
    const combined: MusicalScore = {
        notes: [],
        measures: [],
        timeSignatures: [],
        defaultBpm: null,
        totalTicks: 0,
        warnings: [],
    };
    const warnings = new Set<string>();
    for (const file of files) {
        const parsed = parseMusicXmlString(extractMxl(file), combined.totalTicks);
        combined.notes.push(...parsed.notes);
        combined.measures.push(...parsed.measures);
        combined.timeSignatures.push(...parsed.timeSignatures);
        combined.defaultBpm = combined.defaultBpm ?? parsed.defaultBpm;
        combined.totalTicks = parsed.totalTicks;
        parsed.warnings.forEach((warning) => warnings.add(warning));
    }
    if (files.length > 1) {
        warnings.add('multiple_movements_concatenated');
    }
    combined.warnings = [...warnings];
    combined.notes.sort((a, b) => a.t - b.t || a.h - b.h || a.p - b.p);
    return combined;
};
