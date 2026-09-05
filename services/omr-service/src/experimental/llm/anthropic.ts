import { setTimeout as sleep } from 'node:timers/promises';

import type { SpendLedger } from './ledger.js';
import { type LedgerEntry, type LlmUsage, ResponseCache, requestHash } from './ledger.js';
import { type PromptContext, SYSTEM_PROMPT, userPrompt } from './prompt.js';
import { type LlmPageTranscription, TRANSCRIBE_TOOL } from './schema.js';

/**
 * Anthropic Messages API client for the transcription tool. Plain fetch (the
 * service has no SDK dependency); same request shape as
 * supabase/functions/analyze-notes (strict tool use + output_config.effort).
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, Sep 2026). */
export const PRICES_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> =
    {
        'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
        'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    };

export const DEFAULT_MODEL = process.env.LLM_NOTES_MODEL ?? 'claude-sonnet-5';

export type Effort = 'low' | 'medium' | 'high';

export interface TranscribeImageRequest {
    imagePng: Buffer;
    context: PromptContext;
    model?: string;
    effort?: Effort;
    maxOutputTokens?: number;
}

export interface TranscribeImageResult {
    transcription: LlmPageTranscription;
    usage: LlmUsage;
    model: string;
    ms: number;
    cached: boolean;
    stopReason: string;
}

export interface AnthropicClientOptions {
    apiKey?: string;
    ledger: SpendLedger;
    cache?: ResponseCache;
    timeoutMs?: number;
    maxAttempts?: number;
    log?: (line: string) => void;
}

interface ApiUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

interface ApiResponse {
    stop_reason?: string;
    content?: Array<{ type: string; name?: string; input?: unknown; text?: string }>;
    usage?: ApiUsage;
    error?: { type?: string; message?: string };
}

interface CachedCall {
    transcription: LlmPageTranscription;
    usage: LlmUsage;
    model: string;
    ms: number;
    stopReason: string;
}

export class LlmResponseError extends Error {
    readonly code = 'llm_bad_response';
    constructor(
        message: string,
        readonly usage: LlmUsage | null = null,
    ) {
        super(message);
    }
}

export const usdFor = (model: string, usage: Omit<LlmUsage, 'usd'>): number => {
    const price = PRICES_PER_MTOK[model];
    if (!price) {
        return 0;
    }
    return (
        (usage.inputTokens * price.input +
            usage.outputTokens * price.output +
            usage.cacheReadTokens * price.cacheRead +
            usage.cacheWriteTokens * price.cacheWrite) /
        1_000_000
    );
};

const toUsage = (model: string, raw: ApiUsage | undefined): LlmUsage => {
    const base = {
        inputTokens: raw?.input_tokens ?? 0,
        outputTokens: raw?.output_tokens ?? 0,
        cacheReadTokens: raw?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: raw?.cache_creation_input_tokens ?? 0,
    };
    return { ...base, usd: usdFor(model, base) };
};

export class AnthropicTranscriber {
    private readonly apiKey: string;
    readonly ledger: SpendLedger;
    private readonly cache: ResponseCache;
    private readonly timeoutMs: number;
    private readonly maxAttempts: number;
    private readonly log: (line: string) => void;

    constructor(options: AnthropicClientOptions) {
        const key = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
        if (!key) {
            throw new Error('ANTHROPIC_API_KEY is not set');
        }
        this.apiKey = key;
        this.ledger = options.ledger;
        this.cache = options.cache ?? new ResponseCache(null);
        this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
        this.maxAttempts = options.maxAttempts ?? 4;
        this.log = options.log ?? (() => {});
    }

    async transcribe(req: TranscribeImageRequest): Promise<TranscribeImageResult> {
        const model = req.model ?? DEFAULT_MODEL;
        const effort = req.effort ?? 'medium';
        const maxTokens = req.maxOutputTokens ?? 16_000;
        const user = userPrompt(req.context);
        const body = {
            model,
            max_tokens: maxTokens,
            output_config: { effort },
            system: SYSTEM_PROMPT,
            tools: [TRANSCRIBE_TOOL],
            tool_choice: { type: 'tool', name: TRANSCRIBE_TOOL.name },
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: { type: 'base64', media_type: 'image/png', data: req.imagePng.toString('base64') },
                        },
                        { type: 'text', text: user },
                    ],
                },
            ],
        };
        const key = requestHash([
            model,
            effort,
            String(maxTokens),
            SYSTEM_PROMPT,
            JSON.stringify(TRANSCRIBE_TOOL),
            user,
            req.imagePng,
        ]);
        const hit = await this.cache.get<CachedCall>(key);
        if (hit) {
            await this.ledger.record({
                ...hit.usage,
                at: new Date().toISOString(),
                model,
                label: req.context.label,
                ms: 0,
                cached: true,
            });
            return { ...hit, cached: true };
        }

        await this.ledger.reserve();
        try {
            const t0 = Date.now();
            const response = await this.post(body, req.context.label);
            const ms = Date.now() - t0;
            const usage = toUsage(model, response.usage);
            const entry: LedgerEntry = {
                ...usage,
                at: new Date().toISOString(),
                model,
                label: req.context.label,
                ms,
                cached: false,
            };
            await this.ledger.record(entry);
            this.log(
                `[llm] ${req.context.label}: ${ms}ms in=${usage.inputTokens} out=${usage.outputTokens} $${usage.usd.toFixed(4)} stop=${response.stop_reason ?? '?'}`,
            );
            const stopReason = response.stop_reason ?? 'unknown';
            if (stopReason === 'max_tokens') {
                throw new LlmResponseError(`Output truncated at ${maxTokens} tokens (${req.context.label})`, usage);
            }
            const tool = response.content?.find((c) => c.type === 'tool_use' && c.name === TRANSCRIBE_TOOL.name);
            if (!tool || typeof tool.input !== 'object' || tool.input === null) {
                throw new LlmResponseError(
                    `No ${TRANSCRIBE_TOOL.name} tool call in response (${req.context.label})`,
                    usage,
                );
            }
            const transcription = tool.input as LlmPageTranscription;
            if (!Array.isArray(transcription.systems)) {
                throw new LlmResponseError(`Tool input lacks systems[] (${req.context.label})`, usage);
            }
            const result: CachedCall = { transcription, usage, model, ms, stopReason };
            await this.cache.put(key, result);
            return { ...result, cached: false };
        } finally {
            this.ledger.release();
        }
    }

    private async post(body: unknown, label: string): Promise<ApiResponse> {
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);
            try {
                const res = await fetch(API_URL, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': this.apiKey,
                        'anthropic-version': API_VERSION,
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                const text = await res.text();
                if (res.ok) {
                    return JSON.parse(text) as ApiResponse;
                }
                const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
                lastError = new Error(`Anthropic ${res.status} (${label}): ${text.slice(0, 300)}`);
                if (!retryable) {
                    throw lastError;
                }
                const retryAfter = Number(res.headers.get('retry-after'));
                const waitMs =
                    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** (attempt - 1);
                this.log(`[llm] ${label}: ${res.status}, retry ${attempt}/${this.maxAttempts} in ${waitMs}ms`);
                await sleep(waitMs);
            } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') {
                    lastError = new Error(`Anthropic request timed out after ${this.timeoutMs}ms (${label})`);
                } else if (error === lastError) {
                    throw error;
                } else {
                    lastError = error instanceof Error ? error : new Error(String(error));
                }
                if (attempt < this.maxAttempts) {
                    await sleep(2000 * 2 ** (attempt - 1));
                }
            } finally {
                clearTimeout(timer);
            }
        }
        throw lastError ?? new Error(`Anthropic request failed (${label})`);
    }
}
