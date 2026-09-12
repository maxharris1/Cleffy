import { inferAutoPedal } from './autoPedal.js';
import { capHolds, capPedals, capTempoEvents } from './caps.js';
import { DEFAULT_ERA, type Era } from './era.js';
import { ERROR_CODES, JobError } from './errors.js';
import type { MusicalScore } from './musicxml.js';
import type { OmrGeometry } from './omrGeometry.js';
import { planRepeats, resolveJump, unrollRepeats } from './repeats.js';
import { SCORE_DATA_WRITE_VERSION, TICKS_PER_QUARTER, scoreDataSchema } from './scoreData.js';
import type { ScoreData, ScoreMeasure, ScoreNote, ScoreSystem } from './scoreData.js';

/**
 * Disclosures about structure, decided here and nowhere else. The parser records
 * what is engraved; only at this point are the marks paired with real measures
 * and a plan either resolved or refused, so anything a caller arrived with is
 * discarded rather than trusted.
 */
const STRUCTURE_WARNINGS = ['repeats_unrolled', 'repeats_ignored', 'jumps_performed', 'jumps_ignored'];

const SWING_SHIFT = 80;
const EIGHTH_MIN = 200;
const EIGHTH_MAX = 240;

/**
 * Long–short eighths, as a heading of "swing" asks for. Off-beat eighths
 * delay by a 16th-note's worth of ticks; the on-beat eighth in the same hand
 * grows to meet them. Sixteenths, triplets and anything longer stay even.
 */
const applySwing = (notes: ScoreNote[]): ScoreNote[] => {
    const out = notes.map((n) => ({ ...n }));
    const grown = new Set<number>();
    for (let i = 0; i < out.length; i++) {
        const n = out[i];
        if (!n || n.t % TICKS_PER_QUARTER !== 240 || n.d < EIGHTH_MIN || n.d > EIGHTH_MAX) {
            continue;
        }
        const origT = n.t;
        n.t += SWING_SHIFT;
        n.d -= SWING_SHIFT;
        const onBeatT = origT - 240;
        // Notes are sorted by tick, so the partner sits just behind this off-beat.
        for (let j = i - 1; j >= 0; j--) {
            const on = out[j];
            if (!on || on.t < onBeatT) {
                break;
            }
            if (grown.has(j) || on.h !== n.h || on.t !== onBeatT || on.d < EIGHTH_MIN || on.d > EIGHTH_MAX) {
                continue;
            }
            on.d += SWING_SHIFT;
            grown.add(j);
            break;
        }
    }
    return out;
};

type Stack = { page: number; sys: number; x0: number; x1: number; slots: Array<{ x: number; t: number }> };
type MusicalMeasure = { n: number; tick: number; dTicks: number; sysBreak?: boolean };

const slotsOf = (group: readonly Stack[], dTicks: number): Array<{ x: number; t: number }> => {
    let offset = 0;
    const out: Array<{ x: number; t: number }> = [];
    for (const stack of group) {
        for (const slot of stack.slots) {
            const t = slot.t + offset;
            if (t < dTicks) {
                out.push({ x: slot.x, t });
            }
        }
        const last = stack.slots[stack.slots.length - 1];
        if (last) {
            offset += last.t;
        }
    }
    return out;
};

const measureFromStacks = (measure: MusicalMeasure, index: number, group: readonly Stack[]): ScoreMeasure => {
    const first = group[0];
    const last = group[group.length - 1] ?? first;
    const slots = group.length > 0 ? slotsOf(group, measure.dTicks) : [];
    return {
        n: measure.n,
        tick: measure.tick,
        dTicks: measure.dTicks,
        srcIndex: index,
        page: first ? first.page : -1,
        sys: first ? first.sys : -1,
        x0: first ? first.x0 : 0,
        x1: last ? last.x1 : 0,
        ...(slots.length > 0 ? { sl: slots } : {}),
    };
};

/**
 * Zip stacks to measures system-by-system. A merged bar (fewer measures than
 * stacks in that system) spans the leftover stacks so a mismatch on page 2
 * does not shift the playhead for the rest of the piece.
 */
