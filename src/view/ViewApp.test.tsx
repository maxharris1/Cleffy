import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ViewApp, type ViewScoreProps } from '@/view/ViewApp';
import type { ViewAnnotation } from '@/view/viewLinkClient';

/**
 * The /v viewer page: what a child sees. It must work from memory only — no
 * storage API, cookie or service worker is so much as read — and say plainly
 * when the link is off, unavailable or unreachable.
 */

const TOKEN = 'k'.repeat(43);
const GONE_TEXT = 'This link was turned off. Ask your teacher for a new one.';

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const pdf = (bytes: number[] = [0x25, 0x50]) =>
    new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/pdf' } });

/** A live mark, or (deleted) the tombstone the server sends for it: id and seq only. */
const mark = (id: string, seq: number, deleted = false): ViewAnnotation =>
    deleted
        ? { id, seq, deleted: true }
        : {
              id,
              page: 0,
              kind: 'stroke',
              color: '#000',
              payload: { pts: [0, 0, 1], w: 0.01 },
              seq,
              deleted: false,
          };

const poll = (annotations: ViewAnnotation[], maxSeq: number, extra: Record<string, unknown> = {}) =>
    json({ doc: { pages: 1, pdf_rev: 0 }, pdf: 'proxy', annotations, max_seq: maxSeq, more: false, ...extra });

/** Stands in for the pdf.js renderer, which jsdom cannot run. */
const renders: ViewScoreProps[] = [];
const FakeScore = (props: ViewScoreProps) => {
    renders.push(props);
    return (
        <div data-testid="score">
            {`${props.bytes.byteLength} bytes; marks: [${props.annotations.map((a) => a.id).join(',')}]`}
        </div>
    );
};

type Body = { token: string; since?: number; pdf?: boolean };
const bodyOf = (call: unknown[]): Body => JSON.parse((call[1] as RequestInit).body as string) as Body;

/** Every way a page could keep something on the device, each a spy. */
const touched: string[] = [];
const guard = (target: object, prop: string) => {
    const original = Object.getOwnPropertyDescriptor(target, prop);
    Object.defineProperty(target, prop, {
        configurable: true,
        get() {
            touched.push(`get ${prop}`);
            return undefined;
        },
        set() {
            touched.push(`set ${prop}`);
        },
    });
    return () => {
        if (original) {
            Object.defineProperty(target, prop, original);
        } else {
            delete (target as Record<string, unknown>)[prop];
        }
    };
};
let restores: Array<() => void> = [];

beforeEach(() => {
    renders.length = 0;
    touched.length = 0;
    restores = [
        guard(window, 'localStorage'),
        guard(window, 'sessionStorage'),
        guard(window, 'indexedDB'),
        guard(window, 'caches'),
        guard(Document.prototype, 'cookie'),
        guard(Navigator.prototype, 'serviceWorker'),
        guard(window.navigator, 'serviceWorker'),
    ];
});

afterEach(() => {
    cleanup();
    for (const restore of restores) {
        restore();
    }
    vi.useRealTimers();
});

const renderApp = (fetchImpl: typeof fetch, props: Partial<Parameters<typeof ViewApp>[0]> = {}) =>
    render(<ViewApp token={TOKEN} enabled fetchImpl={fetchImpl} Score={FakeScore} pollMs={30} {...props} />);

