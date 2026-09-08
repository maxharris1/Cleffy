import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const HEADLINES: Array<{ path: string; higherIsBetter: boolean }> = [
    { path: 'composite', higherIsBetter: true },
    { path: 'overall.pitchMatch', higherIsBetter: true },
    { path: 'overall.exact', higherIsBetter: true },
    { path: 'overall.missing', higherIsBetter: false },
];

const headlinePaths = (record: EvalRecord): Array<{ path: string; higherIsBetter: boolean }> => [
    ...HEADLINES,
    ...record.movements.map((_, i) => ({ path: `movements.${i}.pitchMatch`, higherIsBetter: true })),
];

const atPath = (obj: unknown, path: string): number | null => {
    let cur: unknown = obj;
    for (const key of path.split('.')) {
        if (cur === null || cur === undefined || typeof cur !== 'object') {
            return null;
        }
        cur = (cur as Record<string, unknown>)[key];
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

export const writeResult = async (record: EvalRecord, filename?: string): Promise<string> => {
    const dir = join(resultsDir(), record.slug);
    await mkdir(dir, { recursive: true });
    const stamp = record.generatedAt.replace(/[:.]/g, '-');
    const engine = (record.engineVersion ?? 'unknown').replace(/[^a-zA-Z0-9._+-]+/g, '_');
    const name = filename ?? `${engine}-${stamp}.json`;
    const jsonPath = join(dir, name);
    await writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(join(dir, 'summary.md'), formatSummary(record));
    return jsonPath;
};

export const loadBaseline = (path: string): EvalRecord => JSON.parse(readFileSync(path, 'utf8')) as EvalRecord;

export const diffBaseline = (baseline: EvalRecord, current: EvalRecord, tolerance: number): HeadlineDelta[] => {
    if (baseline.artifactHash && current.artifactHash && baseline.artifactHash !== current.artifactHash) {
        process.stderr.write(
            `artifact hash changed — this is an engine/options delta, not a parser-only delta\n` +
                `  before ${baseline.artifactHash}\n  after  ${current.artifactHash}\n`,
        );
    }
    return headlinePaths(current).map(({ path, higherIsBetter }) => {
        const before = atPath(baseline, path) ?? 0;
        const after = atPath(current, path) ?? 0;
        const delta = after - before;
        const worse = higherIsBetter ? delta < -tolerance : delta > tolerance;
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
