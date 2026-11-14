import { cleanup, render, screen } from '@testing-library/react';
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
    PdfProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

/** Stands in for the page renderer: opens the store on the injected backend as PdfViewport does. */
vi.mock('@/features/viewer/PdfViewport', () => ({
    PdfViewport: ({
        docId,
        sync,
    }: {
        docId: string;
        sync: { userId: string; name: string; isAnonymous: boolean; onMembershipChanged: () => void };
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
                callbacks: { onMembershipChanged: () => sync.onMembershipChanged() },
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

    beforeEach(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
        channels.started = 0;
        channels.stopped = 0;
        channels.opts = [];
        storesSeen.marks = [];
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], shouldAdvanceTime: true });
        renewReply = null;
        fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
            if (url.endsWith('/pdf')) {
                return Promise.resolve(new Response(new ArrayBuffer(8)));
            }
            if (url.includes('/functions/v1/share-session')) {
                expect(JSON.parse(String(init?.body))).toMatchObject({ token: TOKEN, renew: expect.any(String) });
                return json(renewReply);
            }
            if (url.includes('/rpc/link_view_snapshot')) {
                return json({
                    doc,
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
});
