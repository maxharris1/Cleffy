import AdmZip from 'adm-zip';
import { DOMParser } from '@xmldom/xmldom';

import { TICKS_PER_QUARTER } from './scoreData.js';
import type { ScoreClef, ScoreKeySig, ScoreNote, ScoreTimeSig } from './scoreData.js';
import { ERROR_CODES, JobError } from './errors.js';

/** Musical content extracted from MusicXML — geometry-free (that comes from the .omr). */
export interface MusicalScore {
    notes: ScoreNote[];
    /** In score order; geometry is zipped on later. */
    measures: Array<{ n: number; tick: number; dTicks: number }>;
    timeSignatures: ScoreTimeSig[];
    keySignatures: ScoreKeySig[];
    clefs: ScoreClef[];
    defaultBpm: number | null;
    totalTicks: number;
    warnings: string[];
}

const STEP_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** The engine's default when a note carries no velocity — roughly mezzo-forte. */
const DEFAULT_VELOCITY = 0.72;

/** Sustained dynamic marks → velocity levels (perceptual spread pp…fff). */
const DYNAMIC_LEVELS: Record<string, number> = {
    pppp: 0.2,
    ppp: 0.26,
    pp: 0.34,
    p: 0.46,
    mp: 0.58,
    mf: 0.7,
    f: 0.82,
    ff: 0.92,
    fff: 1,
    ffff: 1,
};

/** One-note accents: sforzando family punches the next attack only. */
const ACCENT_DYNAMICS = new Set(['sf', 'sfz', 'sffz', 'fz', 'rf', 'rfz', 'fp', 'sfp']);

/** Crushed grace-note length (≈55 ms at 120 bpm) — acciaccatura feel. */
const GRACE_TICKS = 110;

const clampVelocity = (v: number): number => Math.min(1, Math.max(0.1, v));
const roundVelocity = (v: number): number => Math.round(v * 100) / 100;

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
const MAX_MXL_ENTRY_BYTES = 8 * 1024 * 1024;

export const extractMxl = (mxlBytes: Buffer): string => {
    if (mxlBytes.byteLength > MAX_MXL_ENTRY_BYTES * 2) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'MusicXML archive too large');
    }
    const zip = new AdmZip(mxlBytes);
    const container = zip.getEntry('META-INF/container.xml');
    if (container) {
        if (container.header.size > MAX_MXL_ENTRY_BYTES) {
            throw new JobError(ERROR_CODES.musicXmlParseFailed, 'MusicXML entry too large');
        }
        const doc = new DOMParser().parseFromString(container.getData().toString('utf8'), 'text/xml');
        const rootfiles = doc.getElementsByTagName('rootfile');
        const first = rootfiles.item(0);
        const path = first?.getAttribute('full-path');
        if (path) {
            const entry = zip.getEntry(path);
            if (entry) {
                if (entry.header.size > MAX_MXL_ENTRY_BYTES) {
                    throw new JobError(ERROR_CODES.musicXmlParseFailed, 'MusicXML entry too large');
                }
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
    if (fallback.header.size > MAX_MXL_ENTRY_BYTES) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'MusicXML entry too large');
    }
    return fallback.getData().toString('utf8');
};

interface PartParseTarget {
    part: Elem;
    /** Hand for single-staff parts (multi-staff parts derive hand from <staff>). */
    fallbackHand: 0 | 1;
}

/** Cleffy is piano-first — boost keyboard names, penalize vocal/OCR ghosts. */
const PIANO_NAME_RE = /\b(piano|pianoforte|pno\.?|kbd|keyboard|clavier)\b/i;
const NOISE_NAME_RE = /\b(voice|vocal|soprano|alto|tenor|bass|choir|chorus|lyrics?)\b/i;
/** Parts below this fraction of the densest part's pitched notes are treated as noise. */
const NOISE_PITCHED_FRACTION = 0.1;

interface PartCandidate {
    part: Elem;
    index: number;
    name: string;
    staves: number;
    pitchedNotes: number;
    nameScore: number;
}