const zipMeasuresToStacks = (
    musicalMeasures: readonly MusicalMeasure[],
    stacks: readonly Stack[],
    warnings: Set<string>,
): ScoreMeasure[] => {
    const laterBreak = musicalMeasures.some((measure, i) => i > 0 && measure.sysBreak);
    if (!laterBreak) {
        if (stacks.length > 0 && stacks.length !== musicalMeasures.length) {
            warnings.add('measure_geometry_mismatch');
        }
        return musicalMeasures.map((measure, index) =>
            measureFromStacks(measure, index, stacks[index] ? [stacks[index]!] : []),
        );
    }
    const stackSystems: Stack[][] = [];
    for (const stack of stacks) {
        const prev = stackSystems[stackSystems.length - 1];
        if (prev?.[0] && prev[0].page === stack.page && prev[0].sys === stack.sys) {
            prev.push(stack);
        } else {
            stackSystems.push([stack]);
        }
    }
    const measureSystems: Array<{ measure: MusicalMeasure; index: number }[]> = [];
    let current: Array<{ measure: MusicalMeasure; index: number }> = [];
    for (const [index, measure] of musicalMeasures.entries()) {
        if (measure.sysBreak && current.length > 0) {
            measureSystems.push(current);
            current = [];
        }
        current.push({ measure, index });
    }
    if (current.length > 0) {
        measureSystems.push(current);
    }

    const out: ScoreMeasure[] = [];
    const n = Math.max(measureSystems.length, stackSystems.length);
    for (let s = 0; s < n; s++) {
        const mGroup = measureSystems[s] ?? [];
        const sGroup = stackSystems[s] ?? [];
        if (sGroup.length !== mGroup.length && (sGroup.length > 0 || mGroup.length > 0) && stacks.length > 0) {
            warnings.add('measure_geometry_mismatch');
        }
        if (mGroup.length === 0) {
            continue;
        }
        if (sGroup.length === mGroup.length) {
            for (let i = 0; i < mGroup.length; i++) {
                const entry = mGroup[i]!;
                out.push(measureFromStacks(entry.measure, entry.index, sGroup[i] ? [sGroup[i]!] : []));
            }
            continue;
        }
        if (sGroup.length > mGroup.length) {
            // Merged bar: the last measure spans the leftover stacks.
            for (let i = 0; i < mGroup.length; i++) {
                const entry = mGroup[i]!;
                const group = i < mGroup.length - 1 ? (sGroup[i] ? [sGroup[i]!] : []) : sGroup.slice(i);
                out.push(measureFromStacks(entry.measure, entry.index, group));
            }
            continue;
        }
        // More measures than stacks: extras get no geometry.
        for (let i = 0; i < mGroup.length; i++) {
            const entry = mGroup[i]!;
            out.push(measureFromStacks(entry.measure, entry.index, sGroup[i] ? [sGroup[i]!] : []));
        }
    }
    return out;
};

/**
 * Zip musical content (MusicXML) with measure geometry (.omr) into the final
 * ScoreData. Both come from the same Audiveris engine model, so geometric
 * measure stacks in reading order should match exported measures 1:1; when
 * they don't, the tail degrades to geometry-less measures (audio still plays,
 * the playhead hides there) rather than risking wrong positions.
 */
export interface BuildScoreDataOptions {
    /** Stylistic era, which decides how an unpedalled score is pedalled. */
    era?: Era;
    /**
     * Whether to pedal an unmarked stretch here. Off for a shard of a split
     * score: a shard sees only its own pages, so it cannot tell a score that
     * never pedals from one whose marks are all on another page, and the
     * merge infers once over the whole score instead. Default on.
     */
    autoPedal?: boolean;
}

