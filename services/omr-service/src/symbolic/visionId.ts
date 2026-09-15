import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { discoverCandidates } from './discover.js';
import { MUTOPIA_PIECE_LIST_URL, type TextFetcher } from './http.js';
import { parseMutopiaHtml, type MutopiaPiece } from './mutopia.js';
import type { RankedCandidate, WorkKey } from './types.js';
import { workKeyFromText } from './workKey.js';

/** Cheapest live Gemini vision+PDF model as of 2026-09-15. */
export const VISION_MODEL = 'gemini-2.5-flash-lite';

export const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent`;

export const VISION_CONFIDENCE_FLOOR = 0.5;

export type WorkKeySource = 'imslp' | 'pdf_text' | 'filename' | 'vision';

export interface VisionCaller {
    generateJson: (pdfBytes: Buffer, prompt: string) => Promise<string>;
}

export interface WorkKeyHit {
    workKey: WorkKey;
    source: WorkKeySource;
    title?: string;
    composer?: string;
    catalog?: string;
    confidence: number;
    model?: string;
}

export interface IdentifyLookupResult {
    hit: WorkKeyHit;
    candidates: RankedCandidate[];
}

const IDENTIFY_PROMPT = [
    'This is a piano sheet-music PDF. Identify the work from PAGE 1 only',
    '(title header, composer, opus/catalog). Ignore later pages.',
    'Return JSON with keys: title, composer, catalog, confidence.',
    'catalog is a compact token such as "BWV 772", "Op. 28 No. 4", "WoO 59",',
    '"K. 545", "Gymnopédie No. 2". Empty string if unknown.',
    'confidence is 0 to 1. If it is not clearly identifiable, use confidence 0',
    'and empty catalog.',
].join(' ');

const IDENTIFY_SCHEMA = {
    type: 'OBJECT',
    properties: {
        title: { type: 'STRING' },
        composer: { type: 'STRING' },
        catalog: { type: 'STRING' },
        confidence: { type: 'NUMBER' },
    },
    required: ['title', 'composer', 'catalog', 'confidence'],
} as const;

export const geminiApiKeyFromEnv = (
    env: NodeJS.ProcessEnv = process.env,
): string | undefined =>
    env.GEMINI_API_KEY ?? env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GOOGLE_API_KEY;

const KEY_NAMES = ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'] as const;

const takeKeyFromDotenv = (contents: string, env: NodeJS.ProcessEnv): void => {
    for (const line of contents.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) {
            continue;
        }
        const eq = trimmed.indexOf('=');
        if (eq < 1) {
            continue;
        }
        const name = trimmed.slice(0, eq).trim();
        if (!KEY_NAMES.includes(name as (typeof KEY_NAMES)[number])) {
            continue;
        }
        if (env[name] !== undefined && env[name] !== '') {
            continue;
        }
        let value = trimmed.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        env[name] = value;
    }
};

/** Load a gitignored .env if the process has no Gemini key yet. */
export const hydrateGeminiKeyFromFiles = (
    cwd: string = process.cwd(),
    env: NodeJS.ProcessEnv = process.env,
): void => {
    if (geminiApiKeyFromEnv(env) !== undefined) {
        return;
    }
    const files = [
        join(cwd, '.env'),
        join(cwd, 'services/omr-service/.env'),
        join(cwd, '.env.local'),
        join(cwd, '../.env.local'),
    ];
    for (const file of files) {
        if (!existsSync(file)) {
            continue;
        }
        takeKeyFromDotenv(readFileSync(file, 'utf8'), env);
        if (geminiApiKeyFromEnv(env) !== undefined) {
            return;
        }
    }
};

interface GeminiPart {
    text?: string;
}

interface GeminiResponse {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    error?: { message?: string };
}

const parseGeminiText = (body: GeminiResponse): string => {
    const parts = body.candidates?.[0]?.content?.parts ?? [];
    return parts
        .map((p) => p.text ?? '')
        .join('')
        .trim();
};

export const createGeminiCaller = (input: {
    apiKey: string;
    fetchImpl?: typeof fetch;
    model?: string;
}): VisionCaller => {
    const fetchImpl = input.fetchImpl ?? fetch;
    const model = input.model ?? VISION_MODEL;
    return {
        async generateJson(pdfBytes: Buffer, prompt: string): Promise<string> {
            const url =
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
                `?key=${encodeURIComponent(input.apiKey)}`;
            const res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [
                        {
                            role: 'user',
                            parts: [
                                {
                                    inlineData: {
                                        mimeType: 'application/pdf',
                                        data: pdfBytes.toString('base64'),
                                    },
                                },
                                { text: prompt },
                            ],
                        },
                    ],
                    generationConfig: {
                        temperature: 0,
                        responseMimeType: 'application/json',
                        responseSchema: IDENTIFY_SCHEMA,
                    },
                }),
            });
            const raw = await res.text();
            let body: GeminiResponse;
            try {
                body = JSON.parse(raw) as GeminiResponse;
            } catch {
                throw new Error(`Gemini ${model} returned non-JSON: ${res.status} ${raw.slice(0, 200)}`);
            }
            if (!res.ok) {
                throw new Error(`Gemini ${model} failed: ${res.status} ${body.error?.message ?? raw.slice(0, 200)}`);
            }
            const text = parseGeminiText(body);
            if (text === '') {
                throw new Error(`Gemini ${model} returned empty content`);
            }
            return text;
        },
    };
};

export const createGeminiCallerFromEnv = (env: NodeJS.ProcessEnv = process.env): VisionCaller => {
    const key = geminiApiKeyFromEnv(env);
    if (key === undefined || key === '') {
        throw new Error(
            'Set GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY for symbolic vision identify',
        );
    }
    return createGeminiCaller({ apiKey: key });
};

interface VisionJson {
    title?: unknown;
    composer?: unknown;
    catalog?: unknown;
    confidence?: unknown;
}

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asConfidence = (value: unknown): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
};

export const parseVisionJson = (raw: string): VisionJson => {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    const jsonText = fenced?.[1]?.trim() ?? trimmed;
    return JSON.parse(jsonText) as VisionJson;
};

export const workKeyFromVisionJson = (parsed: VisionJson): WorkKey | null => {
    const title = asString(parsed.title);
    const composer = asString(parsed.composer);
    const catalog = asString(parsed.catalog);
    return workKeyFromText([composer, title, catalog].filter((s) => s !== '').join(' '));
};

/**
 * Ranks 1–3 of symbolic-first metadata. Vision is rank 4 and is not called here.
 */
export const workKeyFromMetadata = (input: {
    imslpTitle?: string;
    pdfText?: string;
    filename?: string;
}): WorkKeyHit | null => {
    const imslp = input.imslpTitle?.trim();
    if (imslp) {
        const key = workKeyFromText(imslp);
        if (key) {
            return { workKey: key, source: 'imslp', title: imslp, confidence: 1 };
        }
    }
    const pdfText = input.pdfText?.trim();
    if (pdfText) {
        const key = workKeyFromText(pdfText);
        if (key) {
            return { workKey: key, source: 'pdf_text', confidence: 1 };
        }
    }
    const filename = input.filename?.trim();
    if (filename) {
        const key = workKeyFromText(filename);
        if (key) {
            return { workKey: key, source: 'filename', confidence: 0.4 };
        }
    }
    return null;
};

export const identifyPdfWorkKey = async (input: {
    pdfBytes: Buffer;
    imslpTitle?: string;
    pdfText?: string;
    filename?: string;
    caller: VisionCaller;
    prompt?: string;
}): Promise<WorkKeyHit | null> => {
    const ranked = workKeyFromMetadata(input);
    if (ranked && ranked.source !== 'filename') {
        return ranked;
    }
    const raw = await input.caller.generateJson(input.pdfBytes, input.prompt ?? IDENTIFY_PROMPT);
    const parsed = parseVisionJson(raw);
    const confidence = asConfidence(parsed.confidence);
    if (confidence < VISION_CONFIDENCE_FLOOR) {
        return ranked;
    }
    const workKey = workKeyFromVisionJson(parsed);
    if (!workKey) {
        return ranked;
    }
    const hit: WorkKeyHit = {
        workKey,
        source: 'vision',
        confidence,
        model: VISION_MODEL,
    };
    const title = asString(parsed.title);
    const composer = asString(parsed.composer);
    const catalog = asString(parsed.catalog);
    if (title !== '') {
        hit.title = title;
    }
    if (composer !== '') {
        hit.composer = composer;
    }
    if (catalog !== '') {
        hit.catalog = catalog;
    }
    return hit;
};

export const identifyAndLookup = async (input: {
    pdfBytes: Buffer;
    imslpTitle?: string;
    pdfText?: string;
    filename?: string;
    caller: VisionCaller;
    mutopiaIndex?: readonly MutopiaPiece[];
    mutopiaHtml?: string;
    fetcher?: TextFetcher;
}): Promise<IdentifyLookupResult | null> => {
    const hit = await identifyPdfWorkKey(input);
    if (!hit) {
        return null;
    }
    let index = input.mutopiaIndex;
    if (index === undefined) {
        const html =
            input.mutopiaHtml ??
            (input.fetcher !== undefined ? await input.fetcher.fetchText(MUTOPIA_PIECE_LIST_URL) : undefined);
        index = html === undefined ? [] : parseMutopiaHtml(html);
    }
    const candidates = discoverCandidates({
        workKey: hit.workKey,
        imslpPageTitle: input.imslpTitle,
        mutopiaIndex: index,
        imslpFiles: [],
    });
    return { hit, candidates };
};

export const filenameOf = (pdfPath: string): string => basename(pdfPath);
