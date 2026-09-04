import { TICKS_PER_QUARTER } from '../../scoreData.js';
import type { LlmMeasure, LlmPageTranscription } from './schema.js';

/**
 * Compact LLM transcription → MusicXML (score-partwise, one piano part with
 * two staves). Emitting MusicXML rather than a MusicalScore directly means the
 * production parser (musicxml.ts) owns ties, meter correction, repeat
 * structure, tempo resolution and dynamics exactly as it does for Audiveris.
 */

const DIVISIONS = TICKS_PER_QUARTER;

const BASE_TICKS: Record<string, number> = {
    w: DIVISIONS * 4,
    h: DIVISIONS * 2,
    q: DIVISIONS,
    e: DIVISIONS / 2,
    s: DIVISIONS / 4,
    t: DIVISIONS / 8,
    x: DIVISIONS / 16,
};

const TYPE_NAMES: Record<string, string> = {
    w: 'whole',
    h: 'half',
    q: 'quarter',
    e: 'eighth',
    s: '16th',
    t: '32nd',
    x: '64th',
};

/** '/n' suffix → actual:normal time modification. */
const TUPLETS: Record<string, { actual: number; normal: number }> = {
    '3': { actual: 3, normal: 2 },
    '5': { actual: 5, normal: 4 },
    '6': { actual: 6, normal: 4 },
    '7': { actual: 7, normal: 4 },
};

const ACCIDENTAL_ALTER: Record<string, number> = { '': 0, '#': 1, '##': 2, x: 2, b: -1, bb: -2 };

const DYNAMICS = new Set(['pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff', 'sf', 'sfz', 'sffz', 'fz', 'rf', 'rfz', 'fp', 'sfp']);

export interface Pitch {
    step: string;
    alter: number;
    octave: number;
}

export interface VoiceEvent {
    grace: boolean;
    /** null = rest. */
    pitches: Pitch[] | null;
    ticks: number;
    type: string;
    dots: number;
    tuplet: { actual: number; normal: number } | null;
    tie: boolean;
    raw: string;
}

export interface ParsedVoice {
    events: VoiceEvent[];
    ticks: number;
    /** Tokens that did not parse; they are dropped, not guessed at. */
    errors: string[];
}

