import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as audiveris from './audiveris.js';
import type * as corpusStore from './corpus/store.js';
import type { CorpusHit, PdProvenance } from './corpus/store.js';
import { ENGINE_VERSION, runOmrPipeline } from './job.js';
import type * as jobStore from './jobStore.js';
import { sha256Hex } from './jobStore.js';
import type { ScoreData } from './scoreData.js';
import { synthQuantizedMidi } from './symbolic/midiSynth.js';
import type { PdfSignals } from './symbolic/signals.js';
import type { TrySymbolicDeps } from './symbolic/tryJob.js';
import type { RankedCandidate, WorkKey } from './symbolic/types.js';
import type { JobTimings } from './timings.js';

const cacheLookup = vi.fn();
const cacheStore = vi.fn();
const runAudiverisTolerant = vi.fn();
const corpusLookupByHash = vi.fn();
const corpusLookupByLayout = vi.fn();
const corpusPut = vi.fn();
const pdProvenance = vi.fn<typeof corpusStore.pdProvenance>(async () => null);

vi.mock('./jobStore.js', async (importOriginal) => {
    const actual = await importOriginal<typeof jobStore>();
    return {
        ...actual,
        cacheLookup: (...args: unknown[]) => cacheLookup(...args),
        cacheStore: (...args: unknown[]) => cacheStore(...args),
    };
});

