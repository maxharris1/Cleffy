import { describe, expect, it, vi } from 'vitest';

import {
    VIEW_ENDPOINT,
    loadViewPdf,
    mergeAnnotations,
    pollView,
    visibleMarks,
    type ViewMark,
    type ViewTombstone,
} from '@/view/viewLinkClient';
import { tokenFromHash, viewLinkUrl } from '@/view/viewToken';

const TOKEN = 'T'.repeat(40) + '-_9';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const mark = (id: string, seq: number, overrides: Partial<ViewMark> = {}): ViewMark => ({
    id,
    page: 0,
    kind: 'stroke',
    color: '#000',
    payload: { pts: [0, 0, 1], w: 0.01 },
    seq,
    deleted: false,
    ...overrides,
});

/** What the server sends for an erased mark: id and seq, nothing else. */
const tomb = (id: string, seq: number): ViewTombstone => ({ id, seq, deleted: true });

describe('the token', () => {
    it('is read from the fragment only', () => {
        expect(tokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
        expect(tokenFromHash('')).toBeNull();
        expect(tokenFromHash('#short')).toBeNull();
        expect(tokenFromHash(`#${TOKEN}&x=1`)).toBeNull();
    });

    it('makes /v#<token> links', () => {
        expect(viewLinkUrl('https://cleffy.io', TOKEN)).toBe(`https://cleffy.io/v#${TOKEN}`);
    });
});

describe('pollView', () => {
    it('POSTs the token in the body, never in the URL, with no credentials or referrer', async () => {
        const fetchImpl = vi.fn(async () =>
            json({ doc: { pages: 1, pdf_rev: 0 }, pdf: 'proxy', annotations: [], max_seq: 0, more: false }),
        );
        await pollView(TOKEN, 5, fetchImpl);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(VIEW_ENDPOINT);
        expect(url).not.toContain(TOKEN);
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN, since: 5 });
        expect(init.credentials).toBe('omit');
        expect(init.referrerPolicy).toBe('no-referrer');
        expect(init.cache).toBe('no-store');
        expect(JSON.stringify(init.headers)).not.toContain(TOKEN);
    });

    it('reads 410 as gone', async () => {
        expect(await pollView(TOKEN, 0, async () => json({ gone: true }, 410))).toEqual({ kind: 'gone' });
    });

    it('reads 404 as not available (switched off)', async () => {
        expect(await pollView(TOKEN, 0, async () => new Response('', { status: 404 }))).toEqual({
            kind: 'unavailable',
        });
    });

    it('reads a network failure or a 5xx as offline', async () => {
        expect(
            await pollView(TOKEN, 0, async () => {
                throw new TypeError('Failed to fetch');
            }),
        ).toEqual({ kind: 'offline' });
        expect(await pollView(TOKEN, 0, async () => json({ error: 'x' }, 503))).toEqual({ kind: 'offline' });
    });

    it('reads 429 as busy, with the Retry-After wait', async () => {
        expect(await pollView(TOKEN, 0, async () => json({}, 429, { 'Retry-After': '4' }))).toEqual({
            kind: 'busy',
            retryAfterMs: 4000,
        });
    });

    it('returns the poll on success', async () => {
        const body = {
            doc: { pages: 2, pdf_rev: 1 },
            pdf: 'direct',
            annotations: [mark('a', 3)],
            max_seq: 3,
            more: true,
        };
        expect(await pollView(TOKEN, 0, async () => json(body))).toEqual({ kind: 'ok', poll: body });
    });
});

describe('loadViewPdf', () => {
    it('proxy mode: POSTs for the bytes', async () => {
        const fetchImpl = vi.fn(
            async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'application/pdf' } }),
        );
        const result = await loadViewPdf(TOKEN, fetchImpl);
        expect(result.kind).toBe('ok');
        expect(result.kind === 'ok' && result.via).toBe('proxy');
        expect(result.kind === 'ok' && new Uint8Array(result.bytes)).toEqual(new Uint8Array([1, 2, 3]));
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(VIEW_ENDPOINT);
        expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN, pdf: true });
    });

    it('direct mode: fetches the signed URL once, with no credentials or referrer', async () => {
        const signed = 'https://project.supabase.co/storage/v1/object/sign/scores/d/original.pdf?token=sig';
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(json({ pdf: 'direct', url: signed }))
            .mockResolvedValueOnce(
                new Response(new Uint8Array([9]), { headers: { 'Content-Type': 'application/pdf' } }),
            );
        const result = await loadViewPdf(TOKEN, fetchImpl);
        expect(result.kind === 'ok' && result.via).toBe('direct');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
        expect(url).toBe(signed);
        expect(url).not.toContain(TOKEN);
        expect(init.credentials).toBe('omit');
        expect(init.referrerPolicy).toBe('no-referrer');
        expect(init.method ?? 'GET').toBe('GET');
    });

    it('refuses a direct URL that is not https', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(json({ pdf: 'direct', url: 'javascript:alert(1)' }));
        expect((await loadViewPdf(TOKEN, fetchImpl)).kind).toBe('offline');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('reads 410 as gone and a failure as offline', async () => {
        expect(await loadViewPdf(TOKEN, async () => json({ gone: true }, 410))).toEqual({ kind: 'gone' });
        expect(
            await loadViewPdf(TOKEN, async () => {
                throw new TypeError('offline');
            }),
        ).toEqual({ kind: 'offline' });
    });
});

describe('mergeAnnotations', () => {
    it('adds new marks and keeps the newest version of each by seq', () => {
        const start = mergeAnnotations(new Map(), [mark('a', 1), mark('b', 2)]);
        const next = mergeAnnotations(start, [mark('a', 5, { color: '#f00' }), mark('b', 1, { color: '#0f0' })]);
        expect((next.get('a') as ViewMark | undefined)?.color).toBe('#f00');
        expect((next.get('b') as ViewMark | undefined)?.color).toBe('#000');
        expect((start.get('a') as ViewMark | undefined)?.color).toBe('#000');
    });

    it('removes a mark on its tombstone, and ignores a tombstone for one never seen', () => {
        const start = mergeAnnotations(new Map(), [mark('a', 1), mark('b', 2)]);
        const next = mergeAnnotations(start, [tomb('a', 3), tomb('z', 4)]);
        expect(visibleMarks(next).map((m) => m.id)).toEqual(['b']);
    });

    it('does not resurrect a mark from an older row after its tombstone', () => {
        const start = mergeAnnotations(new Map(), [mark('a', 1)]);
        const erased = mergeAnnotations(start, [tomb('a', 3)]);
        expect(visibleMarks(erased)).toEqual([]);
        // The tombstone keeps its seq, and only that.
        expect(erased.get('a')).toEqual({ id: 'a', seq: 3, deleted: true });
        // A row older than the erase arrives afterwards (in the same poll or a
        // later one): the mark stays gone.
        const late = mergeAnnotations(erased, [mark('a', 2, { color: '#f00' })]);
        expect(visibleMarks(late)).toEqual([]);
        expect(late.get('a')).toEqual({ id: 'a', seq: 3, deleted: true });
        // A newer version than the erase is a real edit and does come back.
        expect(visibleMarks(mergeAnnotations(late, [mark('a', 4)])).map((m) => m.seq)).toEqual([4]);
    });

    it('lists visible marks oldest first, without tombstones', () => {
        const known = mergeAnnotations(new Map(), [mark('c', 5), tomb('x', 2), mark('a', 1), mark('b', 3)]);
        expect(visibleMarks(known).map((m) => m.id)).toEqual(['a', 'b', 'c']);
    });
});