/**
 * Parse one exported MusicXML document (score-partwise) into musical content.
 * Time base: everything is normalized to 480 ticks/quarter regardless of the
 * file's <divisions>. Ties are merged; grace notes are skipped; repeats are
 * ignored (linear playthrough) with a warning.
 *
 * Part selection is piano-primary: prefer a grand-staff / Piano-named part over
 * document order so Audiveris "Voice" dummy parts (and art-song vocal lines)
 * do not become the play-along timeline.
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

    const targets = selectPartTargets(root, parts, warnings);
    const lead = targets[0]?.part;
    if (!lead) {
        throw new JobError(ERROR_CODES.musicXmlParseFailed, 'No lead part');
    }
    const leadStaves = countDeclaredStaves(lead);

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
        keySignatures: leadResult.keySignatures,
        clefs: leadResult.clefs,
        defaultBpm: leadResult.defaultBpm,
        totalTicks: lastMeasure ? lastMeasure.tick + lastMeasure.dTicks : tickOffset,
        warnings: [...warnings],
    };
};

/**
 * Choose which MusicXML parts feed playback/fingering.
 *
 * 1. Grand staff (staves ≥ 2) or strongly Piano-named → richest such part alone.
 * 2. Else densest non-noise single-staff parts, pairing a second as LH when present.
 * 3. Noise = sparse pitched content (< 10% of max) and/or vocal-ish names when a
 *    denser part exists — never merge those notes into the piano timeline.
 */
const selectPartTargets = (root: Elem, parts: Elem[], warnings: Set<string>): PartParseTarget[] => {
    const names = partNameById(root);
    const candidates: PartCandidate[] = parts.map((part, index) => {
        const id = part.getAttribute('id') ?? '';
        const name = names.get(id) ?? '';
        const staves = countDeclaredStaves(part);
        const pitchedNotes = countPitchedNotes(part);
        let nameScore = 0;
        if (PIANO_NAME_RE.test(name)) {
            nameScore += 2;
        }
        if (NOISE_NAME_RE.test(name)) {
            nameScore -= 2;
        }
        return { part, index, name, staves, pitchedNotes, nameScore };
    });

    const maxPitched = Math.max(0, ...candidates.map((c) => c.pitchedNotes));
    const isNoise = (c: PartCandidate): boolean =>
        maxPitched > 0 && c.pitchedNotes < maxPitched * NOISE_PITCHED_FRACTION;

    const rank = (a: PartCandidate, b: PartCandidate): number =>
        b.pitchedNotes - a.pitchedNotes || b.nameScore - a.nameScore || b.staves - a.staves || a.index - b.index;

    const grands = candidates
        .filter((c) => c.staves >= 2 || (c.nameScore > 0 && !isNoise(c)))
        .sort(rank);

    let selected: PartCandidate[];
    if (grands[0]) {
        // Piano product rule: one grand/piano timeline — do not pair leftover Voices.
        selected = [grands[0]];
    } else {
        const usable = candidates.filter((c) => !isNoise(c));
        const pool = (usable.length > 0 ? usable : candidates).slice().sort(rank);
        const lead = pool[0];
        if (!lead) {
            selected = candidates.slice(0, 1);
        } else if (lead.staves < 2) {
            const secondary = pool.find((c) => c.part !== lead.part && c.staves < 2);
            selected = secondary ? [lead, secondary] : [lead];
        } else {
            selected = [lead];
        }
    }

    if (parts.length > selected.length) {
        warnings.add('multi_part_collapsed');
    }

    return selected.map((c, i) => ({
        part: c.part,
        fallbackHand: (i === 0 ? 0 : 1) as 0 | 1,
    }));
};

