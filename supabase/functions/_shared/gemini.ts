/**
 * Gemini (generativelanguage.googleapis.com) text generation for Edge
 * Functions. Key and model handling mirror services/omr-service
 * `symbolic/visionId.ts`: several accepted env names, cheapest-first model
 * candidates with fallback on 404/503 (new API keys cannot call every
 * Flash-Lite generation). No Deno globals here so the module unit-tests
 * under vitest; callers pass an env getter and (optionally) a fetch.
 */

export const GEMINI_KEY_NAMES = ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'] as const;

/** First configured key wins, in GEMINI_KEY_NAMES order. */
export const geminiApiKey = (get: (name: string) => string | undefined): string | undefined => {
    for (const name of GEMINI_KEY_NAMES) {
        const value = get(name);
        if (value !== undefined && value !== '') {
            return value;
        }
    }
    return undefined;
};

/** Cheapest-first; 3.5 is what Google routes new users to and is the reliable fallback. */
export const GEMINI_MODEL_CANDIDATES = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'] as const;

export interface GeminiInlineImage {
    mimeType: string;
    /** Base64 without a data: prefix. */
    data: string;
}

interface GeminiPart {
    text?: string;
}

interface GeminiResponse {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    error?: { message?: string };
}

const parseGeminiText = (body: GeminiResponse): string =>
    (body.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();

const fallbackableStatus = (status: number): boolean => status === 404 || status === 503;

const isAbortLike = (err: unknown): boolean =>
    err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** Last model that returned 2xx in this isolate — skip a 404 candidate next time. */
let lastOkModel: string | null = null;
const notFoundModels = new Set<string>();

const candidateOrder = (models: readonly string[]): string[] => {
    const available = models.filter((model) => !notFoundModels.has(model));
    const pool = available.length > 0 ? [...available] : [...models];
    if (lastOkModel && pool.includes(lastOkModel)) {
        return [lastOkModel, ...pool.filter((model) => model !== lastOkModel)];
    }
    return pool;
};

/** Test hook — sticky memory is process-local and would leak across cases. */
export const resetGeminiModelMemoryForTests = (): void => {
    lastOkModel = null;
    notFoundModels.clear();
};

export const geminiGenerateUrl = (model: string): string =>
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const generateOnce = async (
    fetchImpl: typeof fetch,
    apiKey: string,
    model: string,
    image: GeminiInlineImage,
    prompt: string,
    signal: AbortSignal | undefined,
): Promise<{ text: string; status: number; errorText: string }> => {
    let res: Response;
    try {
        res = await fetchImpl(geminiGenerateUrl(model), {
            method: 'POST',
            signal,
            // Header, not `?key=` — keeps the secret out of URLs and access logs.
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
                contents: [
                    {
                        role: 'user',
                        parts: [{ inlineData: { mimeType: image.mimeType, data: image.data } }, { text: prompt }],
                    },
                ],
                generationConfig: { temperature: 0, maxOutputTokens: 64 },
            }),
        });
    } catch (err) {
        if (isAbortLike(err)) {
            return { text: '', status: 503, errorText: 'timed out' };
        }
        throw err;
    }
    const raw = await res.text();
    if (!res.ok) {
        let message = raw.slice(0, 200);
        try {
            message = (JSON.parse(raw) as GeminiResponse).error?.message ?? message;
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
    return { text: parseGeminiText(body), status: res.status, errorText: '' };
};

/**
 * Ask Gemini for plain text about one image, trying each model candidate in
 * turn while the failure is a 404/503. Any other HTTP failure throws at once.
 * Remembers the last 2xx model in this isolate and skips a candidate after
 * 404 (new keys often cannot call 3.1).
 */
export const geminiGenerateText = async (input: {
    apiKey: string;
    image: GeminiInlineImage;
    prompt: string;
    models?: readonly string[];
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
}): Promise<{ text: string; model: string }> => {
    const fetchImpl = input.fetchImpl ?? fetch;
    const models = candidateOrder(input.models ?? GEMINI_MODEL_CANDIDATES);
    let lastError = 'Gemini returned no model';
    for (const model of models) {
        const once = await generateOnce(fetchImpl, input.apiKey, model, input.image, input.prompt, input.signal);
        if (once.status >= 200 && once.status < 300) {
            lastOkModel = model;
            return { text: once.text, model };
        }
        lastError = `Gemini ${model} failed: ${once.status} ${once.errorText}`;
        if (once.status === 404) {
            notFoundModels.add(model);
        }
        if (!fallbackableStatus(once.status)) {
            throw new Error(lastError);
        }
    }
    throw new Error(lastError);
};
