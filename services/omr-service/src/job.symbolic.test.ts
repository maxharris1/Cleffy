import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as audiveris from './audiveris.js';
import { runOmrPipeline } from './job.js';
import type * as jobStore from './jobStore.js';
import type { ScoreData } from './scoreData.js';
import { synthQuantizedMidi } from './symbolic/midiSynth.js';
import type { PdfSignals } from './symbolic/signals.js';
import type { TrySymbolicDeps } from './symbolic/tryJob.js';
import type { RankedCandidate, WorkKey } from './symbolic/types.js';
import type { JobTimings } from './timings.js';

const cacheLookup = vi.fn();
const cacheStore = vi.fn();
const runAudiverisTolerant = vi.fn();

vi.mock('./jobStore.js', async (importOriginal) => {
    const actual = await importOriginal<typeof jobStore>();
    return {
        ...actual,
        cacheLookup: (...args: unknown[]) => cacheLookup(...args),
        cacheStore: (...args: unknown[]) => cacheStore(...args),
    };
});

vi.mock('./audiveris.js', async (importOriginal) => {
    const actual = await importOriginal<typeof audiveris>();
    return {
        ...actual,
        runAudiverisTolerant: (...args: unknown[]) => runAudiverisTolerant(...args),
    };
});

const MINIMAL_PDF = Buffer.from(
    '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 3 3]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

const WORK: WorkKey = { composerId: 'bach', catalogType: 'BWV', catalogN: 772 };
const BARS = 4;
const URL = 'https://example.test/bach.mid';

const midi = (): Buffer =>
    synthQuantizedMidi({
        meter: { num: 4, den: 4 },
        pickupQuarters: 0,
        printedBars: BARS,
        fifths: 0,
        pitches: [60, 62, 64, 65],
    });

const boxes = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
        page: 0,
        system: 0,
        x0: i / n,
        x1: (i + 1) / n,
        y0: 0.1,
        y1: 0.2,
    }));

const pdfSignals = (over: Partial<PdfSignals> = {}): PdfSignals => ({
    meter: { num: 4, den: 4 },
    fifths: 0,
    printedBars: BARS,
    pickupQuarters: 0,
    opening: null,
    workKey: WORK,
    pageCount: 1,
    pickupFlagged: false,
    layoutBars: BARS,
    barBoxes: boxes(BARS),
    ...over,
});

const ranked = (over: Partial<RankedCandidate> = {}): RankedCandidate => ({
    source: 'mutopia',
    format: 'mid',
    url: URL,
    workKey: WORK,
    arrangement: false,
    priority: 3,
    ...over,
});

const omrScore = (): ScoreData =>
    ({
        version: 3,
        ticksPerQuarter: 480,
        defaultBpm: 90,
        timeSignatures: [{ tick: 0, num: 4, den: 4 }],
        totalTicks: 480,
        notes: [{ t: 0, d: 480, p: 60, h: 0 }],
        measures: [{ n: 1, tick: 0, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 }],
        systems: [{ page: 0, y0: 0, y1: 1 }],
        warnings: [],
    }) as ScoreData;

const stripVolatile = (timings: JobTimings): Record<string, unknown> => {
    const { downloadMs: _d, writebackMs: _w, ...rest } = timings;
    return rest;
};

const run = async (over: {
    symbolicEnabled: boolean;
    symbolicDeps?: TrySymbolicDeps;
}) => {
    const ready: Array<{ score: ScoreData; timings: JobTimings }> = [];
    const ok = await runOmrPipeline({
        documentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        pageCount: 1,
        resolvePdfUrl: async () => 'https://example.test/score.pdf',
        onProcessing: async () => undefined,
        onReady: async (score, timings) => {
            ready.push({ score, timings });
            return true;
        },
        onFailed: async () => undefined,
        resolveEra: async () => 'classical',
        symbolicEnabled: over.symbolicEnabled,
        ...(over.symbolicDeps ? { symbolicDeps: over.symbolicDeps } : {}),
    });
    return { ok, ready };
};

