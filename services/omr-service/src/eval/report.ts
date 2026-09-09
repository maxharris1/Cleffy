import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

import type { Candidate } from './candidate.js';
import type { EvalResult, MovementMetrics } from './compare.js';
import { resultsDir } from './paths.js';

export interface EvalRecord extends EvalResult {
    generatedAt: string;
    engineVersion: string | null;
    candidateSource: Candidate['source'];
    audiverisCacheHit: boolean | null;
    artifactHash: string | null;
    audiverisVersion: string | null;
    audiverisOptions: string | null;
}

export interface HeadlineDelta {
    path: string;
    before: number;
    after: number;
    delta: number;
    regressed: boolean;
}

export class IncomparableBaselineError extends Error {
    readonly exitCode: 1 | 2;

    constructor(message: string, exitCode: 1 | 2) {
        super(message);
        this.name = 'IncomparableBaselineError';
        this.exitCode = exitCode;
    }
}

const SAFE_BASENAME = /^[A-Za-z0-9._-]+$/;

const movementMetricsSchema = z
    .object({
        name: z.string(),
        refBars: z.number(),
        omrPrintedBars: z.number().nonnegative(),
        omrPerformedBars: z.number(),
        refNotes: z.number(),
        omrNotes: z.number(),
        pitchMatch: z.number(),
        exact: z.number(),
        missing: z.number(),
        extra: z.number(),
        octave: z.number(),
        semitone: z.number(),
        handErr: z.number(),
        barsImperfect: z.number(),
        refOnly: z.number(),
        omrOnly: z.number(),
        merge2: z.number(),
        barsAtCorrectLength: z.number().nonnegative(),
        melodySurvival: z.number(),
        melodyTotal: z.number(),
        melodyFound: z.number(),
        barsUnderWrongKey: z.number(),
        tempoInRange: z.boolean(),
        tempoBpm: z.number().nullable(),
        performedBarsMatch: z.boolean().nullable(),
        velocityDistinct: z.number(),
    })
    .superRefine((m, ctx) => {
        if (m.barsAtCorrectLength > m.omrPrintedBars) {
            ctx.addIssue({
                code: 'custom',
                message: `barsAtCorrectLength (${m.barsAtCorrectLength}) cannot exceed omrPrintedBars (${m.omrPrintedBars})`,
            });
        }
    });

const evalRecordSchema = z.object({
    slug: z.string().min(1),
    title: z.string().min(1),
    movements: z.array(movementMetricsSchema).min(1),
    overall: z.object({
        refNotes: z.number(),
        omrNotes: z.number(),
        pitchMatch: z.number(),
        exact: z.number(),
        missing: z.number(),
        extra: z.number(),
        octave: z.number(),
        semitone: z.number(),
        velocityDistinct: z.number(),
    }),
    structure: z.object({
        movementCountOk: z.boolean(),
        metersOk: z.boolean(),
        warnings: z.array(z.string()),
    }),
    composite: z.number(),
    bars: z.record(z.string(), z.array(z.unknown())),
    generatedAt: z.string(),
    engineVersion: z.string().nullable(),
    candidateSource: z.enum(['pdf', 'artifacts', 'document']),
    audiverisCacheHit: z.boolean().nullable(),
    artifactHash: z.string().nullable(),
    audiverisVersion: z.string().nullable(),
    audiverisOptions: z.string().nullable(),
});

type HeadlineSpec = { path: string; higherIsBetter: boolean; absolute?: boolean };

const HEADLINES: HeadlineSpec[] = [
    { path: 'composite', higherIsBetter: true },
    { path: 'overall.pitchMatch', higherIsBetter: true },
    { path: 'overall.exact', higherIsBetter: true },
    { path: 'overall.missing', higherIsBetter: false },
    { path: 'structure.movementCountOk', higherIsBetter: true },
    { path: 'structure.metersOk', higherIsBetter: true },
];

const headlinePaths = (record: EvalRecord): HeadlineSpec[] => [
    ...HEADLINES,
    ...record.movements.flatMap((_, i) => [
        { path: `movements.${i}.pitchMatch`, higherIsBetter: true },
        { path: `movements.${i}.tempoInRange`, higherIsBetter: true },
        { path: `movements.${i}.barsUnderWrongKey`, higherIsBetter: false },
        { path: `movements.${i}.merge2`, higherIsBetter: false },
        { path: `movements.${i}.refOnly`, higherIsBetter: false },
        { path: `movements.${i}.omrPrintedBars`, higherIsBetter: true, absolute: true },
    ]),
];

const atPath = (obj: unknown, path: string): number | null => {
    let cur: unknown = obj;
    for (const key of path.split('.')) {
        if (cur === null || cur === undefined || typeof cur !== 'object') {
            return null;
        }
        cur = (cur as Record<string, unknown>)[key];
    }
    if (typeof cur === 'boolean') {
        return cur ? 1 : 0;
    }
    return typeof cur === 'number' ? cur : null;
};

export const attachRecord = (result: EvalResult, candidate: Candidate): EvalRecord => ({
    ...result,
    generatedAt: new Date().toISOString(),
    engineVersion: candidate.engineVersion,
    candidateSource: candidate.source,
    audiverisCacheHit: candidate.audiverisCacheHit,
    artifactHash: candidate.artifactHash,
    audiverisVersion: candidate.audiverisVersion,
    audiverisOptions: candidate.audiverisOptions,
});

