import type { EvalResult, MovementMetrics, StructureFlags } from './compare.js';

/**
 * The play-along gate: an objective stand-in for listening to a score play back
 * next to the page.
 *
 * It asks four page questions and nothing else. Are the printed notes there? Do
 * they start where the page says? Do they last as long as the page says? Does
 * the performance walk the printed bars — right count, right length, right
 * repeats, no invented pauses?
 *
 * What it deliberately does not ask: whether the playback feels musical. Induced
 * jitter, the rit. curve, chord roll, hairpin interpolation, inferred pedal,
 * voicing, sample quality and wall-clock duration are all out. None of them are
 * on the page, Strict playback already opts out of them, and a metric that mixed
 * them in would stop being reproducible. Printed tempo is computed and reported
 * (`printedTempoBpm`) but also not gated: a piece played at the wrong speed is
 * still on pitch and still on the printed grid.
 *
 * The gate is a pure function of an `EvalResult`, so it can be re-run against a
 * committed result JSON without the corpus, the MIDI or Audiveris.
 */

/**
 * One missed note per this many printed bars is forgiven. A single wrong note in
 * a busy bar is not what makes a play-along unusable, and requiring a perfect
 * pitch set would fail every real engraving on one smudged accidental. Two
 * misses in sixteen bars is a different thing, and so is a missing passage —
 * which `no-skipped-passage` catches regardless of this allowance.
 */
export const BARS_PER_ALLOWED_MISS = 16;

/**
 * Floor on `exact` (pitch + onset at 1/12 of a quarter). Attacks are the part of
 * printed rhythm that a listener hears first and that the reference states
 * exactly, so the floor is high.
 */
export const DEFAULT_EXACT_FLOOR = 95;

/**
 * Floor on `onGrid` (pitch + onset + length at 1/24 of a quarter). Five points
 * below the attack floor on purpose: a printed `\prall` or `\mordent` is
 * realised in the reference MIDI as a run of short notes no OMR reading of the
 * engraved note can match, and ties and grace notes add similar one-sided noise.
 * The gap is the allowance for the reference's own realisation, not slack for
 * the parser.
 */
export const DEFAULT_ON_GRID_FLOOR = 90;

export interface PlayAlongLimits {
    exactFloor: number;
    onGridFloor: number;
    barsPerAllowedMiss: number;
}

export const defaultLimits = (): PlayAlongLimits => ({
    exactFloor: DEFAULT_EXACT_FLOOR,
    onGridFloor: DEFAULT_ON_GRID_FLOOR,
    barsPerAllowedMiss: BARS_PER_ALLOWED_MISS,
});

export type CheckId =
    | 'reference-pin'
    | 'printed-bar-count'
    | 'bar-alignment'
    | 'bar-length'
    | 'no-invented-hold'
    | 'repeat-walk'
    | 'notes-present'
    | 'no-invented-notes'
    | 'no-skipped-passage'
    | 'attack-grid'
    | 'note-length'
    | 'movement-count'
    | 'meters'
    | 'bar-length-warning'
    | 'repeat-structure';

export interface PlayAlongCheck {
    id: CheckId;
    /** null when the corpus does not pin what this check needs. */
    ok: boolean | null;
    /** What was measured, for the failure line. */
    detail: string;
    /** The listening failure this check stands in for. */
    hears: string;
}

export interface PlayAlongMovement {
    name: string;
    refNotes: number;
    pitchMatch: number;
    exact: number;
    onGrid: number;
    allowedMisses: number;
    checks: PlayAlongCheck[];
    pass: boolean;
}

export interface PlayAlongVerdict {
    slug: string;
    title: string;
    /**
     * The headline. Share of reference notes the OMR reproduces at the same
     * pitch, the same onset and the same length — `overall.onGrid`. Monotone
     * under the other two rates by construction: onGrid <= exact <= pitchMatch.
     */
    score: number;
    pass: boolean;
    limits: PlayAlongLimits;
    movements: PlayAlongMovement[];
    pieceChecks: PlayAlongCheck[];
    /** Human-readable `movement: check (detail)` lines for every failure. */
    failures: string[];
}

const pct = (n: number): string => `${n.toFixed(1)}%`;

const structureChecks = (
    result: Pick<EvalResult, 'structure'>,
    flags: StructureFlags,
): PlayAlongCheck[] => [
    {
        id: 'movement-count',
        ok: result.structure.movementCountOk,
        detail: result.structure.movementCountOk ? 'ok' : 'time signatures disagree with the corpus',
        hears: 'the wrong movement, or two movements run together',
    },
    {
        id: 'meters',
        ok: result.structure.metersOk,
        // When a movement cannot bind a meter its tick slice is empty, so every
        // reference note reads as missing and the three rates collapse to 0%.
        // Say so here: a 0% is the CONSEQUENCE of the unbound meter, not an
        // independent claim that the engine found no notes.
        detail: result.structure.metersOk
            ? 'ok'
            : 'a movement never bound a matching meter — its rates are void, not measured',
        hears: 'the piece in the wrong meter, so nothing lands where the page says',
    },
    {
        id: 'bar-length-warning',
        ok: !flags.measureUnderfull && !flags.measureOverfull,
        detail:
            [flags.measureUnderfull ? 'measure_underfull' : '', flags.measureOverfull ? 'measure_overfull' : '']
                .filter(Boolean)
                .join(' + ') || 'none',
        // The parser pads a short non-pickup bar up to the meter, so `dTicks`
        // looks right afterwards and only this warning can still see the hole.
        hears: 'a wonky pause or rush inside a bar whose pitches are all correct',
    },
    {
        id: 'repeat-structure',
        ok: !flags.repeatsIgnored && !flags.jumpsIgnored,
        detail:
            [flags.repeatsIgnored ? 'repeats_ignored' : '', flags.jumpsIgnored ? 'jumps_ignored' : '']
                .filter(Boolean)
                .join(' + ') || 'none',
        hears: 'a repeat or D.C. the page prints but the playback never takes',
    },
];

