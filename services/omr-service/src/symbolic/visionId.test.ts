import { describe, expect, it } from 'vitest';

import { loadCorpusEntry } from '../eval/manifest.js';
import { parseMutopiaHtml } from './mutopia.js';
import {
    createGeminiCaller,
    identifyAndLookup,
    identifyPdfWorkKey,
    parseVisionJson,
    VISION_MODEL,
    workKeyFromMetadata,
    workKeyFromVisionJson,
    type VisionCaller,
} from './visionId.js';
import { workKeyFromText } from './workKey.js';

const PIN_SLUGS = [
    'czerny-op821-01',
    'bach-invention-01',
    'fur-elise-mutopia',
    'chopin-prelude-4',
    'gymnopedie-2',
] as const;

const mutopiaFixtureHtml = (): string => {
    const rows: string[] = [
        '<table><tr><th>Composer</th><th>Title</th><th>Instrument</th><th>Files</th></tr>',
    ];
    for (const slug of PIN_SLUGS) {
        const entry = loadCorpusEntry(slug);
        const midi = entry.reference.source === 'mutopia' ? entry.reference.url : '';
        const ly = midi.replace(/\.mid$/i, '.ly');
        rows.push(
            `<tr><td>${entry.title}</td><td>${entry.title}</td><td>Piano</td><td>` +
                `<a href="${entry.pdf.url}">pdf</a> ` +
                (midi !== '' ? `<a href="${midi}">mid</a> ` : '') +
                `<a href="${ly}">ly</a>` +
                `</td></tr>`,
        );
    }
    rows.push('</table>');
    return rows.join('\n');
};

const fakeCaller = (json: string, calls: string[]): VisionCaller => ({
    generateJson: async () => {
        calls.push('vision');
        return json;
    },
});

describe('workKeyFromMetadata ranks 1–3', () => {
    it('prefers IMSLP title over PDF text and filename', () => {
        const hit = workKeyFromMetadata({
            imslpTitle: 'Invention No. 1 in C major, BWV 772',
            pdfText: 'Für Elise, WoO 59',
            filename: 'chopin-op28-4.pdf',
        });
        expect(hit?.source).toBe('imslp');
        expect(hit?.workKey).toMatchObject({ composerId: 'bach', catalogType: 'BWV', catalogN: 772 });
    });

    it('uses PDF text when IMSLP is missing', () => {
        const hit = workKeyFromMetadata({
            pdfText: 'Chopin — Prelude in E minor, Op. 28 No. 4',
            filename: 'scan.pdf',
        });
        expect(hit?.source).toBe('pdf_text');
        expect(hit?.workKey).toEqual({
            composerId: 'chopin',
            catalogType: 'Op',
            catalogN: 28,
            movementIndex: 4,
        });
    });

    it('falls back to filename', () => {
        const hit = workKeyFromMetadata({ filename: 'Satie Gymnopédie No. 2.pdf' });
        expect(hit?.source).toBe('filename');
        expect(hit?.workKey).toEqual({ composerId: 'satie', catalogType: 'No', catalogN: 2 });
    });
});

describe('vision JSON → WorkKey', () => {
    it('parses a BWV invention payload', () => {
        const parsed = parseVisionJson(
            '{"title":"Invention No. 1","composer":"J.S. Bach","catalog":"BWV 772","confidence":0.92}',
        );
        expect(workKeyFromVisionJson(parsed)).toEqual({
            composerId: 'bach',
            catalogType: 'BWV',
            catalogN: 772,
        });
    });

    it('accepts a fenced JSON blob', () => {
        const parsed = parseVisionJson(
            '```json\n{"title":"Für Elise","composer":"Beethoven","catalog":"WoO 59","confidence":0.8}\n```',
        );
        expect(workKeyFromVisionJson(parsed)).toMatchObject({
            composerId: 'beethoven',
            catalogType: 'WoO',
            catalogN: 59,
        });
    });
});

