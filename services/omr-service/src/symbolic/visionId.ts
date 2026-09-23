import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { discoverCandidates } from './discover.js';
import type { TextFetcher } from './http.js';
import { harvestMutopiaFtp, parseMutopiaHtml, type MutopiaPiece } from './mutopia.js';
import type { RankedCandidate, WorkKey } from './types.js';
import { workKeyFromText } from './workKey.js';
import {
    pdfTextWorkKeyProvider,
    WORK_KEY_SOURCE_RANK,
    workKeyFromMetadata,
    type IdentifyWorkInput,
    type WorkKeyHit,
    type WorkKeyProvider,
    type WorkKeySource,
} from './workKeyProvider.js';

export { workKeyFromMetadata, type WorkKeyHit, type WorkKeySource };

/**
 * Cheapest-first Gemini vision+PDF models. New API keys cannot call
 * gemini-2.5-flash-lite (404). 3.1 is cheaper; 3.5 is what Google routes
 * new users to and is the reliable fallback.
 */
export const VISION_MODEL_CANDIDATES = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'] as const;

export const VISION_MODEL = 'gemini-3.5-flash-lite';

export const GEMINI_GENERATE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent`;

export const VISION_CONFIDENCE_FLOOR = 0.5;

export interface VisionCaller {
    generateJson: (pdfBytes: Buffer, prompt: string) => Promise<string>;
    lastModel?: () => string | undefined;
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

const fallbackableStatus = (status: number): boolean => status === 404 || status === 503;

const generateOnce = async (
    fetchImpl: typeof fetch,
    apiKey: string,
    model: string,
    pdfBytes: Buffer,
    prompt: string,
): Promise<{ text: string; status: number; errorText: string }> => {
    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
        `?key=${encodeURIComponent(apiKey)}`;
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
    if (!res.ok) {
        let message = raw.slice(0, 200);
        try {
            const body = JSON.parse(raw) as GeminiResponse;
            message = body.error?.message ?? message;
        } catch {
            // keep slice
        }
        return { text: '', status: res.status, errorText: message };
    }
    let body: GeminiResponse;
    try {
        body = JSON.parse(raw) as GeminiResponse;
    } catch {
        throw new Error(`Gemini ${model} returned non-JSON: ${res.status} ${raw.slice(0, 200)}`);
    }
    const text = parseGeminiText(body);
    if (text === '') {
        throw new Error(`Gemini ${model} returned empty content`);
    }
    return { text, status: res.status, errorText: '' };
};

export const createGeminiCaller = (input: {
    apiKey: string;
    fetchImpl?: typeof fetch;
    model?: string;
    models?: readonly string[];
}): VisionCaller => {
    const fetchImpl = input.fetchImpl ?? fetch;
    const models =
        input.models ??
        (input.model !== undefined ? [input.model] : [...VISION_MODEL_CANDIDATES]);
    let used: string | undefined;
    return {
        lastModel: () => used,
        async generateJson(pdfBytes: Buffer, prompt: string): Promise<string> {
            let lastError = 'Gemini returned no model';
            for (const model of models) {
                const once = await generateOnce(fetchImpl, input.apiKey, model, pdfBytes, prompt);
                if (once.text !== '') {
                    used = model;
                    return once.text;
                }
                lastError = `Gemini ${model} failed: ${once.status} ${once.errorText}`;
                if (!fallbackableStatus(once.status)) {
                    throw new Error(lastError);
                }
            }
            throw new Error(lastError);
        },
    };
};

export const createGeminiCallerFromEnv = (env: NodeJS.ProcessEnv = process.env): VisionCaller | null => {
    const key = geminiApiKeyFromEnv(env);
    if (key === undefined || key === '') {
        return null;
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

const visionHitFromJson = (raw: string, model: string): WorkKeyHit | null => {
    const parsed = parseVisionJson(raw);
    const confidence = asConfidence(parsed.confidence);
    if (confidence < VISION_CONFIDENCE_FLOOR) {
        return null;
    }
    const workKey = workKeyFromVisionJson(parsed);
    if (!workKey) {
        return null;
    }
    const hit: WorkKeyHit = {
        workKey,
        source: 'vision',
        confidence,
        model,
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

/**
 * Ranks 1–2 skip vision. Filename is rank 3 but never sufficient alone, so a
 * confident vision hit may replace it. With no caller (no API key) this
 * returns metadata only.
 */
export const identifyPdfWorkKey = async (input: {
    pdfBytes: Buffer;
    imslpTitle?: string;
    pdfText?: string;
    filename?: string;
    caller?: VisionCaller | null;
    prompt?: string;
}): Promise<WorkKeyHit | null> => {
    const ranked = workKeyFromMetadata(input);
    if (ranked && ranked.source !== 'filename') {
        return ranked;
    }
    if (!input.caller) {
        return ranked;
    }
    const raw = await input.caller.generateJson(input.pdfBytes, input.prompt ?? IDENTIFY_PROMPT);
    return visionHitFromJson(raw, input.caller.lastModel?.() ?? VISION_MODEL) ?? ranked;
};

/**
 * Job seam: ranks 1–3 from `pdfTextWorkKeyProvider`, then rank 4 vision only
 * when those are empty. A missing caller (no Gemini key) is a no-op.
 * Vision proposes a WorkKey; ingest still goes through symbolicMatchScore.
 */
export const createVisionWorkKeyProvider = (caller: VisionCaller | null): WorkKeyProvider => ({
    identify: async (input: IdentifyWorkInput) => {
        const hits = await pdfTextWorkKeyProvider.identify(input);
        if (hits.length > 0 || caller === null) {
            return hits;
        }
        try {
            const raw = await caller.generateJson(input.pdfBytes, IDENTIFY_PROMPT);
            const hit = visionHitFromJson(raw, caller.lastModel?.() ?? VISION_MODEL);
            if (hit) {
                hits.push(hit);
            }
        } catch {
            // Network / API failure → ranks 1–3 only (often empty → OMR).
        }
        return hits.sort(
            (a, b) =>
                WORK_KEY_SOURCE_RANK[a.source] - WORK_KEY_SOURCE_RANK[b.source] ||
                b.confidence - a.confidence,
        );
    },
});

export const identifyAndLookup = async (input: {
    pdfBytes: Buffer;
    imslpTitle?: string;
    pdfText?: string;
    filename?: string;
    caller?: VisionCaller | null;
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
        if (input.mutopiaHtml !== undefined) {
            index = parseMutopiaHtml(input.mutopiaHtml);
        } else if (input.fetcher !== undefined) {
            const fetcher = input.fetcher;
            index = await harvestMutopiaFtp((url) => fetcher.fetchText(url), hit.workKey);
        } else {
            index = [];
        }
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
