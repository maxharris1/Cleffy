import { clickBeatTicks, measureIndexAtTick, timeSigAt } from '@/features/playback/scoreTime';
import { HAND_RH, MAX_VOICE_SLOT } from '@/types/scoreData';
import type { ScoreData, ScoreNote } from '@/types/scoreData';

/**
 * What the score's voices are doing, decided once from the score alone.
 *
 * ScoreData v5 names each note's voice slot (`vc`, per staff); this pass turns
 * those names into the facts expression and tempo shaping need: who follows
 * whom within a line, which line is the tune in each bar, which lines are
 * repeating a figure under it, and where a line starts a phrase after a rest.
 * Everything here is a pure function of the score — like the note shapes and
 * the jitter, it must survive a seek or a loop wrap without changing its mind.
 *
 * Scores older than v5 carry no `vc`: every note is then slot 0 of its hand,
 * which reduces the voice model to "one voice per hand" and lets the older
 * rules fall out of the same code.
 */

/** Bars a melody decision looks ahead across (plus the bar before). */
export const MELODY_WINDOW_BARS = 8;
/**
 * `d / (next onset − onset)` at or above which a note runs straight into the
 * next of its voice: plain notes are gated to 0.9 and legato ones to 1.0, so
 * anything here is adjacent and singable; portato (0.7) and staccato (0.5),
 * or a rest in between, fall under it.
 */
export const LEGATO_RATIO_MIN = 0.85;
/** Share of a bar's intervals that must recur for the bar to be "the same figure again". */
export const FIGURE_INTERVAL_MATCH = 0.7;
/** A rest at least this fraction of the note's own length, and at least a beat, ends a phrase. */
const PHRASE_GAP_FRACTION = 0.15;

const SLOTS_PER_HAND = MAX_VOICE_SLOT + 1;

/** One small integer per (hand, slot), so voices can key maps and arrays. */
export const voiceKey = (note: ScoreNote): number => note.h * SLOTS_PER_HAND + (note.vc ?? 0);

/** Hand a voice key belongs to. */
export const handOfVoice = (key: number): 0 | 1 => (key >= SLOTS_PER_HAND ? 1 : 0);

export interface VoiceAnalysis {
    /** Voice key per note (see {@link voiceKey}). */
    readonly voiceOf: readonly number[];
    /** Index of the next note in the same voice that starts later, or -1. */
    readonly nextInVoice: readonly number[];
    /** Per measure index: the melody voice's key, or -1 when nothing sounds in or around the bar. */
    readonly melodyVoiceByBar: readonly number[];
    /** Per note: the note runs legato into {@link nextInVoice}. */
    readonly legato: readonly boolean[];
    /** Per note: the note belongs to a bar-long figure repeated from the previous bar, under another voice. */
    readonly accompaniment: readonly boolean[];
    /** Per note: the first note of its voice after a phrase-ending rest (or the voice's very first). */
    readonly phraseStart: readonly boolean[];
}