describe('identifyPdfWorkKey', () => {
    it('does not call vision when IMSLP metadata already yields a WorkKey', async () => {
        const calls: string[] = [];
        const hit = await identifyPdfWorkKey({
            pdfBytes: Buffer.from('%PDF-1.4'),
            imslpTitle: 'Prelude in C major, BWV 846',
            caller: fakeCaller('{}', calls),
        });
        expect(calls).toEqual([]);
        expect(hit?.source).toBe('imslp');
        expect(hit?.workKey.catalogN).toBe(846);
    });

    it('calls vision when metadata is empty and maps the JSON to a WorkKey', async () => {
        const calls: string[] = [];
        const hit = await identifyPdfWorkKey({
            pdfBytes: Buffer.from('%PDF-1.4'),
            filename: 'upload.pdf',
            caller: fakeCaller(
                JSON.stringify({
                    title: 'Invention No. 1 in C major',
                    composer: 'Johann Sebastian Bach',
                    catalog: 'BWV 772',
                    confidence: 0.91,
                }),
                calls,
            ),
        });
        expect(calls).toEqual(['vision']);
        expect(hit?.source).toBe('vision');
        expect(hit?.model).toBe(VISION_MODEL);
        expect(hit?.workKey).toEqual({
            composerId: 'bach',
            catalogType: 'BWV',
            catalogN: 772,
        });
    });

    it('returns null when vision confidence is below the floor', async () => {
        const hit = await identifyPdfWorkKey({
            pdfBytes: Buffer.from('%PDF-1.4'),
            caller: fakeCaller(
                JSON.stringify({
                    title: 'unknown',
                    composer: 'unknown',
                    catalog: '',
                    confidence: 0.2,
                }),
                [],
            ),
        });
        expect(hit).toBeNull();
    });

    it('prefers vision over a weak filename hit', async () => {
        const hit = await identifyPdfWorkKey({
            pdfBytes: Buffer.from('%PDF-1.4'),
            filename: 'Satie Gymnopédie No. 1.pdf',
            caller: fakeCaller(
                JSON.stringify({
                    title: 'Gymnopédie No. 2',
                    composer: 'Erik Satie',
                    catalog: 'Gymnopédie No. 2',
                    confidence: 0.88,
                }),
                [],
            ),
        });
        expect(hit?.source).toBe('vision');
        expect(hit?.workKey).toEqual({ composerId: 'satie', catalogType: 'No', catalogN: 2 });
    });
});

describe('identifyAndLookup', () => {
    it('looks up Mutopia MIDI after a vision WorkKey', async () => {
        const entry = loadCorpusEntry('bach-invention-01');
        const midi = entry.reference.source === 'mutopia' ? entry.reference.url : '';
        const result = await identifyAndLookup({
            pdfBytes: Buffer.from('%PDF-1.4'),
            caller: fakeCaller(
                JSON.stringify({
                    title: entry.title,
                    composer: 'Bach',
                    catalog: 'BWV 772',
                    confidence: 0.95,
                }),
                [],
            ),
            mutopiaIndex: parseMutopiaHtml(mutopiaFixtureHtml()),
        });
        expect(result?.hit.workKey).toEqual(workKeyFromText(entry.title));
        expect(result?.candidates.some((c) => c.url === midi && c.format === 'mid')).toBe(true);
        expect(result?.candidates.some((c) => c.format === 'ly')).toBe(true);
    });
});

describe('createGeminiCaller', () => {
    it('POSTs PDF bytes to the Flash-Lite generateContent URL', async () => {
        const hits: Array<{ url: string; body: string }> = [];
        const caller = createGeminiCaller({
            apiKey: 'test-key',
            fetchImpl: (async (url, init) => {
                hits.push({ url: String(url), body: String(init?.body ?? '') });
                return new Response(
                    JSON.stringify({
                        candidates: [
                            {
                                content: {
                                    parts: [
                                        {
                                            text: JSON.stringify({
                                                title: 'x',
                                                composer: 'y',
                                                catalog: 'BWV 772',
                                                confidence: 1,
                                            }),
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }) as typeof fetch,
        });
        const text = await caller.generateJson(Buffer.from('pdf-bytes'), 'identify');
        expect(JSON.parse(text).catalog).toBe('BWV 772');
        expect(hits).toHaveLength(1);
        expect(hits[0]?.url).toContain('gemini-2.5-flash-lite:generateContent');
        expect(hits[0]?.url).toContain('key=test-key');
        const posted = JSON.parse(hits[0]?.body ?? '{}') as {
            contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }>;
        };
        expect(posted.contents[0]?.parts[0]?.inlineData?.mimeType).toBe('application/pdf');
        expect(posted.contents[0]?.parts[0]?.inlineData?.data).toBe(Buffer.from('pdf-bytes').toString('base64'));
    });
});
