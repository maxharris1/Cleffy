import { barTicks, clickBeatTicks, measureIndexAtTick, movementEnds, timeSigAt } from '@/features/playback/scoreTime';
import type { TempoCurvePoint } from '@/features/playback/scoreTime';
import { analyzeVoices } from '@/features/playback/voiceAnalysis';
import type { VoiceAnalysis } from '@/features/playback/voiceAnalysis';
import type { ScoreData } from '@/types/scoreData';

/**
 * The expressive tempo style: the small liberties a player takes with the
 * printed tempo, as a step-wise multiplier the tempo map lays over it. All of
 * it is a pure function of the score, so the click, the count-in, the
 * playhead and a loop wrap all read the same clock as the notes.
 *
 * The magnitudes are uncalibrated; ASAP-style performance data could set them.
 */

/** Where an unmarked close arrives, relative to the tempo in force. */
export const EXPRESSIVE_FINAL_RIT_FACTOR = 0.75;
/** Bars the final ritardando spans; longer pieces get twice as many. */
export const FINAL_RIT_BARS = 2;
export const FINAL_RIT_BARS_LONG = 4;
/** A piece at least this many bars long takes the longer ritardando. */
export const LONG_PIECE_BARS = 64;
/** Broadening on the beat before a section boundary. */
export const SECTION_BROADENING_FACTOR = 0.92;
/** Time taken on the first downbeat of a phrase that follows a rest. */
export const PHRASE_AGOGIC_FACTOR = 0.96;

interface Span {
    from: number;
    to: number;
    factor: number;
}

/**
 * Seams where the performed timeline jumps back in the engraving — a repeat
 * or a D.C./D.S. — read from `srcIndex` going non-monotonic.
 */
const jumpSeams = (score: ScoreData): number[] => {
    const seams: number[] = [];
    const measures = score.measures;
    for (let i = 1; i < measures.length; i++) {
        const curr = measures[i];
        const prev = measures[i - 1];
        if (!curr || !prev) {
            continue;
        }
        if ((curr.srcIndex ?? i) < (prev.srcIndex ?? i - 1)) {
            seams.push(curr.tick);
        }
    }
    return seams;
};

/**
 * Final ritardando: the last bars of each movement ease linearly, beat by
 * beat, from the tempo in force down to {@link EXPRESSIVE_FINAL_RIT_FACTOR}
 * on the last beat. A printed rit. anywhere in the span already does this
 * job, and so does a fermata in the last bar.
 */
const finalRitSpans = (score: ScoreData): Span[] => {
    const spans: Span[] = [];
    const tempos = score.tempos ?? [];
    const holds = score.holds ?? [];
    const barsToSpan = score.measures.length >= LONG_PIECE_BARS ? FINAL_RIT_BARS_LONG : FINAL_RIT_BARS;

    for (const end of movementEnds(score)) {
        const prior = score.measures.filter((measure) => measure.tick < end);
        const window = prior.slice(-barsToSpan);
        const first = window[0];
        const last = window[window.length - 1];
        if (!first || !last) {
            continue;
        }
        if (tempos.some((tempo) => tempo.src === 'ramp' && tempo.tick >= first.tick && tempo.tick < end)) {
            continue;
        }
        if (holds.some((hold) => hold.tick >= last.tick && hold.tick < end)) {
            continue;
        }
        const beats: number[] = [];
        for (const measure of window) {
            const beat = clickBeatTicks(timeSigAt(score.timeSignatures, measure.tick));
            for (let tick = measure.tick; tick < measure.tick + measure.dTicks; tick += beat) {
                beats.push(tick);
            }
        }
        if (beats.length < 2) {
            continue;
        }
        const denom = beats.length - 1;
        beats.forEach((tick, i) => {
            const next = beats[i + 1] ?? end;
            spans.push({ from: tick, to: next, factor: 1 + (EXPRESSIVE_FINAL_RIT_FACTOR - 1) * (i / denom) });
        });
    }
    return spans;
};

