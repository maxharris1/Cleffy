import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreDataSchema } from '../src/scoreData.js';
import {
    compareScore,
    DEFAULT_GATE,
    type CompareResult,
    type MovementBoundary,
    type MovementResult,
} from './compare.js';

/**
 * Report a ScoreData against a reference edition.
 *
 *   npx tsx eval/compareToReference.ts --score score.json [--fixtures eval/fixtures/moonlight]
 *                                      [--gate 0.9] [--json out.json] [--record-baseline]
 *
 * `--score -` reads the ScoreData JSON from stdin (how `npm run eval:moonlight`
 * feeds it from Postgres). Exit status is 1 when any *gated* movement has a bar
 * under the gate. Ungated movements are printed as report-only. This binary is
 * a Moonlight diagnostic, not the corpus eval CLI in src/eval/.
 *
 * The fixture directory holds `boundaries.json` (one entry per movement, see
 * MovementBoundary), the reference MIDIs it names, and optionally
 * `baseline.json` — the last recorded result, printed alongside the new one so
 * a change is read as a delta and not an absolute. `--record-baseline` writes
 * that file even when gated movements fail; it is a changelog.
 */

interface Baseline {
    recordedAt: string;
    engine?: string;
    movements: Array<{ name: string; bars: number; passing: number; noteRecall: number }>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

const argValue = (flag: string): string | undefined => {
    const at = process.argv.indexOf(flag);
    return at >= 0 ? process.argv[at + 1] : undefined;
};

const readScore = (path: string): unknown => {
    const raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
    const trimmed = raw.trim();
    if (trimmed === '') {
        throw new Error('empty ScoreData input');
    }
    return JSON.parse(trimmed);
};

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

const readBaseline = (path: string): Baseline | null => {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    } catch {
        return null;
    }
};

const printMovement = (movement: MovementResult, gate: number, baseline: Baseline | null): void => {
    const previous = baseline?.movements.find((entry) => entry.name === movement.name);
    const delta =
        previous === undefined
            ? ''
            : ` (baseline ${previous.passing}/${previous.bars} bars, ${pct(previous.noteRecall)} notes)`;
    const role = movement.gated ? 'GATE' : 'report';
    console.log(
        `[${role}] ${movement.name}: ${movement.passing}/${movement.bars.length} bars >= ${pct(gate)}, note recall ${pct(movement.noteRecall)}${delta}`,
    );
    if (movement.extraScoreBars > 0) {
        console.log(`  ${movement.extraScoreBars} score bar(s) aligned to nothing in the reference`);
    }
    const failing = movement.bars.filter((bar) => bar.match < gate);
    if (failing.length > 0) {
        const items = failing.map((bar) => {
            const where = bar.aligned.length === 0 ? 'missing' : `score #${bar.aligned.map((s) => s.index).join('+')}`;
            return `${bar.ref.n}:${pct(bar.match)} [${bar.found}/${bar.refNotes}, ${where}]`;
        });
        console.log(`  under gate: ${items.join('  ')}`);
    }
};

const main = (): void => {
    const scorePath = argValue('--score');
    if (!scorePath) {
        console.error(
            'usage: compareToReference.ts --score <scoreData.json | -> [--fixtures dir] [--gate 0.9] [--json out] [--record-baseline]',
        );
        process.exit(2);
    }
    const fixtures = resolve(argValue('--fixtures') ?? join(HERE, 'fixtures', 'moonlight'));
    const gate = Number.parseFloat(argValue('--gate') ?? String(DEFAULT_GATE));
    const boundaries = JSON.parse(readFileSync(join(fixtures, 'boundaries.json'), 'utf8')) as MovementBoundary[];

    const parsed = scoreDataSchema.safeParse(readScore(scorePath));
    if (!parsed.success) {
        console.error(`ScoreData failed validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
        process.exit(2);
    }

    const baseline = readBaseline(join(fixtures, 'baseline.json'));

    const result: CompareResult = compareScore({
        score: parsed.data,
        movements: boundaries.map((boundary) => ({ boundary, midi: readFileSync(join(fixtures, boundary.midi)) })),
        gate,
    });

    for (const movement of result.movements) {
        printMovement(movement, gate, baseline);
    }
    const totalBars = result.movements.reduce((acc, movement) => acc + movement.bars.length, 0);
    const totalPassing = result.movements.reduce((acc, movement) => acc + movement.passing, 0);
    const gatedBars = result.movements.filter((m) => m.gated).reduce((acc, m) => acc + m.bars.length, 0);
    const gatedPassing = result.movements.filter((m) => m.gated).reduce((acc, m) => acc + m.passing, 0);
    console.log(
        `${result.pass ? 'PASS' : 'FAIL'}: gated ${gatedPassing}/${gatedBars} bars at or above the ${pct(gate)} bar (${totalPassing}/${totalBars} all movements, pitch-bag recall only)`,
    );

    const jsonOut = argValue('--json');
    if (jsonOut) {
        writeFileSync(
            jsonOut,
            JSON.stringify(result, (_key, value: unknown) => (value instanceof Map ? [...value.entries()] : value), 2),
        );
    }
    if (process.argv.includes('--record-baseline')) {
        const recorded: Baseline = {
            recordedAt: new Date().toISOString(),
            ...(argValue('--engine') ? { engine: argValue('--engine') } : {}),
            movements: result.movements.map((movement) => ({
                name: movement.name,
                bars: movement.bars.length,
                passing: movement.passing,
                noteRecall: Math.round(movement.noteRecall * 10_000) / 10_000,
            })),
        };
        writeFileSync(join(fixtures, 'baseline.json'), `${JSON.stringify(recorded, null, 4)}\n`);
        console.log(`baseline recorded to ${join(fixtures, 'baseline.json')}`);
    }
    process.exit(result.pass ? 0 : 1);
};

main();