const movementChecks = (m: MovementMetrics, allowed: number, limits: PlayAlongLimits): PlayAlongCheck[] => [
    {
        id: 'reference-pin',
        ok: m.refBarsMatch,
        detail: `reference MIDI produced ${m.refBars} bars`,
        hears: 'nothing — this one grades the corpus pin, not the OMR',
    },
    {
        id: 'printed-bar-count',
        ok: m.printedBarsMatch,
        detail: `${m.omrPrintedBars} printed bars read`,
        hears: 'a swallowed or duplicated bar on the page',
    },
    {
        id: 'bar-alignment',
        ok: m.scoredBars === m.refBars,
        detail: `${m.scoredBars} scored bars vs ${m.refBars} reference bars`,
        hears: 'the playback drifting a bar away from the page',
    },
    {
        id: 'bar-length',
        ok: m.barsWrongLength === 0,
        detail: `${m.barsWrongLength} of ${m.omrPrintedBars} bars are not the printed length`,
        hears: 'a bar that pauses or rushes because it is the wrong length',
    },
    {
        id: 'no-invented-hold',
        ok: m.holdsOk,
        detail: `${m.holds} hold(s) in the slice`,
        hears: 'a fermata-length pause the page never printed',
    },
    {
        id: 'repeat-walk',
        ok: m.performedBarsMatch,
        detail:
            m.performedBarsMatch === null
                ? 'performedBars not pinned — skipped'
                : `${m.omrPerformedBars} performed bars`,
        hears: 'a skipped repeat, so the piece is half as long as it should be',
    },
    {
        id: 'notes-present',
        ok: m.missing <= allowed,
        detail: `${m.missing} missing, ${allowed} allowed`,
        hears: 'notes that simply are not played',
    },
    {
        id: 'no-invented-notes',
        ok: m.extraUnexplained <= allowed,
        detail:
            m.extraUnexplained === m.extra
                ? `${m.extra} extra, ${allowed} allowed`
                : `${m.extra} extra (${m.extra - m.extraUnexplained} explained by printed ornaments), ${allowed} allowed`,
        hears: 'notes played that are not on the page',
    },
    {
        id: 'no-skipped-passage',
        ok: m.maxRefOnlyRun <= 1,
        detail: `longest unplaced reference run is ${m.maxRefOnlyRun} bar(s)`,
        hears: 'a whole passage missing, not just a note',
    },
    {
        id: 'attack-grid',
        ok: m.exact >= limits.exactFloor,
        detail: `exact ${pct(m.exact)} vs floor ${pct(limits.exactFloor)}`,
        hears: 'right notes, wrong beats',
    },
    {
        id: 'note-length',
        ok: m.onGrid >= limits.onGridFloor,
        detail: `onGrid ${pct(m.onGrid)} vs floor ${pct(limits.onGridFloor)}`,
        hears: 'notes chopped short or held through the next attack',
    },
];

/** Allowed misses for a movement, one per `barsPerAllowedMiss` printed bars. */
export const allowedMisses = (printedBars: number, limits: PlayAlongLimits): number =>
    Math.max(1, Math.ceil(printedBars / limits.barsPerAllowedMiss));

export const playAlongGate = (
    result: EvalResult,
    limits: PlayAlongLimits = defaultLimits(),
): PlayAlongVerdict => {
    const pieceChecks = structureChecks(result, result.structure.flags);
    const movements = result.movements.map((m) => {
        const allowed = allowedMisses(m.omrPrintedBars, limits);
        const checks = movementChecks(m, allowed, limits);
        return {
            name: m.name,
            refNotes: m.refNotes,
            pitchMatch: m.pitchMatch,
            exact: m.exact,
            onGrid: m.onGrid,
            allowedMisses: allowed,
            checks,
            pass: checks.every((c) => c.ok !== false),
        };
    });
    const failures = [
        ...pieceChecks.filter((c) => c.ok === false).map((c) => `${result.slug}: ${c.id} (${c.detail})`),
        ...movements.flatMap((mov) =>
            mov.checks.filter((c) => c.ok === false).map((c) => `${mov.name}: ${c.id} (${c.detail})`),
        ),
    ];
    return {
        slug: result.slug,
        title: result.title,
        score: result.overall.onGrid,
        pass: failures.length === 0,
        limits,
        movements,
        pieceChecks,
        failures,
    };
};

export const formatGate = (verdict: PlayAlongVerdict): string => {
    const lines = [
        `Play-along gate: ${verdict.pass ? 'PASS' : 'FAIL'}  score ${pct(verdict.score)} (on-grid notes)`,
        '',
        '| Movement | Pitch | +Onset | +Length | Miss/allow | Extra | Gate |',
        '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ];
    for (const mov of verdict.movements) {
        const miss = mov.checks.find((c) => c.id === 'notes-present')?.detail.split(' ')[0] ?? '?';
        const extra = mov.checks.find((c) => c.id === 'no-invented-notes')?.detail.split(' ')[0] ?? '?';
        lines.push(
            `| ${mov.name} | ${pct(mov.pitchMatch)} | ${pct(mov.exact)} | ${pct(mov.onGrid)} | ${miss}/${mov.allowedMisses} | ${extra} | ${mov.pass ? 'pass' : 'FAIL'} |`,
        );
    }
    if (verdict.failures.length > 0) {
        lines.push('', 'Failed checks:');
        for (const failure of verdict.failures) {
            lines.push(`  ✗ ${failure}`);
        }
    }
    lines.push('');
    return lines.join('\n');
};