interface VoiceBarStats {
    /** Onset ticks relative to the bar, unique, ascending. */
    onsets: number[];
    /** Pitch at each onset (the highest of a chord), in onset order. */
    pitches: number[];
    /** Σ duration over notes. */
    ticks: number;
    /** Σ duration over notes that move by a step from the previous onset. */
    stepwiseTicks: number;
    /** Σ pitch · duration. */
    pitchTicks: number;
    /** Onsets at which the voice held the highest sounding note of its hand. */
    topOnsets: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Score a voice's claim to the tune over a window: duration-weighted stepwise
 * motion (melodies walk, accompaniments leap or repeat), pitch height, and how
 * often it is the top of its own hand. The weights are uncalibrated; ASAP-style
 * performance data could set them.
 */
const melodyScore = (stats: readonly VoiceBarStats[]): number => {
    let ticks = 0;
    let stepwise = 0;
    let pitchTicks = 0;
    let onsets = 0;
    let top = 0;
    for (const bar of stats) {
        ticks += bar.ticks;
        stepwise += bar.stepwiseTicks;
        pitchTicks += bar.pitchTicks;
        onsets += bar.onsets.length;
        top += bar.topOnsets;
    }
    if (ticks === 0) {
        return -1;
    }
    const stepShare = stepwise / ticks;
    const height = clamp01((pitchTicks / ticks - 36) / 48);
    const topShare = onsets > 0 ? top / onsets : 0;
    return 0.4 * stepShare + 0.35 * height + 0.25 * topShare;
};

/** Onset pattern identical and enough intervals the same: the figure came round again. */
const repeatsFigure = (prev: VoiceBarStats | undefined, curr: VoiceBarStats): boolean => {
    if (!prev || curr.onsets.length < 2 || prev.onsets.length !== curr.onsets.length) {
        return false;
    }
    for (let i = 0; i < curr.onsets.length; i++) {
        if (prev.onsets[i] !== curr.onsets[i]) {
            return false;
        }
    }
    const intervals = curr.pitches.length - 1;
    if (intervals < 1) {
        return false;
    }
    let same = 0;
    for (let i = 1; i < curr.pitches.length; i++) {
        const a = (curr.pitches[i] ?? 0) - (curr.pitches[i - 1] ?? 0);
        const b = (prev.pitches[i] ?? 0) - (prev.pitches[i - 1] ?? 0);
        if (a === b) {
            same += 1;
        }
    }
    return same / intervals >= FIGURE_INTERVAL_MATCH;
};

export const analyzeVoices = (score: ScoreData): VoiceAnalysis => {
    const notes = score.notes;
    const measures = score.measures;
    const count = notes.length;
    const voiceOf = notes.map(voiceKey);
    const nextInVoice = new Array<number>(count).fill(-1);
    const legato = new Array<boolean>(count).fill(false);
    const accompaniment = new Array<boolean>(count).fill(false);
    const phraseStart = new Array<boolean>(count).fill(false);
    const barOf = notes.map((note) => measureIndexAtTick(measures, note.t));

    // Successor within the voice: notes are tick-sorted, so a backward walk
    // with one "latest onset seen" per voice finds it in one pass. Chord
    // members share an onset and so share a successor.
    const laterGroup = new Map<number, { tick: number; index: number }>();
    const currentGroup = new Map<number, { tick: number; index: number }>();
    for (let i = count - 1; i >= 0; i--) {
        const note = notes[i];
        if (!note) {
            continue;
        }
        const key = voiceOf[i] ?? 0;
        const current = currentGroup.get(key);
        if (current && current.tick !== note.t) {
            laterGroup.set(key, current);
        }
        // Walking down, the index settles on the group's first member.
        currentGroup.set(key, { tick: note.t, index: i });
        const later = laterGroup.get(key);
        if (later) {
            nextInVoice[i] = later.index;
        }
    }
    for (let i = 0; i < count; i++) {
        const note = notes[i];
        const next = nextInVoice[i] ?? -1;
        const successor = next >= 0 ? notes[next] : undefined;
        if (!note || !successor) {
            continue;
        }
        const span = successor.t - note.t;
        if (span > 0 && note.d / span >= LEGATO_RATIO_MIN) {
            legato[i] = true;
        }
    }

    // Phrase starts: the voice's first note, or one preceded by a rest of at
    // least a beat that is also a real fraction of the note before it — a long
    // tied note's articulation gap is not a rest.
    const lastEndByVoice = new Map<number, number>();
    const lastDurByVoice = new Map<number, number>();
    const lastOnsetByVoice = new Map<number, { tick: number; index: number }>();
    for (let i = 0; i < count; i++) {
        const note = notes[i];
        if (!note) {
            continue;
        }
        const key = voiceOf[i] ?? 0;
        const lastOnset = lastOnsetByVoice.get(key);
        if (lastOnset && lastOnset.tick === note.t) {
            // A chord member: the decision was made by the first note of the group.
            phraseStart[i] = phraseStart[lastOnset.index] ?? false;
        } else {
            const lastEnd = lastEndByVoice.get(key);
            if (lastEnd === undefined) {
                phraseStart[i] = true;
            } else {
                const beat = clickBeatTicks(timeSigAt(score.timeSignatures, note.t));
                const before = lastDurByVoice.get(key) ?? 0;
                phraseStart[i] = note.t - lastEnd >= Math.max(beat, PHRASE_GAP_FRACTION * before);
            }
            lastOnsetByVoice.set(key, { tick: note.t, index: i });
        }
        const end = note.t + note.d;
        if (end > (lastEndByVoice.get(key) ?? -1)) {
            lastEndByVoice.set(key, end);
            lastDurByVoice.set(key, note.d);
        }
    }

    // Per-bar, per-voice statistics, walked by onset group so "top of the hand"
    // can look at everything sounding.
    const statsByBar: Array<Map<number, VoiceBarStats>> = measures.map(() => new Map());
    const lastPitchByVoice = new Map<number, number>();
    const sounding: Array<{ index: number; note: ScoreNote }> = [];
    let start = 0;
    while (start < count) {
        const head = notes[start];
        if (!head) {
            break;
        }
        let end = start;
        while (end < count && notes[end]?.t === head.t) {
            end += 1;
        }
        const tick = head.t;
        let kept = 0;
        for (const entry of sounding) {
            if (tick < entry.note.t + entry.note.d) {
                sounding[kept] = entry;
                kept += 1;
            }
        }
        sounding.length = kept;
        for (let i = start; i < end; i++) {
            const note = notes[i];
            if (note) {
                sounding.push({ index: i, note });
            }
        }
        const topByHand: [number, number] = [-Infinity, -Infinity];
        for (const { note } of sounding) {
            const hand = note.h === HAND_RH ? 0 : 1;
            topByHand[hand] = Math.max(topByHand[hand], note.p);
        }

        // One entry per voice attacking in this group.
        const attacking = new Map<number, { top: number; ticks: number }>();
        for (let i = start; i < end; i++) {
            const note = notes[i];
            if (!note) {
                continue;
            }
            const key = voiceOf[i] ?? 0;
            const entry = attacking.get(key) ?? { top: -Infinity, ticks: 0 };
            entry.top = Math.max(entry.top, note.p);
            entry.ticks = Math.max(entry.ticks, note.d);
            attacking.set(key, entry);
        }
        const bar = barOf[start] ?? -1;
        const barStats = bar >= 0 ? statsByBar[bar] : undefined;
        const barTick = bar >= 0 ? (measures[bar]?.tick ?? 0) : 0;
        for (const [key, entry] of attacking) {
            const previous = lastPitchByVoice.get(key);
            const step =
                previous !== undefined && Math.abs(entry.top - previous) >= 1 && Math.abs(entry.top - previous) <= 2;
            lastPitchByVoice.set(key, entry.top);
            if (!barStats) {
                continue;
            }
            const stats = barStats.get(key) ?? {
                onsets: [],
                pitches: [],
                ticks: 0,
                stepwiseTicks: 0,
                pitchTicks: 0,
                topOnsets: 0,
            };
            // A chord counts once, by its top note: the line is what the ear follows.
            stats.onsets.push(tick - barTick);
            stats.pitches.push(entry.top);
            stats.ticks += entry.ticks;
            stats.pitchTicks += entry.top * entry.ticks;
            if (step) {
                stats.stepwiseTicks += entry.ticks;
            }
            if (entry.top === topByHand[handOfVoice(key)]) {
                stats.topOnsets += 1;
            }
            barStats.set(key, stats);
        }
        start = end;
    }

    // Melody voice per bar: the best-scoring voice over the window starting
    // one bar back. Every voice heard in the window is a candidate, and the
    // bar before is in it because a tune held across a barline has no onset
    // in the bar it is held through, and is still the tune there.
    const melodyVoiceByBar = measures.map((_, bar) => {
        const windowEnd = Math.min(measures.length, bar + MELODY_WINDOW_BARS);
        const perVoice = new Map<number, VoiceBarStats[]>();
        for (let b = Math.max(0, bar - 1); b < windowEnd; b++) {
            for (const [key, stats] of statsByBar[b] ?? []) {
                const list = perVoice.get(key) ?? [];
                list.push(stats);
                perVoice.set(key, list);
            }
        }
        let best = -1;
        let bestScore = -Infinity;
        let bestHeight = -Infinity;
        for (const [key, stats] of perVoice) {
            const value = melodyScore(stats);
            const height =
                stats.reduce((sum, s) => sum + s.pitchTicks, 0) /
                Math.max(
                    1,
                    stats.reduce((sum, s) => sum + s.ticks, 0),
                );
            if (
                value > bestScore ||
                (value === bestScore && (height > bestHeight || (height === bestHeight && key < best)))
            ) {
                best = key;
                bestScore = value;
                bestHeight = height;
            }
        }
        return best;
    });

    // Accompaniment: a voice repeating last bar's figure under a different melody voice.
    const accompanimentVoiceByBar = measures.map((_, bar) => {
        const current = statsByBar[bar];
        const previous = bar > 0 ? statsByBar[bar - 1] : undefined;
        const flagged = new Set<number>();
        if (!current || current.size < 2) {
            return flagged;
        }
        const melody = melodyVoiceByBar[bar] ?? -1;
        for (const [key, stats] of current) {
            if (key !== melody && repeatsFigure(previous?.get(key), stats)) {
                flagged.add(key);
            }
        }
        return flagged;
    });
    for (let i = 0; i < count; i++) {
        const bar = barOf[i] ?? -1;
        if (bar >= 0 && accompanimentVoiceByBar[bar]?.has(voiceOf[i] ?? 0)) {
            accompaniment[i] = true;
        }
    }

    return { voiceOf, nextInVoice, melodyVoiceByBar, legato, accompaniment, phraseStart };
};
