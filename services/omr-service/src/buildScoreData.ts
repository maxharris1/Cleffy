import { ERROR_CODES, JobError } from './errors.js';
import type { MusicalScore } from './musicxml.js';
import type { OmrGeometry } from './omrGeometry.js';
import { planRepeats, unrollRepeats } from './repeats.js';
import { SCORE_DATA_VERSION, TICKS_PER_QUARTER, scoreDataSchema } from './scoreData.js';
import type { ScoreData, ScoreMeasure, ScoreSystem } from './scoreData.js';

/**
 * Zip musical content (MusicXML) with measure geometry (.omr) into the final
 * ScoreData. Both come from the same Audiveris engine model, so geometric
 * measure stacks in reading order should match exported measures 1:1; when
 * they don't, the tail degrades to geometry-less measures (audio still plays,
 * the playhead hides there) rather than risking wrong positions.
 */
export const buildScoreData = (musical: MusicalScore, geometry: OmrGeometry | null): ScoreData => {
    if (musical.notes.length === 0 || musical.measures.length === 0) {
        throw new JobError(ERROR_CODES.noStavesFound, 'No playable notes recognized');
    }

    const warnings = new Set(musical.warnings);
    const systems: ScoreSystem[] = [];
    const stacks: Array<{ page: number; sys: number; x0: number; x1: number; slots: Array<{ x: number; t: number }> }> =
        [];

    if (geometry) {
        for (const sheet of geometry.sheets) {
            for (const system of sheet.systems) {
                const sysIndex = systems.length;
                systems.push({
                    page: sheet.pageIndex,
                    y0: system.y0,
                    y1: system.y1,
                    ...((system.staves?.length ?? 0) > 0 ? { staves: system.staves } : {}),
                });
                for (const stack of system.stacks) {
                    stacks.push({ page: sheet.pageIndex, sys: sysIndex, x0: stack.x0, x1: stack.x1, slots: stack.slots });
                }
            }
        }
    } else {
        warnings.add('no_geometry');
    }

    if (geometry && stacks.length !== musical.measures.length) {
        warnings.add('measure_geometry_mismatch');
    }

    const measures: ScoreMeasure[] = musical.measures.map((measure, index) => {
        const stack = stacks[index];
        // Chord columns must fit inside the measure's own timeline — an OMR
        // rhythm misread otherwise drags the playhead outside the bar.
        const slots = stack ? stack.slots.filter((slot) => slot.t < measure.dTicks) : [];
        return {
            n: measure.n,
            tick: measure.tick,
            dTicks: measure.dTicks,
            // Identity of the engraved bar. Trivially the index today; once
            // repeats are unrolled, several entries will share one.
            srcIndex: index,
            page: stack ? stack.page : -1,
            sys: stack ? stack.sys : -1,
            x0: stack ? stack.x0 : 0,
            x1: stack ? stack.x1 : 0,
            ...(slots.length > 0 ? { sl: slots } : {}),
        };
    });

    // Unroll AFTER the geometry zip: both the secondary-part timeline and the
    // stacks-to-measures pairing above are positional, so duplicating measures
    // any earlier would break them. Here a repeat is a structural clone that
    // keeps its page position, which is why the playhead sweeps the same
    // printed bar twice for nothing.
    const MAX_MEASURES = 2_000;
    const marks = musical.repeats ?? [];
    // Only act on marks that line up with the measures one-for-one; anything
    // else means a caller built the score without them, and an empty plan must
    // never be mistaken for "perform nothing".
    const plan =
        marks.length === measures.length
            ? planRepeats(marks, { maxMeasures: MAX_MEASURES }, (i) => musical.measures[i]?.n === 0)
            : null;
    const performsRepeats = plan !== null && !plan.degraded && plan.order.length > measures.length;
    if (performsRepeats) {
        warnings.delete('repeats_ignored');
        warnings.add('repeats_unrolled');
    }

    const linearScore = {
        timeSignatures: musical.timeSignatures,
        ...((musical.keySignatures?.length ?? 0) > 0 ? { keySignatures: musical.keySignatures } : {}),
        ...((musical.clefs?.length ?? 0) > 0 ? { clefs: musical.clefs } : {}),
        ...((musical.tempos?.length ?? 0) > 0 ? { tempos: musical.tempos } : {}),
        ...((musical.holds?.length ?? 0) > 0 ? { holds: musical.holds } : {}),
        notes: musical.notes,
        measures,
        totalTicks: Math.max(1, musical.totalTicks),
    };
    const performed = performsRepeats && plan ? unrollRepeats(linearScore, plan.order) : linearScore;

    const candidate: ScoreData = {
        version: SCORE_DATA_VERSION,
        ticksPerQuarter: TICKS_PER_QUARTER,
        defaultBpm: musical.defaultBpm,
        timeSignatures: performed.timeSignatures,
        ...(performed.keySignatures ? { keySignatures: performed.keySignatures } : {}),
        ...(performed.clefs ? { clefs: performed.clefs } : {}),
        ...(performed.tempos ? { tempos: performed.tempos } : {}),
        ...(performed.holds ? { holds: performed.holds } : {}),
        totalTicks: performed.totalTicks,
        notes: performed.notes,
        measures: performed.measures,
        systems,
        warnings: [...warnings],
    };

    const checked = scoreDataSchema.safeParse(candidate);
    if (!checked.success) {
        throw new JobError(ERROR_CODES.internal, `ScoreData failed self-check: ${checked.error.issues[0]?.message}`);
    }
    return checked.data;
};
