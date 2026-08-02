import { ERROR_CODES, JobError } from './errors.js';
import type { MusicalScore } from './musicxml.js';
import type { OmrGeometry } from './omrGeometry.js';
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
    const slots: Array<{ page: number; sys: number; x0: number; x1: number }> = [];

    if (geometry) {
        for (const sheet of geometry.sheets) {
            for (const system of sheet.systems) {
                const sysIndex = systems.length;
                systems.push({ page: sheet.pageIndex, y0: system.y0, y1: system.y1 });
                for (const stack of system.stacks) {
                    slots.push({ page: sheet.pageIndex, sys: sysIndex, x0: stack.x0, x1: stack.x1 });
                }
            }
        }
    } else {
        warnings.add('no_geometry');
    }

    if (geometry && slots.length !== musical.measures.length) {
        warnings.add('measure_geometry_mismatch');
    }

    const measures: ScoreMeasure[] = musical.measures.map((measure, index) => {
        const slot = slots[index];
        return {
            n: measure.n,
            tick: measure.tick,
            dTicks: measure.dTicks,
            page: slot ? slot.page : -1,
            sys: slot ? slot.sys : -1,
            x0: slot ? slot.x0 : 0,
            x1: slot ? slot.x1 : 0,
        };
    });

    const candidate: ScoreData = {
        version: SCORE_DATA_VERSION,
        ticksPerQuarter: TICKS_PER_QUARTER,
        defaultBpm: musical.defaultBpm,
        timeSignatures: musical.timeSignatures,
        totalTicks: Math.max(1, musical.totalTicks),
        notes: musical.notes,
        measures,
        systems,
        warnings: [...warnings],
    };

    const checked = scoreDataSchema.safeParse(candidate);
    if (!checked.success) {
        throw new JobError(ERROR_CODES.internal, `ScoreData failed self-check: ${checked.error.issues[0]?.message}`);
    }
    return checked.data;
};