const EVENT_RE = /^(g)?(r|\[[^\]]*\]|[A-G](?:##|#|x|bb|b)?-?\d)(?::([whqestx])(\.{0,2})(?:\/([3567]))?)?(~)?$/;
const PITCH_RE = /^([A-G])(##|#|x|bb|b)?(-?\d)$/;

export const parsePitch = (token: string): Pitch | null => {
    const m = PITCH_RE.exec(token.trim());
    if (!m) {
        return null;
    }
    const octave = Number(m[3]);
    if (octave < 0 || octave > 9) {
        return null;
    }
    return { step: m[1]!, alter: ACCIDENTAL_ALTER[m[2] ?? ''] ?? 0, octave };
};

export const parseVoice = (voice: string): ParsedVoice => {
    const events: VoiceEvent[] = [];
    const errors: string[] = [];
    let ticks = 0;
    // Tokens are whitespace-separated except inside [chord brackets].
    for (const rawToken of voice.match(/(?:\[[^\]]*\]|[^\s[\]]+)+/g) ?? []) {
        // Tolerated slips seen in model output: a detached "~", a dot on the pitch ("A3.:e").
        if (rawToken === '~') {
            const last = events[events.length - 1];
            if (last) {
                last.tie = true;
            }
            continue;
        }
        const token = rawToken.replace(/^([^:]*?)(\.+):([whqestx])/, '$1:$3$2');
        const m = EVENT_RE.exec(token);
        if (!m) {
            errors.push(token);
            continue;
        }
        const grace = m[1] === 'g';
        const pitchPart = m[2]!;
        let pitches: Pitch[] | null;
        if (pitchPart === 'r') {
            pitches = null;
        } else {
            const names = pitchPart.startsWith('[') ? pitchPart.slice(1, -1).split(/\s+/).filter(Boolean) : [pitchPart];
            const parsed = names.map(parsePitch);
            if (parsed.length === 0 || parsed.some((p) => p === null)) {
                errors.push(token);
                continue;
            }
            pitches = parsed as Pitch[];
        }
        // Graces may omit a duration; anything else without one is malformed.
        const durLetter = m[3] ?? (grace ? 'e' : null);
        if (!durLetter) {
            errors.push(token);
            continue;
        }
        const dots = (m[4] ?? '').length;
        const tuplet = m[5] ? TUPLETS[m[5]] ?? null : null;
        let dur = BASE_TICKS[durLetter]!;
        if (dots === 1) {
            dur *= 1.5;
        } else if (dots === 2) {
            dur *= 1.75;
        }
        if (tuplet) {
            dur = (dur * tuplet.normal) / tuplet.actual;
        }
        const eventTicks = grace ? 0 : Math.max(1, Math.round(dur));
        events.push({ grace, pitches, ticks: eventTicks, type: TYPE_NAMES[durLetter]!, dots, tuplet, tie: m[6] === '~', raw: token });
        ticks += eventTicks;
    }
    return { events, ticks, errors };
};

export const meterTicks = (ts: string): number | null => {
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(ts.trim());
    if (!m) {
        const upper = ts.trim().toUpperCase();
        if (upper === 'C') {
            return DIVISIONS * 4;
        }
        if (upper === '¢' || upper === 'C|') {
            return DIVISIONS * 4;
        }
        return null;
    }
    const beats = Number(m[1]);
    const beatType = Number(m[2]);
    if (!beats || !beatType) {
        return null;
    }
    return Math.round((beats * 4 * DIVISIONS) / beatType);
};

const normaliseTs = (ts: string): { beats: number; beatType: number } | null => {
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(ts.trim());
    if (m) {
        return { beats: Number(m[1]), beatType: Number(m[2]) };
    }
    const upper = ts.trim().toUpperCase();
    if (upper === 'C') {
        return { beats: 4, beatType: 4 };
    }
    if (upper === '¢' || upper === 'C|') {
        return { beats: 2, beatType: 2 };
    }
    return null;
};

export interface MeasureStat {
    page: number;
    system: number;
    /** 0-based index across the whole score (before any fallback splicing). */
    index: number;
    expectedTicks: number;
    /** Per-voice ticks, upper staff then lower staff. */
    rh: number[];
    lh: number[];
    parseErrors: number;
    overfull: boolean;
    underfull: boolean;
}

export interface TranscriptionStats {
    measures: MeasureStat[];
    /** Per page: measure count and how many bars have a rhythm problem. */
    pages: Array<{ page: number; measures: number; bad: number; parseErrors: number; systems: number }>;
}

export interface ToMusicXmlOptions {
    /** Meter assumed until the transcription prints one. */
    defaultTimeSignature?: string;
    defaultKeyFifths?: number;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const noteXml = (
    ev: VoiceEvent,
    pitch: Pitch | null,
    chord: boolean,
    voice: number,
    staff: number,
    tieStop: boolean,
    measureRest: number | null,
): string => {
    const parts: string[] = ['<note>'];
    if (ev.grace) {
        parts.push('<grace/>');
    }
    if (chord) {
        parts.push('<chord/>');
    }
    if (pitch) {
        parts.push(`<pitch><step>${pitch.step}</step>${pitch.alter ? `<alter>${pitch.alter}</alter>` : ''}<octave>${pitch.octave}</octave></pitch>`);
    } else if (measureRest !== null) {
        parts.push('<rest measure="yes"/>');
    } else {
        parts.push('<rest/>');
    }
    if (!ev.grace) {
        parts.push(`<duration>${measureRest ?? ev.ticks}</duration>`);
    }
    if (pitch && tieStop) {
        parts.push('<tie type="stop"/>');
    }
    if (pitch && ev.tie) {
        parts.push('<tie type="start"/>');
    }
    parts.push(`<voice>${voice}</voice>`);
    if (measureRest === null) {
        parts.push(`<type>${ev.type}</type>`);
        for (let i = 0; i < ev.dots; i++) {
            parts.push('<dot/>');
        }
        if (ev.tuplet) {
            parts.push(`<time-modification><actual-notes>${ev.tuplet.actual}</actual-notes><normal-notes>${ev.tuplet.normal}</normal-notes></time-modification>`);
        }
    }
    parts.push(`<staff>${staff}</staff>`);
    if (pitch && (tieStop || ev.tie)) {
        parts.push(`<notations>${tieStop ? '<tied type="stop"/>' : ''}${ev.tie ? '<tied type="start"/>' : ''}</notations>`);
    }
    parts.push('</note>');
    return parts.join('');
};

/** A lone rest is the engraver's whole-bar rest whatever its written value. */
const isSoleRest = (parsed: ParsedVoice): boolean => parsed.events.length === 1 && parsed.events[0]!.pitches === null && !parsed.events[0]!.grace;

const voiceXml = (parsed: ParsedVoice, voice: number, staff: number, expectedTicks: number): { xml: string; ticks: number } => {
    const out: string[] = [];
    if (isSoleRest(parsed)) {
        out.push(noteXml(parsed.events[0]!, null, false, voice, staff, false, expectedTicks));
        return { xml: out.join(''), ticks: expectedTicks };
    }
    let prevTied: Pitch[] | null = null;
    for (const ev of parsed.events) {
        if (ev.pitches === null) {
            out.push(noteXml(ev, null, false, voice, staff, false, null));
            prevTied = null;
            continue;
        }
        ev.pitches.forEach((pitch, i) => {
            const tieStop = prevTied?.some((p) => p.step === pitch.step && p.alter === pitch.alter && p.octave === pitch.octave) ?? false;
            out.push(noteXml(ev, pitch, i > 0, voice, staff, tieStop, null));
        });
        if (!ev.grace) {
            prevTied = ev.tie ? ev.pitches : null;
        }
    }
    return { xml: out.join(''), ticks: parsed.ticks };
};

const barlineXml = (location: 'left' | 'right', repeat: 'forward' | 'backward' | null, ending: { number: number; type: 'start' | 'stop' } | null): string => {
    if (!repeat && !ending) {
        return '';
    }
    const parts = [`<barline location="${location}">`];
    if (repeat === 'backward') {
        parts.push('<bar-style>light-heavy</bar-style>');
    } else if (repeat === 'forward') {
        parts.push('<bar-style>heavy-light</bar-style>');
    }
    if (ending) {
        parts.push(`<ending number="${ending.number}" type="${ending.type}"/>`);
    }
    if (repeat) {
        parts.push(`<repeat direction="${repeat}"/>`);
    }
    parts.push('</barline>');
    return parts.join('');
};

/**
 * Serialize the pages of a score. `stats` describes per-bar rhythm health so a
 * caller can decide which pages deserve a fallback.
 */
export const toMusicXml = (pages: LlmPageTranscription[], options: ToMusicXmlOptions = {}): { xml: string; stats: TranscriptionStats } => {
    const measuresXml: string[] = [];
    const stats: TranscriptionStats = { measures: [], pages: [] };
    let ts = normaliseTs(options.defaultTimeSignature ?? '4/4') ?? { beats: 4, beatType: 4 };
    let keyFifths = options.defaultKeyFifths ?? 0;
    let index = 0;
    let prevEnding: number | null = null;

    const flat: Array<{ page: number; system: number; m: LlmMeasure }> = [];
    pages.forEach((page, p) => {
        page.systems.forEach((system, s) => {
            for (const m of system.measures) {
                flat.push({ page: p, system: s, m });
            }
        });
    });

    for (const [flatIndex, { page, system, m }] of flat.entries()) {
        const printedTs = m.ts ? normaliseTs(m.ts) : null;
        if (printedTs) {
            ts = printedTs;
        }
        const printedKey = typeof m.key === 'number' && m.key >= -7 && m.key <= 7 ? m.key : null;
        if (printedKey !== null) {
            keyFifths = printedKey;
        }
        const expectedTicks = Math.round((ts.beats * 4 * DIVISIONS) / ts.beatType);

        const rh = (m.rh ?? []).map(parseVoice);
        const lh = (m.lh ?? []).map(parseVoice);
        const parseErrors = [...rh, ...lh].reduce((n, v) => n + v.errors.length, 0);

        const body: string[] = [];
        if (flatIndex === 0 || printedTs || printedKey !== null) {
            const isFirst = flatIndex === 0;
            const attrs = ['<attributes>'];
            if (isFirst) {
                attrs.push(`<divisions>${DIVISIONS}</divisions>`);
            }
            if (isFirst || printedKey !== null) {
                attrs.push(`<key><fifths>${keyFifths}</fifths></key>`);
            }
            if (isFirst || printedTs) {
                attrs.push(`<time><beats>${ts.beats}</beats><beat-type>${ts.beatType}</beat-type></time>`);
            }
            if (isFirst) {
                attrs.push('<staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>');
            }
            attrs.push('</attributes>');
            body.push(attrs.join(''));
        }
        if (typeof m.tempo === 'number' && m.tempo >= 20 && m.tempo <= 400) {
            body.push(
                `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(m.tempo)}</per-minute></metronome></direction-type><staff>1</staff><sound tempo="${Math.round(m.tempo)}"/></direction>`,
            );
        }
        const dyn = m.dyn?.trim().toLowerCase();
        if (dyn && DYNAMICS.has(dyn)) {
            body.push(`<direction placement="below"><direction-type><dynamics><${dyn}/></dynamics></direction-type><staff>1</staff></direction>`);
        }

        // A lone rest means "whole bar" whatever its written value, so it says
        // nothing about the bar's real length; only played voices decide whether
        // the opening bar is an anacrusis.
        const isFirst = flatIndex === 0;
        const played = [...rh, ...lh].filter((v) => !isSoleRest(v)).map((v) => v.ticks);
        const contentTicks = played.length > 0 ? Math.max(...played) : expectedTicks;
        const pickup = isFirst && contentTicks > 0 && contentTicks < expectedTicks && played.every((t) => t <= contentTicks);
        const barTicks = pickup ? contentTicks : expectedTicks;

        // Voices: upper staff 1..k, lower staff 5..; <backup> after each voice
        // so every voice starts at the barline, as the parser expects.
        const voiceTicks = { rh: [] as number[], lh: [] as number[] };
        const emitStaff = (voices: ParsedVoice[], staff: 1 | 2, key: 'rh' | 'lh') => {
            const list = voices.length > 0 ? voices : [{ events: [{ grace: false, pitches: null, ticks: barTicks, type: 'whole', dots: 0, tuplet: null, tie: false, raw: 'r' }], ticks: barTicks, errors: [] }];
            list.forEach((parsed, i) => {
                const voiceNo = (staff === 1 ? 1 : 5) + i;
                const { xml, ticks } = voiceXml(parsed, voiceNo, staff, barTicks);
                body.push(xml);
                voiceTicks[key].push(ticks);
                if (ticks > 0) {
                    body.push(`<backup><duration>${ticks}</duration></backup>`);
                }
            });
        };
        emitStaff(rh, 1, 'rh');
        emitStaff(lh, 2, 'lh');
        // Leave the cursor at the bar's end so an underfull voice does not drag
        // the timeline: <forward> to the longest voice.
        const longest = Math.max(0, ...voiceTicks.rh, ...voiceTicks.lh);
        if (longest > 0) {
            body.push(`<forward><duration>${longest}</duration></forward>`);
        }

        const ending = typeof m.ending === 'number' && m.ending > 0 ? m.ending : null;
        const nextEnding = flat[flatIndex + 1]?.m.ending ?? null;
        const left = barlineXml(
            'left',
            m.rep === 'start' || m.rep === 'both' ? 'forward' : null,
            ending !== null && ending !== prevEnding ? { number: ending, type: 'start' } : null,
        );
        const right = barlineXml(
            'right',
            m.rep === 'end' || m.rep === 'both' ? 'backward' : null,
            ending !== null && nextEnding !== ending ? { number: ending, type: 'stop' } : null,
        );
        prevEnding = ending;

        const filled = [...voiceTicks.rh, ...voiceTicks.lh];
        const overfull = filled.some((t) => t > expectedTicks);
        const underfull = filled.some((t) => t > 0 && t < barTicks);
        // An anacrusis is MusicXML measure 0.
        const number = pickup ? 0 : index + 1;
        if (!pickup) {
            index += 1;
        }
        measuresXml.push(`<measure number="${number}"${pickup ? ' implicit="yes"' : ''}>${left}${body.join('')}${right}</measure>`);
        stats.measures.push({
            page,
            system,
            index: flatIndex,
            expectedTicks,
            rh: voiceTicks.rh,
            lh: voiceTicks.lh,
            parseErrors,
            overfull,
            underfull,
        });
    }

    pages.forEach((page, p) => {
        const mine = stats.measures.filter((s) => s.page === p);
        stats.pages.push({
            page: p,
            measures: mine.length,
            bad: mine.filter((s) => s.overfull || s.underfull || s.parseErrors > 0).length,
            parseErrors: mine.reduce((n, s) => n + s.parseErrors, 0),
            systems: page.systems.length,
        });
    });

    const xml =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<score-partwise version="4.0"><identification><encoding><software>cleffy-llm-notes</software></encoding></identification>` +
        `<part-list><score-part id="P1"><part-name>${esc('Piano')}</part-name></score-part></part-list>` +
        `<part id="P1">${measuresXml.join('')}</part></score-partwise>`;
    return { xml, stats };
};