/**
 * Section broadening: the beat before a movement end, a repeat or jump seam,
 * a fermata, and the score's end. Barline styles are not in ScoreData; these
 * are the boundaries it does carry.
 */
const broadeningSpans = (score: ScoreData): Span[] => {
    const boundaries = new Set<number>([...movementEnds(score), ...jumpSeams(score), score.totalTicks]);
    for (const hold of score.holds ?? []) {
        // A hold engraved past the last note (a final-barline fermata) has no beat before it to broaden.
        if (hold.tick < score.totalTicks) {
            boundaries.add(hold.tick);
        }
    }
    const spans: Span[] = [];
    for (const boundary of boundaries) {
        if (boundary <= 0) {
            continue;
        }
        const beat = clickBeatTicks(timeSigAt(score.timeSignatures, Math.max(0, boundary - 1)));
        spans.push({ from: Math.max(0, boundary - beat), to: boundary, factor: SECTION_BROADENING_FACTOR });
    }
    return spans;
};

/**
 * Phrase-initial agogic: a little time on the first downbeat of a melody-voice
 * phrase that follows a rest — the breath before the line starts again.
 */
const agogicSpans = (score: ScoreData, analysis: VoiceAnalysis): Span[] => {
    const spans: Span[] = [];
    const notes = score.notes;
    let firstOnset = Number.POSITIVE_INFINITY;
    for (const note of notes) {
        firstOnset = Math.min(firstOnset, note.t);
    }
    for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        if (!note || !analysis.phraseStart[i] || note.t === firstOnset) {
            continue;
        }
        const bar = measureIndexAtTick(score.measures, note.t);
        const measure = score.measures[bar];
        if (!measure || measure.tick !== note.t || analysis.melodyVoiceByBar[bar] !== analysis.voiceOf[i]) {
            continue;
        }
        const sig = timeSigAt(score.timeSignatures, note.t);
        if (measure.dTicks < barTicks(sig)) {
            continue; // a pickup is not a downbeat
        }
        const beat = clickBeatTicks(sig);
        spans.push({
            from: note.t,
            to: Math.min(note.t + beat, measure.tick + measure.dTicks),
            factor: PHRASE_AGOGIC_FACTOR,
        });
    }
    return spans;
};

/**
 * Flatten overlapping spans into step points: where spans overlap the slowest
 * wins, and consecutive equal factors merge. Points come back tick-sorted with
 * every non-unity stretch closed by a return to 1.
 */
const flatten = (spans: readonly Span[]): TempoCurvePoint[] => {
    const cuts = new Set<number>();
    for (const span of spans) {
        if (span.to > span.from) {
            cuts.add(span.from);
            cuts.add(span.to);
        }
    }
    const ticks = [...cuts].sort((a, b) => a - b);
    const points: TempoCurvePoint[] = [];
    let last = 1;
    for (let i = 0; i < ticks.length; i++) {
        const tick = ticks[i] ?? 0;
        const next = ticks[i + 1];
        let factor = 1;
        if (next !== undefined) {
            for (const span of spans) {
                if (span.from <= tick && span.to >= next) {
                    factor = Math.min(factor, span.factor);
                }
            }
        }
        if (factor !== last) {
            points.push({ tick, factor });
            last = factor;
        }
    }
    return points;
};

/** The expressive style's tempo curve for a score. Empty when nothing applies. */
export const expressiveTempoCurve = (
    score: ScoreData,
    analysis: VoiceAnalysis = analyzeVoices(score),
): TempoCurvePoint[] => {
    const rit = finalRitSpans(score);
    // Broadening inside a ritardando would double up on it: the rit already slows there.
    const broadening = broadeningSpans(score).filter(
        (span) => !rit.some((r) => span.from >= r.from && span.from < r.to),
    );
    return flatten([...rit, ...broadening, ...agogicSpans(score, analysis)]);
};
