import { describe, expect, it } from 'vitest';

import { ingestSymbolic } from './ingest.js';
import { sourceNameOf } from './jobResult.js';
import { synthQuantizedMidi } from './midiSynth.js';
import type { PdfSignals } from './signals.js';
import { trySymbolicJob, type TrySymbolicDeps } from './tryJob.js';
import type { RankedCandidate, WorkKey } from './types.js';

const WORK: WorkKey = { composerId: 'bach', catalogType: 'BWV', catalogN: 772 };
const BARS = 4;
const URL = 'https://example.test/bach-invention-01.mid';

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

const pdf = (over: Partial<PdfSignals> = {}): PdfSignals => ({
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

const mutopiaMid = (over: Partial<RankedCandidate> = {}): RankedCandidate => ({
    source: 'mutopia',
    format: 'mid',
    url: URL,
    workKey: WORK,
    arrangement: false,
    priority: 3,
    ...over,
});

const ctx = { uploadId: 'doc-1', pageCount: 1 };

const depsOf = (over: Partial<TrySymbolicDeps> & { client: TrySymbolicDeps['client'] }): TrySymbolicDeps => ({
    pdfSignals: async () => pdf(),
    log: () => undefined,
    ...over,
});

describe('sourceNameOf', () => {
    it('maps locked product names', () => {
        expect(sourceNameOf('mutopia', 'mid')).toBe('Mutopia');
        expect(sourceNameOf('imslp', 'mxl')).toBe('IMSLP XML');
        expect(sourceNameOf('imslp', 'mid')).toBe('MIDI');
        expect(sourceNameOf('user', 'user-xml')).toBe('You uploaded');
        expect(sourceNameOf('asap_eval', 'mid')).toBe('MIDI');
    });
});

describe('trySymbolicJob', () => {
    it('accepts a matching MIDI, ingesting ScoreData + AlignmentMap + log', async () => {
        const bytes = midi();
        const logs: string[] = [];
        const result = await trySymbolicJob(Buffer.from('%PDF'), ctx, depsOf({
            client: {
                discover: async () => [mutopiaMid()],
                fetchBytes: async () => bytes,
            },
            log: (line) => logs.push(line),
        }));
        expect(result.kind).toBe('accept');
        if (result.kind !== 'accept') {
            return;
        }
        expect(result.source.tier).toBe('symbolic');
        expect(result.source.band).toBe('accept');
        expect(result.source.sourceName).toBe('Mutopia');
        expect(result.source.matchScore).toBe(100);
        expect(result.score.notes.length).toBeGreaterThan(0);
        expect(result.alignmentMap.entries.length).toBe(result.score.measures.length);
        expect(result.alignmentMap.bySrcIndex[0]?.page).toBe(0);
        const parsed = JSON.parse(result.logLine) as { band: string; engineSkipped: boolean; symbolicTier: number };
        expect(parsed.band).toBe('accept');
        expect(parsed.engineSkipped).toBe(true);
        expect(parsed.symbolicTier).toBe(1);
        expect(logs).toHaveLength(1);
    });

    it('falls through on ambiguous without ingesting', async () => {
        const bytes = midi();
        let ingested = 0;
        const result = await trySymbolicJob(Buffer.from('%PDF'), ctx, depsOf({
            client: {
                discover: async () => [
                    mutopiaMid(),
                    mutopiaMid({ url: 'https://example.test/other.mid', source: 'imslp', format: 'mid', priority: 3 }),
                ],
                fetchBytes: async () => bytes,
            },
            ingest: (decision, buf) => {
                ingested += 1;
                return ingestSymbolic(decision, buf);
            },
        }));
        expect(result.kind).toBe('fallthrough');
        if (result.kind !== 'fallthrough') {
            return;
        }
        expect(result.source.tier).toBe('omr');
        expect(result.source.band).toBe('ambiguous');
        expect(ingested).toBe(0);
        expect(JSON.parse(result.logLine).reason).toBe('ambiguous');
    });

    it('falls through on reject (arrangement) without ingesting', async () => {
        const bytes = midi();
        const result = await trySymbolicJob(Buffer.from('%PDF'), ctx, depsOf({
            client: {
                discover: async () => [mutopiaMid({ arrangement: true })],
                fetchBytes: async () => bytes,
            },
        }));
        expect(result.kind).toBe('fallthrough');
        if (result.kind !== 'fallthrough') {
            return;
        }
        expect(result.source.band).toBe('reject');
        expect(result.source.reason).toBe('arrangement');
    });

    it('maps ingest throw to parser_unusable → OMR', async () => {
        const bytes = midi();
        const result = await trySymbolicJob(Buffer.from('%PDF'), ctx, depsOf({
            client: {
                discover: async () => [mutopiaMid()],
                fetchBytes: async () => bytes,
            },
            ingest: () => {
                throw new Error('boom');
            },
        }));
        expect(result.kind).toBe('fallthrough');
        if (result.kind !== 'fallthrough') {
            return;
        }
        expect(result.source.reason).toBe('parser_unusable');
        expect(result.source.band).toBe('reject');
        expect(JSON.parse(result.logLine).engineSkipped).toBe(false);
    });

    it('maps ingest parser_unusable to OMR', async () => {
        const bytes = midi();
        const result = await trySymbolicJob(Buffer.from('%PDF'), ctx, depsOf({
            client: {
                discover: async () => [mutopiaMid()],
                fetchBytes: async () => bytes,
            },
            ingest: () => ({ ok: false, band: 'reject', reason: 'parser_unusable', score: null }),
        }));
        expect(result.kind).toBe('fallthrough');
        if (result.kind !== 'fallthrough') {
            return;
        }
        expect(result.source.reason).toBe('parser_unusable');
    });

    it('maps discover network failure to no_candidate', async () => {
        const result = await trySymbolicJob(Buffer.from('%PDF'), ctx, depsOf({
            client: {
                discover: async () => {
                    throw new Error('timeout mutopia index');
                },
                fetchBytes: async () => {
                    throw new Error('unreachable');
                },
            },
        }));
        expect(result.kind).toBe('fallthrough');
        if (result.kind !== 'fallthrough') {
            return;
        }
        expect(result.source.reason).toBe('no_candidate');
        expect(result.source.tier).toBe('omr');
    });

    it('maps fetchBytes failure of every candidate to no_candidate', async () => {
        const result = await trySymbolicJob(Buffer.from('%PDF'), ctx, depsOf({
            client: {
                discover: async () => [mutopiaMid()],
                fetchBytes: async () => {
                    throw new Error('GET failed');
                },
            },
        }));
        expect(result.kind).toBe('fallthrough');
        if (result.kind !== 'fallthrough') {
            return;
        }
        expect(result.source.reason).toBe('no_candidate');
    });

    it('discovers with the WorkKeyProvider hit when PDF text is unknown', async () => {
        const seen: WorkKey[] = [];
        const result = await trySymbolicJob(Buffer.from('%PDF'), {
            ...ctx,
            imslpPageTitle: 'Inventions, BWV 772 (Bach, Johann Sebastian)',
        }, depsOf({
            pdfSignals: async () => pdf({ workKey: { composerId: 'unknown', catalogType: 'Op', catalogN: 0 } }),
            client: {
                discover: async (key) => {
                    seen.push(key);
                    return [];
                },
                fetchBytes: async () => {
                    throw new Error('unused');
                },
            },
        }));
        expect(seen[0]).toEqual(WORK);
        expect(result.kind).toBe('fallthrough');
        if (result.kind !== 'fallthrough') {
            return;
        }
        expect(result.source.reason).toBe('no_candidate');
    });

    it('discovers with a filename WorkKey when PDF text is unknown', async () => {
        const seen: WorkKey[] = [];
        const result = await trySymbolicJob(Buffer.from('%PDF'), {
            ...ctx,
            filename: 'bach-invention-bwv772.pdf',
        }, depsOf({
            pdfSignals: async () => pdf({ workKey: { composerId: 'unknown', catalogType: 'Op', catalogN: 0 } }),
            client: {
                discover: async (key) => {
                    seen.push(key);
                    return [];
                },
                fetchBytes: async () => {
                    throw new Error('unused');
                },
            },
        }));
        expect(seen[0]).toEqual(WORK);
        expect(result.kind).toBe('fallthrough');
    });
});
