import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    GEMINI_MODEL_CANDIDATES,
    geminiApiKey,
    geminiGenerateText,
    geminiGenerateUrl,
    resetGeminiModelMemoryForTests,
} from '../../supabase/functions/_shared/gemini';
import { cleanTranscription, TRANSCRIBE_PROMPT, UNREADABLE } from '../../supabase/functions/_shared/transcription';
import { readCappedJson } from '../../supabase/functions/_shared/readCappedJson';

const IMAGE = { mimeType: 'image/jpeg', data: 'aW5r' };

const geminiOk = (text: string) =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

const geminiError = (status: number, message: string) =>
    new Response(JSON.stringify({ error: { message } }), { status });

describe('geminiApiKey', () => {
    it('prefers GEMINI_API_KEY, then the Google names, skipping empty values', () => {
        const env = (vars: Record<string, string | undefined>) => (name: string) => vars[name];
        expect(geminiApiKey(env({ GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'x' }))).toBe('g');
        expect(geminiApiKey(env({ GEMINI_API_KEY: '', GOOGLE_GENERATIVE_AI_API_KEY: 'gg' }))).toBe('gg');
        expect(geminiApiKey(env({ GOOGLE_API_KEY: 'x' }))).toBe('x');
        expect(geminiApiKey(env({}))).toBeUndefined();
    });
});

describe('geminiGenerateText', () => {
    beforeEach(() => {
        resetGeminiModelMemoryForTests();
    });

    it('tries the cheapest model first and sends the key as a header, not in the URL', async () => {
        const fetchImpl = vi.fn(async () => geminiOk('use wrist'));
        const result = await geminiGenerateText({ apiKey: 'secret', image: IMAGE, prompt: 'p', fetchImpl });
        expect(result).toEqual({ text: 'use wrist', model: 'gemini-3.1-flash-lite' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(geminiGenerateUrl(GEMINI_MODEL_CANDIDATES[0]));
        expect(url).not.toContain('secret');
        expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret');
        const body = JSON.parse(init.body as string);
        expect(body.contents[0].parts[0].inlineData).toEqual(IMAGE);
        expect(body.contents[0].parts[1].text).toBe('p');
        expect(body.generationConfig.temperature).toBe(0);
    });

    it('falls back to the next model on 404 / 503', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(geminiError(404, 'model not found for this key'))
            .mockResolvedValueOnce(geminiOk('rit.'));
        const result = await geminiGenerateText({ apiKey: 'k', image: IMAGE, prompt: 'p', fetchImpl });
        expect(result).toEqual({ text: 'rit.', model: 'gemini-3.5-flash-lite' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect((fetchImpl.mock.calls[1] as unknown as [string])[0]).toContain('gemini-3.5-flash-lite');
    });

    it('does not fall back on other failures (bad key, quota) — throws at once', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(geminiError(403, 'API key not valid'));
        await expect(geminiGenerateText({ apiKey: 'k', image: IMAGE, prompt: 'p', fetchImpl })).rejects.toThrow(
            /403 API key not valid/,
        );
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('throws when every candidate is unavailable', async () => {
        const fetchImpl = vi.fn(async () => geminiError(503, 'overloaded'));
        await expect(geminiGenerateText({ apiKey: 'k', image: IMAGE, prompt: 'p', fetchImpl })).rejects.toThrow(
            /gemini-3.5-flash-lite failed: 503/,
        );
        expect(fetchImpl).toHaveBeenCalledTimes(GEMINI_MODEL_CANDIDATES.length);
    });

    it('skips a 404 model on the next call and prefers the last 2xx model', async () => {
        const first = vi
            .fn()
            .mockResolvedValueOnce(geminiError(404, 'model not found for this key'))
            .mockResolvedValueOnce(geminiOk('rit.'));
        await geminiGenerateText({ apiKey: 'k', image: IMAGE, prompt: 'p', fetchImpl: first });

        const second = vi.fn(async () => geminiOk('use wrist'));
        const result = await geminiGenerateText({ apiKey: 'k', image: IMAGE, prompt: 'p', fetchImpl: second });
        expect(result).toEqual({ text: 'use wrist', model: 'gemini-3.5-flash-lite' });
        expect(second).toHaveBeenCalledTimes(1);
        expect((second.mock.calls[0] as unknown as [string])[0]).toContain('gemini-3.5-flash-lite');
    });
});

describe('cleanTranscription', () => {
    it('keeps a short note as written, dropping wrapping quotes and extra lines', () => {
        expect(cleanTranscription('  use wrist  ')).toBe('use wrist');
        expect(cleanTranscription('"rit."')).toBe('rit.');
        expect(cleanTranscription('slow here\nand more')).toBe('slow here');
    });

    it('returns null for the unreadable sentinel, empty output, or a rambling answer', () => {
        expect(cleanTranscription(UNREADABLE)).toBeNull();
        expect(cleanTranscription('   ')).toBeNull();
        expect(cleanTranscription('x'.repeat(81))).toBeNull();
    });

    it('asks for text only and tells the model how to abstain', () => {
        expect(TRANSCRIBE_PROMPT).toMatch(/text only/i);
        expect(TRANSCRIBE_PROMPT).toContain(`return exactly ${UNREADABLE}`);
    });
});

describe('readCappedJson', () => {
    it('rejects a body larger than the cap even when Content-Length is missing or understated', async () => {
        const big = 'x'.repeat(80);
        const understated = new Request('https://example.test', {
            method: 'POST',
            headers: { 'content-length': '4' },
            body: JSON.stringify({ a: big }),
        });
        expect(await readCappedJson(understated, 20)).toEqual({ ok: false, status: 413 });

        const missing = new Request('https://example.test', {
            method: 'POST',
            body: JSON.stringify({ a: big }),
        });
        expect(await readCappedJson(missing, 20)).toEqual({ ok: false, status: 413 });
    });

    it('parses a JSON body under the cap', async () => {
        const req = new Request('https://example.test', {
            method: 'POST',
            body: JSON.stringify({ documentId: 'd' }),
        });
        expect(await readCappedJson<{ documentId: string }>(req, 1024)).toEqual({
            ok: true,
            value: { documentId: 'd' },
        });
    });
});