beforeEach(() => {
    cacheLookup.mockReset();
    cacheStore.mockReset();
    runAudiverisTolerant.mockReset();
    cacheLookup.mockResolvedValue({ score: omrScore(), bpmDefault: 90 });
    cacheStore.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', async () => new Response(Uint8Array.from(MINIMAL_PDF), { status: 200 }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('runOmrPipeline — symbolic-first', () => {
    it('flag off: cache-then-ready, no source, client unused, byte-identical timings shape', async () => {
        const discover = vi.fn(async () => [ranked()]);
        const a = await run({
            symbolicEnabled: false,
            symbolicDeps: {
                client: { discover, fetchBytes: async () => midi() },
                log: () => undefined,
            },
        });
        const b = await run({
            symbolicEnabled: false,
            symbolicDeps: {
                client: { discover, fetchBytes: async () => midi() },
                log: () => undefined,
            },
        });
        expect(discover).not.toHaveBeenCalled();
        expect(runAudiverisTolerant).not.toHaveBeenCalled();
        expect(cacheStore).not.toHaveBeenCalled();
        expect(a.ready[0]?.timings.source).toBeUndefined();
        expect(a.ready[0]?.timings.alignmentMap).toBeUndefined();
        expect(a.ready[0]?.timings.cacheHit).toBe(true);
        expect(JSON.stringify(stripVolatile(a.ready[0]!.timings))).toBe(
            JSON.stringify(stripVolatile(b.ready[0]!.timings)),
        );
        expect(a.ready[0]?.score).toEqual(omrScore());
    });

    it('accept skips Audiveris and the OMR cache, returning symbolic ScoreData + AlignmentMap + log', async () => {
        const bytes = midi();
        const logs: string[] = [];
        const result = await run({
            symbolicEnabled: true,
            symbolicDeps: {
                client: {
                    discover: async () => [ranked()],
                    fetchBytes: async () => bytes,
                },
                pdfSignals: async () => pdfSignals(),
                log: (line) => logs.push(line),
            },
        });
        expect(result.ok).toBe(true);
        expect(runAudiverisTolerant).not.toHaveBeenCalled();
        expect(cacheLookup).not.toHaveBeenCalled();
        expect(cacheStore).not.toHaveBeenCalled();
        const got = result.ready[0];
        expect(got?.timings.source?.tier).toBe('symbolic');
        expect(got?.timings.source?.band).toBe('accept');
        expect(got?.timings.source?.sourceName).toBe('Mutopia');
        expect(got?.timings.alignmentMap?.entries.length).toBe(got?.score.measures.length);
        expect(got?.score.notes.length).toBeGreaterThan(0);
        expect(JSON.parse(logs[0] ?? '{}').engineSkipped).toBe(true);
        expect(JSON.parse(logs[0] ?? '{}').symbolicTier).toBe(1);
    });

    it('ambiguous with catalog MIDI plays from ScoreData instead of waiting on OMR', async () => {
        const bytes = midi();
        const logs: string[] = [];
        const result = await run({
            symbolicEnabled: true,
            symbolicDeps: {
                client: {
                    discover: async () => [
                        ranked(),
                        ranked({ url: 'https://example.test/other.mid', source: 'imslp' }),
                    ],
                    fetchBytes: async () => bytes,
                },
                pdfSignals: async () => pdfSignals(),
                log: (line) => logs.push(line),
            },
        });
        expect(result.ok).toBe(true);
        expect(cacheLookup).not.toHaveBeenCalled();
        expect(runAudiverisTolerant).not.toHaveBeenCalled();
        expect(result.ready[0]?.timings.source?.band).toBe('accept');
        expect(result.ready[0]?.timings.source?.tier).toBe('symbolic');
        expect(result.ready[0]?.score.notes.length).toBeGreaterThan(0);
        expect(JSON.parse(logs[0] ?? '{}').band).toBe('accept');
    });

    it('reject keeps the log and runs the existing OMR path', async () => {
        const bytes = midi();
        const result = await run({
            symbolicEnabled: true,
            symbolicDeps: {
                client: {
                    discover: async () => [ranked({ arrangement: true })],
                    fetchBytes: async () => bytes,
                },
                pdfSignals: async () => pdfSignals(),
                log: () => undefined,
            },
        });
        expect(cacheLookup).toHaveBeenCalled();
        expect(result.ready[0]?.timings.source?.reason).toBe('arrangement');
        expect(result.ready[0]?.score).toEqual(omrScore());
    });

    it('parser_unusable falls through to OMR', async () => {
        const bytes = midi();
        const result = await run({
            symbolicEnabled: true,
            symbolicDeps: {
                client: {
                    discover: async () => [ranked()],
                    fetchBytes: async () => bytes,
                },
                pdfSignals: async () => pdfSignals(),
                ingest: () => {
                    throw new Error('measure_overfull');
                },
                log: () => undefined,
            },
        });
        expect(cacheLookup).toHaveBeenCalled();
        expect(result.ready[0]?.timings.source?.reason).toBe('parser_unusable');
        expect(result.ready[0]?.score).toEqual(omrScore());
    });

    it('network failure → no_candidate → OMR', async () => {
        const result = await run({
            symbolicEnabled: true,
            symbolicDeps: {
                client: {
                    discover: async () => {
                        throw new Error('timeout mutopia index');
                    },
                    fetchBytes: async () => {
                        throw new Error('unreachable');
                    },
                },
                pdfSignals: async () => pdfSignals(),
                log: () => undefined,
            },
        });
        expect(cacheLookup).toHaveBeenCalled();
        expect(result.ready[0]?.timings.source?.reason).toBe('no_candidate');
        expect(result.ready[0]?.score).toEqual(omrScore());
    });
});