/** Map score-part id → printed part-name (empty when absent). */
const partNameById = (root: Elem): Map<string, string> => {
    const map = new Map<string, string>();
    const partList = firstChild(root, 'part-list');
    if (!partList) {
        return map;
    }
    for (const scorePart of childElements(partList, 'score-part')) {
        const id = scorePart.getAttribute('id');
        if (!id) {
            continue;
        }
        map.set(id, (childText(scorePart, 'part-name') ?? '').trim());
    }
    return map;
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

/** Pitched (non-rest) note elements — used only for part ranking, not playback. */
const countPitchedNotes = (part: Elem): number => {
    let count = 0;
    for (const measure of childElements(part, 'measure')) {
        for (const noteEl of childElements(measure, 'note')) {
            if (firstChild(noteEl, 'rest') || firstChild(noteEl, 'grace')) {
                continue;
            }
            if (firstChild(noteEl, 'pitch')) {
                count += 1;
            }
        }
    }
    return count;
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
    keySignatures: ScoreKeySig[];
    clefs: ScoreClef[];
    defaultBpm: number | null;
}

const parsePart = (part: Elem, ctx: PartContext): PartResult => {
    const notes: ScoreNote[] = [];
    const measures: Array<{ n: number; tick: number; dTicks: number }> = [];
    const timeSignatures: ScoreTimeSig[] = [];
    const keySignatures: ScoreKeySig[] = [];
    const clefs: ScoreClef[] = [];
    let defaultBpm: number | null = null;

    let divisions = 1;
    let currentSig = { num: 4, den: 4 };
    let measureStart = ctx.tickOffset;
    let runningNumber: number | null = null;
    /** Sustained dynamic level in force (undefined → engine default). */
    let currentVelocity: number | undefined;
    /** A sforzando-family mark punches only the next attack. */
    let pendingAccent = false;
    /** Velocity given to the current chord's base note — chord members share it. */
    let slotVelocity: number | undefined;
    /** Grace notes buffered until their principal note arrives. */
    let pendingGraces: Array<{ midi: number; hand: 0 | 1 }> = [];
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
                    if (!ctx.timeline) {
                        const key = firstChild(child, 'key');
                        if (key) {
                            const fifths = childInt(key, 'fifths');
                            if (fifths !== null && fifths >= -7 && fifths <= 7) {
                                const last = keySignatures[keySignatures.length - 1];
                                if (!last || last.fifths !== fifths) {
                                    keySignatures.push({ tick: measureStart, fifths });
                                }
                            }
                        }
                        for (const clefEl of childElements(child, 'clef')) {
                            const signRaw = (childText(clefEl, 'sign') ?? '').toUpperCase();
                            if (signRaw !== 'G' && signRaw !== 'F' && signRaw !== 'C') {
                                continue;
                            }
                            const numberAttr = clefEl.getAttribute('number');
                            const staffNum = numberAttr ? Number.parseInt(numberAttr, 10) : 1;
                            const staff: 0 | 1 = staffNum >= 2 ? 1 : 0;
                            const line = childInt(clefEl, 'line') ?? (signRaw === 'F' ? 4 : signRaw === 'C' ? 3 : 2);
                            const last = [...clefs].reverse().find((c) => c.staff === staff);
                            if (!last || last.sign !== signRaw || last.line !== line) {
                                clefs.push({ tick: measureStart, staff, sign: signRaw, line });
                            }
                        }
                    }
                    break;
                }
                case 'direction': {
                    // <sound tempo> is quarter-BPM by definition — prefer it.
                    const sound = firstChild(child, 'sound');
                    const tempo = sound?.getAttribute('tempo');
                    if (defaultBpm === null && tempo) {
                        // MusicXML <sound tempo> is always quarter-notes-per-minute.
                        const parsed = Number.parseFloat(tempo);
                        if (Number.isFinite(parsed) && parsed > 0) {
                            defaultBpm = Math.round(parsed);
                        }
                    }
                    // A printed metronome mark is per BEAT UNIT: convert to quarter-BPM.
                    if (defaultBpm === null) {
                        const metronome = child.getElementsByTagName('metronome').item(0) as Elem | null;
                        const perMinute = metronome ? childText(metronome, 'per-minute') : null;
                        const parsed = perMinute ? Number.parseFloat(perMinute) : NaN;
                        if (Number.isFinite(parsed) && parsed > 0) {
                            // Convert beat-unit (and dots) to quarter-note BPM.
                            const quartersPerBeat = beatUnitToQuarters(metronome);
                            defaultBpm = Math.round(parsed * quartersPerBeat);
                        }
                    }
                    // Dynamics shape every following attack; sf-family accents one.
                    const dynamics = child.getElementsByTagName('dynamics').item(0) as Elem | null;
                    if (dynamics) {
                        for (const mark of childElements(dynamics)) {
                            const level = DYNAMIC_LEVELS[mark.nodeName];
                            if (level !== undefined) {
                                currentVelocity = level;
                                break;
                            }
                            if (ACCENT_DYNAMICS.has(mark.nodeName)) {
                                pendingAccent = true;
                                if (mark.nodeName === 'fp' || mark.nodeName === 'sfp') {
                                    currentVelocity = DYNAMIC_LEVELS['p'];
                                }
                                break;
                            }
                        }
                    } else {
                        // <sound dynamics> is a percentage of a standard forte.
                        const soundDynamics = sound?.getAttribute('dynamics');
                        const pct = soundDynamics ? Number.parseFloat(soundDynamics) : NaN;
                        if (Number.isFinite(pct) && pct > 0) {
                            currentVelocity = roundVelocity(clampVelocity((pct / 100) * 0.82));
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
                        // Buffer graces; they crush in just before their principal.
                        const gracePitch = firstChild(child, 'pitch');
                        const graceMidi = gracePitch ? midiFromPitch(gracePitch) : null;
                        if (graceMidi !== null && pendingGraces.length < 8) {
                            const graceStaff = childInt(child, 'staff') ?? 1;
                            pendingGraces.push({ midi: graceMidi, hand: graceStaff >= 2 ? 1 : ctx.fallbackHand });
                        }
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

                            // A tie-stop must continue a note of the same pitch
                            // that ends exactly where this one starts. Match by
                            // key first, but fall back on that musical adjacency
                            // — Audiveris renumbers voices across system breaks,
                            // and a missed merge re-attacks a held note.
                            const resolveOpenTie = (): string | null => {
                                if (openTies.has(tieKey)) {
                                    return tieKey;
                                }
                                let crossStaff: string | null = null;
                                for (const [key, open] of openTies) {
                                    const parts = key.split(':');
                                    if (parts[2] !== String(midi) || Math.abs(open.t + open.d - start) > 2) {
                                        continue;
                                    }
                                    if (parts[0] === String(staffNum)) {
                                        return key;
                                    }
                                    crossStaff = crossStaff ?? key;
                                }
                                return crossStaff;
                            };

                            const openKey = tieTypes.includes('stop') ? resolveOpenTie() : null;
                            if (openKey) {
                                const open = openTies.get(openKey);
                                if (open) {
                                    open.d += durTicks;
                                    openTies.delete(openKey);
                                    if (tieTypes.includes('start')) {
                                        // Chain continues under this note's identity.
                                        openTies.set(tieKey, open);
                                    }
                                }
                            } else {
                                if (!isChord && pendingGraces.length > 0) {
                                    // Crush buffered graces just before this attack,
                                    // stealing time from what came before (they may
                                    // reach back across the barline — that's correct).
                                    const count = pendingGraces.length;
                                    pendingGraces.forEach((grace, i) => {
                                        notes.push({
                                            t: Math.max(ctx.tickOffset, start - GRACE_TICKS * (count - i)),
                                            d: GRACE_TICKS,
                                            p: grace.midi,
                                            h: grace.hand,
                                            v: roundVelocity(
                                                clampVelocity((currentVelocity ?? DEFAULT_VELOCITY) * 0.8),
                                            ),
                                        });
                                    });
                                    pendingGraces = [];
                                }
                                // Chord members share their base note's velocity so an
                                // accent lands on the whole chord, not just one voice.
                                let velocity: number | undefined;
                                if (isChord) {
                                    velocity = slotVelocity;
                                } else if (pendingAccent) {
                                    pendingAccent = false;
                                    velocity = roundVelocity(
                                        clampVelocity((currentVelocity ?? DEFAULT_VELOCITY) + 0.2),
                                    );
                                    slotVelocity = velocity;
                                } else {
                                    velocity = currentVelocity;
                                    slotVelocity = velocity;
                                }
                                const note: ScoreNote = {
                                    t: start,
                                    d: durTicks,
                                    p: midi,
                                    h: hand,
                                    ...(velocity !== undefined ? { v: velocity } : {}),
                                };
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

        const numberAttr = measure.getAttribute('number');
        const parsedNumber = numberAttr ? Number.parseInt(numberAttr, 10) : NaN;
        const displayNumber: number = Number.isFinite(parsedNumber) ? parsedNumber : (runningNumber ?? 0) + 1;
        runningNumber = displayNumber;

        const expected = Math.max(
            1,
            Math.round(currentSig.num * ((TICKS_PER_QUARTER * 4) / currentSig.den)),
        );
        // Pickups stay content-length (MusicXML implicit / measure 0); other bars
        // snap underfull content up to the active signature so later ticks don't skew.
        const isPickup = measure.getAttribute('implicit') === 'yes' || displayNumber === 0;
        let length = maxCursor - measureStart;
        const contentLen = length;
        if (ctx.timeline) {
            length = ctx.timeline[index]?.dTicks ?? length;
            // Lead timeline may be longer after underfull padding — extend open
            // ties so secondary-part cross-bar ties still sound past the pad.
            if (length > contentLen) {
                const pad = length - contentLen;
                for (const open of openTies.values()) {
                    open.d += pad;
                }
            }
        } else if (length <= 0) {
            length = expected;
        } else if (!isPickup && length < expected) {
            const pad = expected - length;
            ctx.warnings.add('measure_underfull');
            // Extend open ties across the inserted gap so a tie-stop in the next
            // bar still lands after the real sounding content, not in the pad.
            for (const open of openTies.values()) {
                open.d += pad;
            }
            length = expected;
        } else if (!isPickup && length > expected) {
            ctx.warnings.add('measure_overfull');
            // Keep content length so note onsets stay consistent with the timeline.
        }

        measures.push({ n: displayNumber, tick: measureStart, dTicks: length });
        measureStart += length;
    }

    if (pendingGraces.length > 0) {
        // Graces with no principal note to attach to (OMR tail damage).
        ctx.warnings.add('grace_notes_skipped');
    }

    if (timeSignatures.length === 0 && !ctx.timeline) {
        timeSignatures.push({ tick: ctx.tickOffset, num: currentSig.num, den: currentSig.den });
    }

    return { notes, measures, timeSignatures, keySignatures, clefs, defaultBpm };
};

const ticksOf = (duration: number, divisions: number): number =>
    Math.max(0, Math.round((duration * TICKS_PER_QUARTER) / Math.max(1, divisions)));

/** Quarters spanned by a MusicXML <beat-unit> (+ optional <beat-unit-dot>s). */
const BEAT_UNIT_QUARTERS: Record<string, number> = {
    whole: 4,
    half: 2,
    quarter: 1,
    eighth: 0.5,
    '16th': 0.25,
    '32nd': 0.125,
    '64th': 0.0625,
    '128th': 0.03125,
};

const beatUnitToQuarters = (metronome: Elem | null): number => {
    if (!metronome) {
        return 1;
    }
    const unit = (childText(metronome, 'beat-unit') ?? 'quarter').toLowerCase();
    let factor = BEAT_UNIT_QUARTERS[unit] ?? 1;
    let add = factor / 2;
    for (let i = 0; i < childElements(metronome, 'beat-unit-dot').length; i++) {
        factor += add;
        add /= 2;
    }
    return factor;
};

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
        keySignatures: [],
        clefs: [],
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
        combined.keySignatures.push(...parsed.keySignatures);
        combined.clefs.push(...parsed.clefs);
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
