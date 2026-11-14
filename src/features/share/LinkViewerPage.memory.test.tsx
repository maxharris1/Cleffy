import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ViewerAnswer } from '@/features/share/linkSession';
import { LinkViewerPage } from '@/features/share/LinkViewerPage';
import { useViewerBackend } from '@/features/viewer/ViewerBackendContext';
import { AnnotationStore } from '@/sync/annotationStore';
import type * as SupabaseModule from '@/lib/supabase';
import type * as RealtimeChannelModule from '@/sync/realtimeChannel';

const channels = vi.hoisted(() => ({ started: 0, stopped: 0, opts: [] as Array<Record<string, unknown>> }));
const storesSeen = vi.hoisted(() => ({ marks: [] as string[] }));
const pdfsShown = vi.hoisted(() => ({ sizes: [] as number[] }));

vi.mock('@/lib/supabase', async (importOriginal) => ({
    ...(await importOriginal<typeof SupabaseModule>()),
    requireSupabaseConfig: () => ({ url: 'https://sb.test', anonKey: 'anon-key' }),
}));

vi.mock('@/sync/realtimeChannel', async (importOriginal) => ({
    ...(await importOriginal<typeof RealtimeChannelModule>()),
    DocRealtimeChannel: class {
        constructor(opts: Record<string, unknown>) {
            channels.opts.push(opts);
        }
        start() {
            channels.started += 1;
        }
        stop() {
            channels.stopped += 1;
        }
        setPage() {}
    },
}));

vi.mock('@/features/viewer/pdf/PdfProvider', () => ({
    PdfProvider: ({ children, data }: { children: ReactNode; data: ArrayBuffer }) => {
        if (pdfsShown.sizes.at(-1) !== data.byteLength) {
            pdfsShown.sizes.push(data.byteLength);
        }
        return <>{children}</>;
    },
}));

/** Stands in for the page renderer: opens the store on the injected backend as PdfViewport does. */
vi.mock('@/features/viewer/PdfViewport', () => ({
    PdfViewport: ({
        docId,
        sync,
    }: {
        docId: string;
        sync: {
            userId: string;
            name: string;
            isAnonymous: boolean;
            onMembershipChanged: () => void;
            onDocReplaced: (contentRev: number) => void;
        };
    }) => {
        const backend = useViewerBackend();
        useEffect(() => {
            const store = new AnnotationStore(backend.db, docId);
            const unsubscribe = store.subscribe(() => {
                storesSeen.marks = [...store.getPage(0).keys()];
            });
            const handle = backend.connect({
                docId,
                store,
                ink: { applyRemoteInk() {}, remoteInkCommitted() {}, clearRemoteInk() {} } as never,
                self: { userId: sync.userId, name: sync.name, isAnonymous: true, color: '#000', page: 0 },
                canWrite: false,
                callbacks: {
                    onMembershipChanged: () => sync.onMembershipChanged(),
                    onDocReplaced: (contentRev) => sync.onDocReplaced(contentRev),
                },
            });
            return () => {
                unsubscribe();
                handle.stop();
            };
        }, [backend, docId, sync]);
        return <p>score on screen</p>;
    },
}));

const TOKEN = 'abcdefghijklmnopqrstuv';
const doc = { id: 'd1', title: 'Für Elise', page_count: 1, content_rev: 0 };

