import { describe, expect, it } from 'vitest';

import { loadCorpusEntry } from '../eval/manifest.js';
import { parseMutopiaHtml } from './mutopia.js';
import {
    createGeminiCaller,
    createGeminiCallerFromEnv,
    createVisionWorkKeyProvider,
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

    it('skips vision when the caller is absent and keeps filename metadata', async () => {
        const hit = await identifyPdfWorkKey({
            pdfBytes: Buffer.from('%PDF-1.4'),
            filename: 'Satie Gymnopédie No. 2.pdf',
        });
        expect(hit?.source).toBe('filename');
        expect(hit?.workKey).toEqual({ composerId: 'satie', catalogType: 'No', catalogN: 2 });
    });
});

describe('identifyAndLookup', () => {
    it('looks up Mutopia MIDI from an FTP directory listing', async () => {
        const pages: Record<string, string> = {
            'https://www.mutopiaproject.org/ftp/BachJS/BWV772/':
                '<a href="bach-invention-01/">bach-invention-01/</a>',
            'https://www.mutopiaproject.org/ftp/BachJS/BWV772/bach-invention-01/':
                '<a href="bach-invention-01.mid">mid</a><a href="bach-invention-01.ly">ly</a>',
        };
        const result = await identifyAndLookup({
            pdfBytes: Buffer.from('%PDF-1.4'),
            caller: fakeCaller(
                JSON.stringify({
                    title: 'Invention No. 1',
                    composer: 'Bach',
                    catalog: 'BWV 772',
                    confidence: 0.95,
                }),
                [],
            ),
            fetcher: {
                fetchText: async (url) => {
                    const html = pages[url];
                    if (html === undefined) {
                        throw new Error(`unexpected ${url}`);
                    }
                    return html;
                },
            },
        });
        expect(result?.candidates.some((c) => c.format === 'mid' && c.url.endsWith('bach-invention-01.mid'))).toBe(
            true,
        );
        expect(result?.candidates.some((c) => c.format === 'ly')).toBe(true);
    });

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
    const okBody = JSON.stringify({
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
    });

    it('POSTs PDF bytes to the Flash-Lite generateContent URL', async () => {
        const hits: Array<{ url: string; body: string }> = [];
        const caller = createGeminiCaller({
            apiKey: 'test-key',
            model: 'gemini-3.5-flash-lite',
            fetchImpl: (async (url, init) => {
                hits.push({ url: String(url), body: String(init?.body ?? '') });
                return new Response(okBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }) as typeof fetch,
        });
        const text = await caller.generateJson(Buffer.from('pdf-bytes'), 'identify');
        expect(JSON.parse(text).catalog).toBe('BWV 772');
        expect(hits).toHaveLength(1);
        expect(hits[0]?.url).toContain('gemini-3.5-flash-lite:generateContent');
        expect(hits[0]?.url).toContain('key=test-key');
        const posted = JSON.parse(hits[0]?.body ?? '{}') as {
            contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }>;
        };
        expect(posted.contents[0]?.parts[0]?.inlineData?.mimeType).toBe('application/pdf');
        expect(posted.contents[0]?.parts[0]?.inlineData?.data).toBe(Buffer.from('pdf-bytes').toString('base64'));
        expect(caller.lastModel?.()).toBe('gemini-3.5-flash-lite');
    });

    it('falls back from 3.1 to 3.5 when the cheaper model is 404/503', async () => {
        const models: string[] = [];
        const caller = createGeminiCaller({
            apiKey: 'test-key',
            fetchImpl: (async (url) => {
                const href = String(url);
                if (href.includes('gemini-3.1-flash-lite')) {
                    models.push('3.1');
                    return new Response(JSON.stringify({ error: { message: 'new users' } }), { status: 404 });
                }
                models.push('3.5');
                return new Response(okBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
            }) as typeof fetch,
        });
        await caller.generateJson(Buffer.from('pdf-bytes'), 'identify');
        expect(models).toEqual(['3.1', '3.5']);
        expect(caller.lastModel?.()).toBe('gemini-3.5-flash-lite');
    });
});

describe('vision skipped without a Gemini key', () => {
    it('createGeminiCallerFromEnv returns null when no key is set', () => {
        expect(createGeminiCallerFromEnv({})).toBeNull();
        expect(createGeminiCallerFromEnv({ GEMINI_API_KEY: '', GOOGLE_GENERATIVE_AI_API_KEY: '' })).toBeNull();
    });

    it('createVisionWorkKeyProvider(null) never calls Gemini', async () => {
        const hits = await createVisionWorkKeyProvider(null).identify({
            pdfBytes: Buffer.from('%PDF'),
            pdfTextWorkKey: { composerId: 'unknown', catalogType: 'Op', catalogN: 0 },
        });
        expect(hits).toEqual([]);
    });

    it('does not call vision when filename already yields a WorkKey', async () => {
        const calls: string[] = [];
        const hits = await createVisionWorkKeyProvider(fakeCaller('{}', calls)).identify({
            pdfBytes: Buffer.from('%PDF'),
            pdfTextWorkKey: { composerId: 'unknown', catalogType: 'Op', catalogN: 0 },
            filename: 'bach-invention-bwv772.pdf',
        });
        expect(calls).toEqual([]);
        expect(hits[0]?.source).toBe('filename');
    });

    it('proposes a vision WorkKey when ranks 1–3 are empty', async () => {
        const calls: string[] = [];
        const hits = await createVisionWorkKeyProvider(
            fakeCaller(
                JSON.stringify({
                    title: 'Invention No. 1',
                    composer: 'Bach',
                    catalog: 'BWV 772',
                    confidence: 0.9,
                }),
                calls,
            ),
        ).identify({
            pdfBytes: Buffer.from('%PDF'),
            pdfTextWorkKey: { composerId: 'unknown', catalogType: 'Op', catalogN: 0 },
        });
        expect(calls).toEqual(['vision']);
        expect(hits[0]?.source).toBe('vision');
        expect(hits[0]?.workKey).toEqual({ composerId: 'bach', catalogType: 'BWV', catalogN: 772 });
    });
});