describe('the viewer page', () => {
    it('says "not available" and fetches nothing when the build switch is off', () => {
        const fetchImpl = vi.fn();
        renderApp(fetchImpl as never, { enabled: false });
        expect(screen.getByText(/isn’t available/)).toBeInTheDocument();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('says "not available" without a token in the fragment', () => {
        const fetchImpl = vi.fn();
        renderApp(fetchImpl as never, { token: null });
        expect(screen.getByText(/isn’t available/)).toBeInTheDocument();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('says "not available" when the proxy answers 404 (server switch off)', async () => {
        renderApp(vi.fn(async () => new Response('', { status: 404 })) as never);
        expect(await screen.findByText(/isn’t available/)).toBeInTheDocument();
    });

    it('shows loading, then the score with its marks, and a children’s privacy footer', async () => {
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) =>
            (JSON.parse(init.body as string) as Body).pdf ? pdf() : poll([mark('a', 1)], 1),
        );
        renderApp(fetchImpl as never);
        expect(screen.getByText(/Loading/)).toBeInTheDocument();
        expect(await screen.findByText('2 bytes; marks: [a]')).toBeInTheDocument();
        const footer = screen.getByRole('link', { name: /children’s privacy/i });
        expect(footer).toHaveAttribute('href', '/children-privacy');
    });

    it('polls with the watermark, merges new marks and drops erased ones', async () => {
        const polls = [poll([mark('a', 1), mark('b', 2)], 2), poll([mark('c', 3), mark('a', 4, true)], 4), poll([], 4)];
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) =>
            (JSON.parse(init.body as string) as Body).pdf ? pdf() : (polls.shift() ?? poll([], 4)),
        );
        renderApp(fetchImpl as never);
        expect(await screen.findByText('2 bytes; marks: [b,c]')).toBeInTheDocument();
        await waitFor(() => {
            const sinces = fetchImpl.mock.calls
                .map(bodyOf)
                .filter((b) => !b.pdf)
                .map((b) => b.since);
            expect(sinces.slice(0, 3)).toEqual([0, 2, 4]);
        });
    });

    it('fetches the next page at once while the server says more', async () => {
        const polls = [poll([mark('a', 1)], 1, { more: true }), poll([mark('b', 2)], 2)];
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) =>
            (JSON.parse(init.body as string) as Body).pdf ? pdf() : (polls.shift() ?? poll([], 2)),
        );
        renderApp(fetchImpl as never, { pollMs: 60_000 });
        expect(await screen.findByText('2 bytes; marks: [a,b]')).toBeInTheDocument();
    });

    it('shows "turned off" when the link is revoked, and stops polling', async () => {
        let revoked = false;
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
            if (revoked) {
                return json({ gone: true }, 410);
            }
            return (JSON.parse(init.body as string) as Body).pdf ? pdf() : poll([mark('a', 1)], 1);
        });
        renderApp(fetchImpl as never);
        await screen.findByTestId('score');
        revoked = true;
        expect(await screen.findByText(GONE_TEXT)).toBeInTheDocument();
        expect(screen.queryByTestId('score')).toBeNull();
        const calls = fetchImpl.mock.calls.length;
        await act(() => new Promise((r) => setTimeout(r, 120)));
        expect(fetchImpl.mock.calls.length).toBe(calls);
    });

    it('shows "turned off" for a link that is already dead', async () => {
        renderApp(vi.fn(async () => json({ gone: true }, 410)) as never);
        expect(await screen.findByText(GONE_TEXT)).toBeInTheDocument();
    });

    it('says it is offline and retries until it is back', async () => {
        let up = false;
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
            if (!up) {
                throw new TypeError('Failed to fetch');
            }
            return (JSON.parse(init.body as string) as Body).pdf ? pdf() : poll([mark('a', 1)], 1);
        });
        renderApp(fetchImpl as never);
        expect(await screen.findByText(/Can’t reach Cleffy/)).toBeInTheDocument();
        up = true;
        expect(await screen.findByTestId('score')).toBeInTheDocument();
        expect(screen.queryByText(/Can’t reach Cleffy/)).toBeNull();
    });

    it('reloads the PDF when pdf_rev changes', async () => {
        let rev = 0;
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) =>
            (JSON.parse(init.body as string) as Body).pdf
                ? pdf(rev === 0 ? [1] : [1, 2, 3])
                : json({ doc: { pages: 1, pdf_rev: rev }, pdf: 'proxy', annotations: [], max_seq: 0, more: false }),
        );
        renderApp(fetchImpl as never);
        await screen.findByText('1 bytes; marks: []');
        rev = 1;
        expect(await screen.findByText('3 bytes; marks: []')).toBeInTheDocument();
        expect(fetchImpl.mock.calls.map(bodyOf).filter((b) => b.pdf)).toHaveLength(2);
    });

    it('in direct mode, fetches the signed URL once', async () => {
        const signed = 'https://project.supabase.co/storage/v1/object/sign/scores/d/original.pdf?token=sig';
        const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
            if (url === signed) {
                return pdf([7, 7, 7, 7]);
            }
            return (JSON.parse(init.body as string) as Body).pdf
                ? json({ pdf: 'direct', url: signed })
                : poll([], 0, { pdf: 'direct' });
        });
        renderApp(fetchImpl as never);
        expect(await screen.findByText('4 bytes; marks: []')).toBeInTheDocument();
        await act(() => new Promise((r) => setTimeout(r, 100)));
        expect(fetchImpl.mock.calls.filter(([url]) => url === signed)).toHaveLength(1);
    });

    it('sends the token only in POST bodies to /api/view', async () => {
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) =>
            (JSON.parse(init.body as string) as Body).pdf ? pdf() : poll([], 0),
        );
        renderApp(fetchImpl as never);
        await screen.findByTestId('score');
        for (const [url, init] of fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>) {
            expect(url).toBe('/api/view');
            expect(init.method).toBe('POST');
            expect(bodyOf([url, init]).token).toBe(TOKEN);
        }
    });

    it('never touches localStorage, sessionStorage, IndexedDB, cookies, caches or the service worker', async () => {
        let n = 0;
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
            n += 1;
            if (n > 6) {
                return json({ gone: true }, 410);
            }
            return (JSON.parse(init.body as string) as Body).pdf ? pdf() : poll([mark(`m${n}`, n)], n);
        });
        renderApp(fetchImpl as never);
        await screen.findByText(GONE_TEXT);
        expect(touched).toEqual([]);
    });
});

describe('the entry point', () => {
    it('reads the token from location.hash and mounts without the app’s integrations', async () => {
        // main.tsx must not pull in the app shell, Supabase, monitoring, the
        // service worker, web events or auth: checked on its source here and
        // on the built chunks in tests/viewLinks/viewBundle.test.ts.
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const sources = [
            'src/view/main.tsx',
            'src/view/ViewApp.tsx',
            'src/view/viewLinkClient.ts',
            'src/view/ViewScore.tsx',
        ].map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'));
        expect(sources[0]).toMatch(/location\.hash/);
        for (const source of sources) {
            expect(source).not.toMatch(
                /@\/main|@\/app\/|@\/lib\/supabase|@\/lib\/monitoring|@\/lib\/serviceWorker|webEvents|@\/features\/auth|@sentry|@supabase|dexie|@\/sync\//,
            );
        }
    });
});