const pct = (n: number): string => `${n.toFixed(1)}%`;

const movementLine = (m: MovementMetrics): string =>
    `| ${m.name} | ${pct(m.pitchMatch)} | ${pct(m.exact)} | ${m.missing} | ${m.semitone} | ${m.octave} | ${m.omrPrintedBars}/${m.refBars} | ${m.barsAtCorrectLength} | ${pct(m.melodySurvival)} | ${m.tempoBpm ?? '—'} ${m.tempoInRange ? 'ok' : 'out'} |`;

export const formatSummary = (record: EvalRecord): string => {
    const lines = [
        `# ${record.title}`,
        '',
        `slug: ${record.slug}  source: ${record.candidateSource}  composite: ${record.composite.toFixed(1)}`,
        `engine: ${record.engineVersion ?? '—'}  audiveris: ${record.audiverisVersion ?? '—'}  cacheHit: ${record.audiverisCacheHit}`,
        `artifactHash: ${record.artifactHash ?? '—'}`,
        '',
        '| Movement | Pitch | Exact | Missing | Semi | Oct | Printed | At length | Melody | Tempo |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
        ...record.movements.map(movementLine),
        '',
        `Overall pitch ${pct(record.overall.pitchMatch)} · exact ${pct(record.overall.exact)} · missing ${record.overall.missing} · extra ${record.overall.extra} · velocities ${record.overall.velocityDistinct}`,
        `Structure: movements ${record.structure.movementCountOk ? 'ok' : 'mismatch'}, meters ${record.structure.metersOk ? 'ok' : 'mismatch'}`,
        `Warnings: ${record.structure.warnings.join(', ') || 'none'}`,
        '',
    ];
    return lines.join('\n');
};

export const assertResultFileName = (filename: string): string => {
    const name = basename(filename);
    if (name !== filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        throw new Error(`--out must be a basename under eval/results/<slug>/ (got ${filename})`);
    }
    if (!SAFE_BASENAME.test(name)) {
        throw new Error(`--out must match ${SAFE_BASENAME} (got ${filename})`);
    }
    return name;
};

const isBaselineName = (name: string): boolean => name.startsWith('baseline');

export const assertBaselineWritable = (record: EvalRecord, filename: string): void => {
    if (!isBaselineName(filename)) {
        return;
    }
    if (record.candidateSource === 'document') {
        throw new Error('refusing to write a baseline-* oracle from --from document');
    }
    if (!record.artifactHash) {
        throw new Error('refusing to write a baseline-* oracle without a non-null artifactHash');
    }
};

export const writeResult = async (record: EvalRecord, filename?: string): Promise<string> => {
    const dir = join(resultsDir(), record.slug);
    await mkdir(dir, { recursive: true });
    const stamp = record.generatedAt.replace(/[:.]/g, '-');
    const engine = (record.engineVersion ?? 'unknown').replace(/[^a-zA-Z0-9._+-]+/g, '_');
    const name = filename === undefined ? `${engine}-${stamp}.json` : assertResultFileName(filename);
    if (filename !== undefined) {
        assertBaselineWritable(record, name);
    }
    const parsed = evalRecordSchema.safeParse(record);
    if (!parsed.success) {
        throw new Error(`eval record failed invariants: ${parsed.error.issues[0]?.message}`);
    }
    const jsonPath = join(dir, name);
    await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(join(dir, 'summary.md'), formatSummary(record));
    return jsonPath;
};

export const loadBaseline = (path: string): EvalRecord => {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        throw new Error(`baseline is not JSON: ${path}`, { cause: err });
    }
    const parsed = evalRecordSchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`invalid baseline ${path}: ${issue?.path.join('.')}: ${issue?.message}`);
    }
    return parsed.data as EvalRecord;
};

export const diffBaseline = (baseline: EvalRecord, current: EvalRecord, tolerance: number): HeadlineDelta[] => {
    if (!baseline.artifactHash || !current.artifactHash) {
        throw new IncomparableBaselineError(
            'refusing a parser-only verdict: both records need a non-null artifactHash',
            2,
        );
    }
    if (baseline.artifactHash !== current.artifactHash) {
        throw new IncomparableBaselineError(
            `artifact hash mismatch — engine/options delta, not a parser-only delta\n` +
                `  before ${baseline.artifactHash}\n  after  ${current.artifactHash}`,
            1,
        );
    }
    return headlinePaths(current).map(({ path, higherIsBetter, absolute }) => {
        const before = atPath(baseline, path) ?? 0;
        const after = atPath(current, path) ?? 0;
        const delta = after - before;
        const worse = absolute
            ? Math.abs(delta) > tolerance
            : higherIsBetter
              ? delta < -tolerance
              : delta > tolerance;
        return { path, before, after, delta, regressed: worse };
    });
};

export const formatDeltas = (deltas: HeadlineDelta[]): string => {
    const rows = deltas.map((d) => {
        const sign = d.delta >= 0 ? '+' : '';
        const flag = d.regressed ? ' REGRESSED' : '';
        return `  ${d.path}: ${d.before.toFixed(2)} → ${d.after.toFixed(2)} (${sign}${d.delta.toFixed(2)})${flag}`;
    });
    return ['Baseline deltas:', ...rows].join('\n');
};