vi.mock('./corpus/store.js', async (importOriginal) => {
    const actual = await importOriginal<typeof corpusStore>();
    return {
        ...actual,
        corpusLookupByHash: (...args: unknown[]) => corpusLookupByHash(...args),
        corpusLookupByLayout: (...args: unknown[]) => corpusLookupByLayout(...args),
        corpusPut: (...args: unknown[]) => corpusPut(...args),
        pdProvenance: (...args: Parameters<typeof corpusStore.pdProvenance>) => pdProvenance(...args),
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
const PDF_SHA = sha256Hex(MINIMAL_PDF);
const DOC = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OWNER = '11111111-1111-1111-1111-111111111111';
const TITLE = 'Inventions (Bach, Johann Sebastian)';
const PUBLIC_PROVENANCE: PdProvenance = {
    licenceTag: 'PD',
    editorCredit: null,
    sourceUrl: 'https://example.test/public.pdf',
    usPd: true,
};

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

/** A corpus row whose score has four bars so a layout hit re-aligns onto the 4-box PDF. */
const corpusScore = (): ScoreData =>
    ({
        ...omrScore(),
        totalTicks: 4 * 1920,
        notes: [{ t: 0, d: 480, p: 72, h: 0 }],
        measures: Array.from({ length: 4 }, (_, i) => ({
            n: i + 1,
            tick: i * 1920,
            dTicks: 1920,
            page: 0,
            sys: 0,
            x0: i / 4,
            x1: (i + 1) / 4,
        })),
    }) as ScoreData;

const corpusHit = (over: Partial<CorpusHit> = {}): CorpusHit => ({
    pdfSha256: 'corpus-pdf',
    era: '',
    score: corpusScore(),
    alignmentMap: {
        pdfSha256: 'corpus-pdf',
        candidateSha256: 'cand',
        pickup: false,
        printedBars: 4,
        bySrcIndex: {},
        entries: [],
    },
    source: { tier: 'symbolic', band: 'accept', reason: 'accept', sourceName: 'Mutopia', origin: 'mutopia' },
    candidateSha256: 'cand',
    ...over,
});

const stripVolatile = (timings: JobTimings): Record<string, unknown> => {
    const { downloadMs: _d, writebackMs: _w, corpusLookupMs: _c, ...rest } = timings;
    return rest;
};

const run = async (over: {
    symbolicEnabled: boolean;
    corpusEnabled: boolean;
    symbolicDeps?: TrySymbolicDeps;
    imslpPageTitle?: string;
    createdBy?: string | null;
}) => {
    const ready: Array<{ score: ScoreData; timings: JobTimings }> = [];
    const ok = await runOmrPipeline({
        documentId: DOC,
        pageCount: 1,
        resolvePdfUrl: async () => 'https://example.test/score.pdf',
        onProcessing: async () => undefined,
        onReady: async (score, timings) => {
            ready.push({ score, timings });
            return true;
        },
        onFailed: async () => undefined,
        resolveEra: async () => 'baroque',
        symbolicEnabled: over.symbolicEnabled,
        corpusEnabled: over.corpusEnabled,
        ...(over.symbolicDeps ? { symbolicDeps: over.symbolicDeps } : {}),
        ...(over.imslpPageTitle !== undefined ? { imslpPageTitle: over.imslpPageTitle } : {}),
        ...(over.createdBy !== undefined ? { createdBy: over.createdBy } : {}),
    });
    return { ok, ready };
};

const mutopiaDeps = (discover = vi.fn(async () => [ranked()])): TrySymbolicDeps & { discover: typeof discover } => ({
    client: { discover, fetchBytes: async () => midi() },
    pdfSignals: async () => pdfSignals(),
    log: () => undefined,
    discover,
});

beforeEach(() => {
    cacheLookup.mockReset();
    cacheStore.mockReset();
    runAudiverisTolerant.mockReset();
    corpusLookupByHash.mockReset();
    corpusLookupByLayout.mockReset();
    corpusPut.mockReset();
    pdProvenance.mockReset();
    pdProvenance.mockResolvedValue(null);
    cacheLookup.mockResolvedValue({ score: omrScore(), bpmDefault: 90 });
    cacheStore.mockResolvedValue(undefined);
    corpusLookupByHash.mockResolvedValue(null);
    corpusLookupByLayout.mockResolvedValue(null);
    corpusPut.mockResolvedValue(true);
    vi.stubGlobal('fetch', async () => new Response(Uint8Array.from(MINIMAL_PDF), { status: 200 }));
    vi.stubEnv('CLEFFY_CORPUS_OWNER_USER_ID', OWNER);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('runOmrPipeline — play-along corpus', () => {
    it('both flags off: no corpus RPC, timings shape unchanged from the pre-corpus job', async () => {
        const deps = mutopiaDeps();
        const a = await run({ symbolicEnabled: false, corpusEnabled: false, symbolicDeps: deps });
        const b = await run({ symbolicEnabled: false, corpusEnabled: false, symbolicDeps: deps });
        expect(corpusLookupByHash).not.toHaveBeenCalled();
        expect(corpusLookupByLayout).not.toHaveBeenCalled();
        expect(corpusPut).not.toHaveBeenCalled();
        expect(deps.discover).not.toHaveBeenCalled();
        const timings = a.ready[0]!.timings;
        expect(timings.corpusHit).toBeUndefined();
        expect(timings.corpusLookupMs).toBeUndefined();
        expect(timings.source).toBeUndefined();
        expect(Object.keys(stripVolatile(timings)).sort()).toEqual(['cacheHit', 'pageCount', 'pdfBytes']);
        expect(JSON.stringify(stripVolatile(timings))).toBe(JSON.stringify(stripVolatile(b.ready[0]!.timings)));
    });

    it('hash hit: no discover, no cacheLookup, no Audiveris; onReady gets score + alignmentMap + corpusHit hash', async () => {
        corpusLookupByHash.mockResolvedValue(corpusHit());
        const deps = mutopiaDeps();
        const result = await run({ symbolicEnabled: true, corpusEnabled: true, symbolicDeps: deps });
        expect(result.ok).toBe(true);
        expect(corpusLookupByHash).toHaveBeenCalledWith(PDF_SHA, ENGINE_VERSION, 'baroque');
        expect(deps.discover).not.toHaveBeenCalled();
        expect(corpusLookupByLayout).not.toHaveBeenCalled();
        expect(cacheLookup).not.toHaveBeenCalled();
        expect(runAudiverisTolerant).not.toHaveBeenCalled();
        expect(corpusPut).not.toHaveBeenCalled();
        const got = result.ready[0]!;
        expect(got.score).toEqual(corpusScore());
        expect(got.timings.corpusHit).toBe('hash');
        expect(got.timings.alignmentMap?.candidateSha256).toBe('cand');
        expect(got.timings.source?.sourceName).toBe('Mutopia');
        expect(typeof got.timings.corpusLookupMs).toBe('number');
    });

    it('hash hit serves an OMR corpus row (no alignment map) even with symbolic off', async () => {
        corpusLookupByHash.mockResolvedValue(
            corpusHit({
                alignmentMap: null,
                candidateSha256: null,
                source: { tier: 'omr', band: 'reject', reason: 'no_candidate', origin: 'omr' },
            }),
        );
        const result = await run({ symbolicEnabled: false, corpusEnabled: true });
        expect(cacheLookup).not.toHaveBeenCalled();
        expect(result.ready[0]?.timings.corpusHit).toBe('hash');
        expect(result.ready[0]?.timings.alignmentMap).toBeUndefined();
        expect(result.ready[0]?.timings.source?.tier).toBe('omr');
    });

    it('layout unique hit: no discover; score re-aligned onto this PDF; corpusHit layout; no put', async () => {
        corpusLookupByLayout.mockResolvedValue(corpusHit());
        const deps = mutopiaDeps();
        const result = await run({ symbolicEnabled: true, corpusEnabled: true, symbolicDeps: deps });
        expect(corpusLookupByLayout).toHaveBeenCalledWith(ENGINE_VERSION, WORK, BARS, 1);
        expect(deps.discover).not.toHaveBeenCalled();
        expect(cacheLookup).not.toHaveBeenCalled();
        expect(corpusPut).not.toHaveBeenCalled();
        const got = result.ready[0]!;
        expect(got.score).toEqual(corpusScore());
        expect(got.timings.corpusHit).toBe('layout');
        expect(got.timings.alignmentMap?.pdfSha256).toBe(PDF_SHA);
        expect(got.timings.alignmentMap?.candidateSha256).toBe('cand');
        expect(got.timings.alignmentMap?.entries.length).toBe(4);
        expect(got.timings.source?.band).toBe('accept');
    });

    it('layout collision / miss (RPC returns none): discover runs as before', async () => {
        const deps = mutopiaDeps();
        const result = await run({ symbolicEnabled: true, corpusEnabled: true, symbolicDeps: deps });
        expect(corpusLookupByLayout).toHaveBeenCalledTimes(1);
        expect(deps.discover).toHaveBeenCalledTimes(1);
        expect(result.ready[0]?.timings.corpusHit).toBeUndefined();
        expect(result.ready[0]?.timings.source?.sourceName).toBe('Mutopia');
    });

    it('corpus flag off, symbolic on: no layout lookup is injected', async () => {
        const deps = mutopiaDeps();
        await run({ symbolicEnabled: true, corpusEnabled: false, symbolicDeps: deps });
        expect(corpusLookupByHash).not.toHaveBeenCalled();
        expect(corpusLookupByLayout).not.toHaveBeenCalled();
        expect(corpusPut).not.toHaveBeenCalled();
        expect(deps.discover).toHaveBeenCalledTimes(1);
    });

    it('accept Mutopia for a verified public PDF → corpusPut with era "", alignment map, WorkKey, candidate and title', async () => {
        pdProvenance.mockResolvedValue(PUBLIC_PROVENANCE);
        const deps = mutopiaDeps();
        const result = await run({
            symbolicEnabled: true,
            corpusEnabled: true,
            symbolicDeps: deps,
            imslpPageTitle: TITLE,
        });
        expect(result.ok).toBe(true);
        expect(cacheStore).not.toHaveBeenCalled();
        expect(corpusPut).toHaveBeenCalledTimes(1);
        const put = corpusPut.mock.calls[0]![0] as Record<string, unknown>;
        expect(put).toMatchObject({
            pdfSha256: PDF_SHA,
            engineVersion: ENGINE_VERSION,
            era: '',
            workKey: WORK,
            printedBars: BARS,
            pageCount: 1,
            candidateUrl: URL,
            symbolicSource: 'mutopia',
            symbolicFormat: 'mid',
            imslpPageTitle: TITLE,
            source: { tier: 'symbolic', band: 'accept', origin: 'mutopia', imslp_page_title: TITLE },
        });
        expect(put.score).toEqual(result.ready[0]!.score);
        expect(put.alignmentMap).toEqual(result.ready[0]!.timings.alignmentMap);
        expect(typeof put.candidateSha256).toBe('string');
    });

    it('accept user (You uploaded) → no corpusPut', async () => {
        const deps = mutopiaDeps(vi.fn(async () => [ranked({ source: 'user', format: 'mid', priority: 4 })]));
        const result = await run({ symbolicEnabled: true, corpusEnabled: true, symbolicDeps: deps });
        expect(result.ready[0]?.timings.source?.sourceName).toBe('You uploaded');
        expect(result.ready[0]?.timings.source?.band).toBe('accept');
        expect(corpusPut).not.toHaveBeenCalled();
    });

    it('OMR ready (cache hit) without imslpPageTitle or seed owner → no put', async () => {
        await run({ symbolicEnabled: false, corpusEnabled: true, createdBy: 'someone-else' });
        expect(cacheLookup).toHaveBeenCalled();
        expect(corpusPut).not.toHaveBeenCalled();
    });

    it('OMR ready with verified PDF provenance → put with the document era, origin omr and the title', async () => {
        pdProvenance.mockResolvedValue(PUBLIC_PROVENANCE);
        const result = await run({ symbolicEnabled: false, corpusEnabled: true, imslpPageTitle: TITLE });
        expect(result.ready[0]?.timings.cacheHit).toBe(true);
        expect(corpusPut).toHaveBeenCalledTimes(1);
        expect(corpusPut.mock.calls[0]![0]).toMatchObject({
            pdfSha256: PDF_SHA,
            engineVersion: ENGINE_VERSION,
            era: 'baroque',
            score: omrScore(),
            symbolicSource: 'omr',
            imslpPageTitle: TITLE,
            pageCount: 1,
            source: { tier: 'omr', band: 'reject', reason: 'no_candidate', origin: 'omr', imslp_page_title: TITLE },
        });
        expect(corpusPut.mock.calls[0]![0]).not.toHaveProperty('alignmentMap');
    });

    it('OMR ready for a corpus-owner document → put, carrying the symbolic fallthrough layout key', async () => {
        const deps = mutopiaDeps(vi.fn(async () => [ranked({ arrangement: true })]));
        const result = await run({ symbolicEnabled: true, corpusEnabled: true, symbolicDeps: deps, createdBy: OWNER });
        expect(result.ready[0]?.timings.source?.reason).toBe('arrangement');
        expect(corpusPut).toHaveBeenCalledTimes(1);
        expect(corpusPut.mock.calls[0]![0]).toMatchObject({
            era: 'baroque',
            workKey: WORK,
            printedBars: BARS,
            symbolicSource: 'omr',
            source: { tier: 'omr', band: 'reject', reason: 'arrangement', origin: 'omr' },
        });
        expect(corpusPut.mock.calls[0]![0]).not.toHaveProperty('imslpPageTitle');
    });

    it('carries the seed’s licence and credit onto the corpus row and onto what the player badges from', async () => {
        pdProvenance.mockResolvedValueOnce({
            licenceTag: 'CC-BY-SA',
            editorCredit: 'Chris Sawer, after Breitkopf & Härtel (Mutopia)',
            sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=44',
            usPd: true,
        });
        const result = await run({ symbolicEnabled: false, corpusEnabled: true, imslpPageTitle: TITLE });

        expect(result.ready[0]?.timings.source).toMatchObject({
            licence: 'CC-BY-SA',
            editorCredit: 'Chris Sawer, after Breitkopf & Härtel (Mutopia)',
            sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=44',
        });
        expect(corpusPut.mock.calls[0]![0]).toMatchObject({
            licenceTag: 'CC-BY-SA',
            editorCredit: 'Chris Sawer, after Breitkopf & Härtel (Mutopia)',
            sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=44',
            source: {
                licence_tag: 'CC-BY-SA',
                editor_credit: 'Chris Sawer, after Breitkopf & Härtel (Mutopia)',
                source_url: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=44',
                us_pd: true,
            },
        });
    });

    it('serves a hash hit’s stored provenance to the client in the camelCase keys it parses', async () => {
        corpusLookupByHash.mockResolvedValueOnce(
            corpusHit({
                source: {
                    tier: 'omr',
                    band: 'reject',
                    reason: 'no_candidate',
                    origin: 'ia',
                    licence_tag: 'CC-BY',
                    editor_credit: 'Some editor (IMSLP)',
                    source_url: 'https://archive.org/details/imslp-x',
                },
            }),
        );
        const result = await run({ symbolicEnabled: false, corpusEnabled: true });
        expect(result.ready[0]?.timings.source).toMatchObject({
            tier: 'omr',
            licence: 'CC-BY',
            editorCredit: 'Some editor (IMSLP)',
            sourceUrl: 'https://archive.org/details/imslp-x',
        });
    });

    it('checks exact PDF bytes for public provenance independently of the editable title', async () => {
        pdProvenance.mockResolvedValue(PUBLIC_PROVENANCE);
        await run({ symbolicEnabled: false, corpusEnabled: true, createdBy: 'someone-else' });
        expect(pdProvenance).toHaveBeenCalledExactlyOnceWith(PDF_SHA);
        expect(corpusPut).toHaveBeenCalledTimes(1);
    });

    it.each([false, true])(
        'keeps a private upload with an IMSLP-shaped title out of the corpus (symbolic: %s)',
        async (symbolicEnabled) => {
            const result = await run({
                symbolicEnabled,
                corpusEnabled: true,
                symbolicDeps: mutopiaDeps(),
                imslpPageTitle: TITLE,
                createdBy: 'someone-else',
            });
            expect(result.ok).toBe(true);
            expect(result.ready).toHaveLength(1);
            expect(pdProvenance).toHaveBeenCalledExactlyOnceWith(PDF_SHA);
            expect(corpusPut).not.toHaveBeenCalled();
        },
    );

    it('allows a seed-owned symbolic result without PDF-store provenance', async () => {
        const result = await run({
            symbolicEnabled: true,
            corpusEnabled: true,
            symbolicDeps: mutopiaDeps(),
            createdBy: OWNER,
        });
        expect(result.ok).toBe(true);
        expect(corpusPut).toHaveBeenCalledTimes(1);
        expect(corpusPut.mock.calls[0]![0]).toMatchObject({ symbolicSource: 'mutopia' });
    });

    it('withholds a non-keyboard transcription from the corpus but still serves it', async () => {
        pdProvenance.mockResolvedValue(PUBLIC_PROVENANCE);
        cacheLookup.mockReset();
        cacheLookup.mockResolvedValue({
            score: {
                ...omrScore(),
                systems: [
                    {
                        page: 0,
                        y0: 0,
                        y1: 1,
                        staves: [
                            { y0: 0, y1: 0.3 },
                            { y0: 0.35, y1: 0.65 },
                            { y0: 0.7, y1: 1 },
                        ],
                    },
                ],
            },
        });
        const result = await run({ symbolicEnabled: false, corpusEnabled: true, imslpPageTitle: TITLE });

        expect(corpusPut).not.toHaveBeenCalled();
        expect(result.ready).toHaveLength(1);
        expect(result.ready[0]?.timings.corpusGate).toEqual({ promoted: false, reason: 'staves' });
    });

    it('records a promoted gate verdict on a score that passes', async () => {
        pdProvenance.mockResolvedValue(PUBLIC_PROVENANCE);
        const result = await run({ symbolicEnabled: false, corpusEnabled: true, imslpPageTitle: TITLE });
        expect(result.ready[0]?.timings.corpusGate).toEqual({ promoted: true });
        expect(corpusPut).toHaveBeenCalledTimes(1);
    });

    it('corpus on but every RPC misses: today’s path, with only corpusLookupMs added to timings', async () => {
        const off = await run({ symbolicEnabled: false, corpusEnabled: false });
        const on = await run({ symbolicEnabled: false, corpusEnabled: true });
        expect(on.ready[0]?.timings.cacheHit).toBe(true);
        expect(on.ready[0]?.timings.corpusHit).toBeUndefined();
        expect(typeof on.ready[0]?.timings.corpusLookupMs).toBe('number');
        expect(JSON.stringify(stripVolatile(on.ready[0]!.timings))).toBe(
            JSON.stringify(stripVolatile(off.ready[0]!.timings)),
        );
    });
});