export const buildScoreData = (
    musical: MusicalScore,
    geometry: OmrGeometry | null,
    options: BuildScoreDataOptions = {},
): ScoreData => {
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
                    stacks.push({
                        page: sheet.pageIndex,
                        sys: sysIndex,
                        x0: stack.x0,
                        x1: stack.x1,
                        slots: stack.slots,
                    });
                }
            }
        }
    } else {
        warnings.add('no_geometry');
    }

    const measures: ScoreMeasure[] = zipMeasuresToStacks(musical.measures, stacks, warnings);

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
    // A degraded plan is never performed, so its flags describe a performance
    // that does not happen — they cannot be read without this filter.
    const performing = plan && !plan.degraded ? plan : null;
    const performsRepeats = performing?.performsRepeats ?? false;
    const performsJumps = performing?.performsJumps ?? false;
    const structureLost = performing === null;

    // Each disclosure is keyed to what the reader would MISS, not to what was
    // printed: a `:|` that was never retaken, or a D.C./D.S. that was never
    // taken. A lone forward `|:` is performed identically by a linear read, so
    // it costs the reader nothing and earns no warning — claiming otherwise was
    // the old false positive, and it fired on ordinary unrepeated scores.
    for (const code of STRUCTURE_WARNINGS) {
        warnings.delete(code);
    }
    if (performsRepeats) {
        warnings.add('repeats_unrolled');
    }
    if (performsJumps) {
        warnings.add('jumps_performed');
    }
    if (structureLost && marks.some((mark) => mark.repeatBackward)) {
        warnings.add('repeats_ignored');
    }
    // A segno or Fine with no instruction to send the player back to it is
    // decoration, and `resolveJump` says so by returning null; only a real
    // D.C./D.S. that went unperformed is worth a reader's attention.
    if (!performsJumps && resolveJump(marks) !== null) {
        warnings.add('jumps_ignored');
    }

    const linearScore = {
        timeSignatures: musical.timeSignatures,
        ...((musical.keySignatures?.length ?? 0) > 0 ? { keySignatures: musical.keySignatures } : {}),
        ...((musical.clefs?.length ?? 0) > 0 ? { clefs: musical.clefs } : {}),
        ...((musical.tempos?.length ?? 0) > 0 ? { tempos: musical.tempos } : {}),
        ...((musical.holds?.length ?? 0) > 0 ? { holds: musical.holds } : {}),
        ...((musical.pedals?.length ?? 0) > 0 ? { pedals: musical.pedals } : {}),
        notes: musical.notes,
        measures,
        totalTicks: Math.max(1, musical.totalTicks),
    };
    if (musical.swing) {
        linearScore.notes = applySwing(linearScore.notes);
        warnings.add('swing_applied');
    }
    const performed =
        performing && (performsRepeats || performsJumps) ? unrollRepeats(linearScore, performing.order) : linearScore;

    // Unrolling clones every event it sweeps, so a repeat-heavy score can breach
    // ceilings the printed page came nowhere near — and a breach fails the
    // self-check below, throwing away a score that is otherwise perfectly good.
    const tempos = performed.tempos ? capTempoEvents(performed.tempos) : undefined;
    const holds = performed.holds ? capHolds(performed.holds) : undefined;

    // Where the engraving does not pedal, play it the way its era would. On
    // the performed timeline so a repeated passage is pedalled both times, and
    // before the cap so the inference can coarsen itself to fit under it.
    const pedalling =
        options.autoPedal === false
            ? { pedals: performed.pedals ?? [], inferred: false }
            : inferAutoPedal(
                  {
                      notes: performed.notes,
                      measures: performed.measures,
                      timeSignatures: performed.timeSignatures,
                      pedals: performed.pedals ?? [],
                      totalTicks: performed.totalTicks,
                  },
                  options.era ?? DEFAULT_ERA,
              );
    const pedals = pedalling.pedals.length > 0 ? capPedals(pedalling.pedals) : undefined;
    // Disclosed from what survives the cap, so the warning never outlives the
    // edges it describes.
    if (pedals?.some((edge) => edge.src === 'inferred')) {
        warnings.add('pedal_inferred');
    }

    const candidate: ScoreData = {
        version: SCORE_DATA_WRITE_VERSION,
        ticksPerQuarter: TICKS_PER_QUARTER,
        defaultBpm: musical.defaultBpm,
        timeSignatures: performed.timeSignatures,
        ...(performed.keySignatures ? { keySignatures: performed.keySignatures } : {}),
        ...(performed.clefs ? { clefs: performed.clefs } : {}),
        ...(tempos ? { tempos } : {}),
        ...(holds ? { holds } : {}),
        ...(pedals && pedals.length > 0 ? { pedals } : {}),
        era: options.era ?? DEFAULT_ERA,
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