describe('LinkViewerPage keeps nothing', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    let renewReply: unknown;
    let renewStatus: number;
    let snapshotDoc: typeof doc;

    beforeEach(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
        channels.started = 0;
        channels.stopped = 0;
        channels.opts = [];
        storesSeen.marks = [];
        pdfsShown.sizes = [];
        snapshotDoc = doc;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
        renewReply = null;
        renewStatus = 200;
        fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
            if (url.endsWith('/pdf')) {
                return Promise.resolve(new Response(new ArrayBuffer(8)));
            }
            if (url.endsWith('/pdf-rev-1')) {
                return Promise.resolve(new Response(new ArrayBuffer(16)));
            }
            if (url.includes('/functions/v1/share-session')) {
                expect(JSON.parse(String(init?.body))).toMatchObject({ token: TOKEN, renew: expect.any(String) });
                return Promise.resolve(new Response(JSON.stringify(renewReply), { status: renewStatus }));
            }
            if (url.includes('/rpc/link_view_snapshot')) {
                return json({
                    doc: snapshotDoc,
                    marks: [
                        {
                            id: '00000000-0000-4000-8000-000000000001',
                            page: 0,
                            kind: 'stroke',
                            color: '#000',
                            payload: { pts: [0, 0, 1, 1], w: 2 },
                            seq: 1,
                            deleted: false,
                        },
                    ],
                    max_seq: 1,
                    more: false,
                });
            }
            if (url.includes('/rpc/link_view_access')) {
                return json({ status: 'revoked' });
            }
            return Promise.reject(new Error(`unexpected ${url}`));
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    const first = (): ViewerAnswer => ({
        kind: 'viewer',
        jwt: 'jwt-1',
        exp: Math.floor(Date.now() / 1000) + 600,
        doc,
        pdfUrl: 'https://sb.test/pdf',
        linkExpiresAt: null,
    });

    const expectNothingKept = async () => {
        expect(window.localStorage.length).toBe(0);
        expect(window.sessionStorage.length).toBe(0);
        expect(await indexedDB.databases()).toEqual([]);
        expect(document.cookie).toBe('');
        if ('caches' in window) {
            expect(await caches.keys()).toEqual([]);
        }
    };

    it('opens, shows marks, renews and closes with every browser store empty', async () => {
        const onDead = vi.fn();
        renewReply = {
            state: 'live',
            role: 'viewer',
            session_jwt: 'jwt-2',
            exp: Math.floor(Date.now() / 1000) + 1200,
            doc,
            pdf_url: 'https://sb.test/pdf',
            link_expires_at: null,
        };
        const view = render(
            <MemoryRouter>
                <LinkViewerPage token={TOKEN} first={first()} onDead={onDead} />
            </MemoryRouter>,
        );
        expect(await screen.findByText('score on screen')).toBeTruthy();
        expect(screen.getByText('View only')).toBeTruthy();
        expect(document.title).toContain('Für Elise');
        await vi.waitFor(() => expect(storesSeen.marks).toHaveLength(1));
        expect(channels.opts[0]).toMatchObject({ dbTopic: 'doc-view', rotationJitterMaxMs: 250 });
        await expectNothingKept();

        await vi.advanceTimersByTimeAsync(480_000);
        expect(fetchMock.mock.calls.some(([u]) => String(u).includes('share-session'))).toBe(true);
        expect(onDead).not.toHaveBeenCalled();
        await expectNothingKept();

        view.unmount();
        expect(channels.stopped).toBeGreaterThanOrEqual(channels.started);
        await expectNothingKept();
    });

    it('links the children’s notice client-side', async () => {
        render(
            <MemoryRouter>
                <LinkViewerPage token={TOKEN} first={first()} onDead={vi.fn()} />
            </MemoryRouter>,
        );
        const link = await screen.findByRole('link', { name: 'What we keep' });
        expect(link.getAttribute('href')).toBe('/children-privacy');
    });

    it('clears the score when the renewal finds the link revoked', async () => {
        const onDead = vi.fn();
        renewReply = { state: 'revoked' };
        render(
            <MemoryRouter>
                <LinkViewerPage token={TOKEN} first={first()} onDead={onDead} />
            </MemoryRouter>,
        );
        await screen.findByText('score on screen');
        await vi.advanceTimersByTimeAsync(480_000);
        expect(onDead).toHaveBeenCalledWith({ kind: 'dead', state: 'revoked', expiredAt: null });
        expect(channels.stopped).toBeGreaterThanOrEqual(1);
    });

    it('clears the score when the channel is shut out and the link reads revoked', async () => {
        const onDead = vi.fn();
        render(
            <MemoryRouter>
                <LinkViewerPage token={TOKEN} first={first()} onDead={onDead} />
            </MemoryRouter>,
        );
        await screen.findByText('score on screen');
        await vi.waitFor(() => expect(channels.opts).toHaveLength(1));
        (channels.opts[0]?.['onMembershipChanged'] as () => void)();
        await vi.waitFor(() =>
            expect(onDead).toHaveBeenCalledWith({ kind: 'dead', state: 'revoked', expiredAt: null }),
        );
    });

    it('clears the score when the link expiry passes', async () => {
        const onDead = vi.fn();
        const expiredAt = new Date(Date.now() + 60_000).toISOString();
        render(
            <MemoryRouter>
                <LinkViewerPage token={TOKEN} first={{ ...first(), linkExpiresAt: expiredAt }} onDead={onDead} />
            </MemoryRouter>,
        );
        await screen.findByText('score on screen');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onDead).toHaveBeenCalledWith({ kind: 'dead', state: 'expired', expiredAt });
    });

    const renewal = (overrides: Record<string, unknown> = {}) => ({
        state: 'live',
        role: 'viewer',
        session_jwt: 'jwt-2',
        exp: Math.floor(Date.now() / 1000) + 1500,
        doc,
        pdf_url: 'https://sb.test/pdf',
        link_expires_at: null,
        ...overrides,
    });

    it.each([
        ['a later deadline', () => new Date(Date.now() + 86_400_000).toISOString()],
        ['never', () => null],
    ])('keeps the score open past the old deadline when a renewal moves the expiry to %s', async (_, next) => {
        const onDead = vi.fn();
        const expiredAt = new Date(Date.now() + 900_000).toISOString();
        renewReply = renewal({ link_expires_at: next() });
        render(
            <MemoryRouter>
                <LinkViewerPage token={TOKEN} first={{ ...first(), linkExpiresAt: expiredAt }} onDead={onDead} />
            </MemoryRouter>,
        );
        await screen.findByText('score on screen');
        await vi.advanceTimersByTimeAsync(480_000);
        expect(fetchMock.mock.calls.some(([u]) => String(u).includes('share-session'))).toBe(true);
        await vi.advanceTimersByTimeAsync(430_000);
        expect(onDead).not.toHaveBeenCalled();
    });

    it('clears the score at the earlier deadline a renewal brings', async () => {
        const onDead = vi.fn();
        const sooner = new Date(Date.now() + 600_000).toISOString();
        renewReply = renewal({ link_expires_at: sooner });
        render(
            <MemoryRouter>
                <LinkViewerPage
                    token={TOKEN}
                    first={{ ...first(), linkExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }}
                    onDead={onDead}
                />
            </MemoryRouter>,
        );
        await screen.findByText('score on screen');
        await vi.advanceTimersByTimeAsync(480_000);
        expect(onDead).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(120_000);
        expect(onDead).toHaveBeenCalledWith({ kind: 'dead', state: 'expired', expiredAt: sooner });
    });

    it.each([
        ['a later deadline', () => new Date(Date.now() + 86_400_000).toISOString()],
        ['never', () => null],
    ])('keeps the score open when the owner moves the expiry to %s between renewals', async (_, next) => {
        const onDead = vi.fn();
        const oldDeadline = new Date(Date.now() + 60_000).toISOString();
        renewReply = renewal({ link_expires_at: oldDeadline });
        render(
            <MemoryRouter>
                <LinkViewerPage token={TOKEN} first={{ ...first(), linkExpiresAt: oldDeadline }} onDead={onDead} />
            </MemoryRouter>,
        );
        await screen.findByText('score on screen');
        await vi.advanceTimersByTimeAsync(30_000);
        renewReply = renewal({ link_expires_at: next() });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(onDead).not.toHaveBeenCalled();
        expect(screen.getByText('score on screen')).toBeTruthy();
    });

    it.each([
        ['the server reports it expired', () => [200, { state: 'expired', expired_at: 'server-deadline' }]],
        [
            'the server still names the passed deadline',
            () => [200, renewal({ link_expires_at: new Date(Date.now() - 1).toISOString() })],
        ],
        ['the check fails', () => [200, null]],
        ['the server is busy', () => [429, { retry_after: 30 }]],
    ] as Array<[string, () => [number, unknown]]>)('clears the score at the deadline when %s', async (_, reply) => {
        const onDead = vi.fn();
        const expiredAt = new Date(Date.now() + 60_000).toISOString();
        render(
            <MemoryRouter>
                <LinkViewerPage token={TOKEN} first={{ ...first(), linkExpiresAt: expiredAt }} onDead={onDead} />
            </MemoryRouter>,
        );
        await screen.findByText('score on screen');
        await vi.advanceTimersByTimeAsync(59_000);
        [renewStatus, renewReply] = reply();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(onDead).toHaveBeenCalledTimes(1);
        expect(onDead.mock.calls[0]?.[0]).toMatchObject({ kind: 'dead', state: 'expired' });
        expect(channels.stopped).toBeGreaterThanOrEqual(1);
    });

    it('restarts the busy countdown on every busy renewal', async () => {
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
            shouldAdvanceTime: true,
        });
        renewStatus = 429;
        renewReply = { retry_after: 30 };
        render(
            <MemoryRouter>
                <LinkViewerPage token={TOKEN} first={first()} onDead={vi.fn()} />
            </MemoryRouter>,
        );
        await screen.findByText('score on screen');
        await act(() => vi.advanceTimersByTimeAsync(480_000));
        expect(screen.getByText(/Trying again in 30 s/)).toBeTruthy();
        await act(() => vi.advanceTimersByTimeAsync(30_000));
        await act(() => vi.advanceTimersByTimeAsync(1_000));
        expect(screen.getByText(/Trying again in (29|30) s/)).toBeTruthy();
    });

    it('brings in the replaced PDF when the doc-view channel reports a new revision', async () => {
        renewReply = renewal({ doc: { ...doc, content_rev: 1 }, pdf_url: 'https://sb.test/pdf-rev-1' });
        render(
            <MemoryRouter>
                <LinkViewerPage token={TOKEN} first={first()} onDead={vi.fn()} />
            </MemoryRouter>,
        );
        await screen.findByText('score on screen');
        await vi.waitFor(() => expect(channels.opts).toHaveLength(1));
        expect(pdfsShown.sizes).toEqual([8]);
        (channels.opts[0]?.['onDocReplaced'] as (rev: number) => void)(1);
        await vi.waitFor(() => expect(pdfsShown.sizes).toEqual([8, 16]));
    });

    it('brings in the replaced PDF when a pull finds a newer revision', async () => {
        snapshotDoc = { ...doc, content_rev: 1 };
        renewReply = renewal({ doc: snapshotDoc, pdf_url: 'https://sb.test/pdf-rev-1' });
        render(
            <MemoryRouter>
                <LinkViewerPage token={TOKEN} first={first()} onDead={vi.fn()} />
            </MemoryRouter>,
        );
        await screen.findByText('score on screen');
        await vi.waitFor(() => expect(pdfsShown.sizes).toEqual([8, 16]));
    });
});
