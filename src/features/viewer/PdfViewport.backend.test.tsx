import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PdfViewport } from '@/features/viewer/PdfViewport';
import { ViewerBackendProvider, type ViewerBackend, type ViewerSyncArgs } from '@/features/viewer/ViewerBackendContext';
import type { TypedSupabaseClient } from '@/lib/supabase';
import type { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';

vi.mock('@/features/viewer/pdf/pdfContext', () => ({
    usePdf: () => ({ doc: {}, pageSizes: [{ width: 612, height: 792 }], status: 'ready', error: null }),
}));
vi.mock('@/features/viewer/pdf/PageView', () => ({ PageView: () => null }));
vi.mock('@/features/viewer/toolbar/Toolbar', () => ({ Toolbar: () => null }));

beforeEach(() => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const fakeBackend = (db: ScribblerDb) => {
    const stop = vi.fn();
    const setPage = vi.fn();
    const connect = vi.fn((_args: ViewerSyncArgs) => ({ setPage, stop }));
    const backend: ViewerBackend = { db, supabase: {} as TypedSupabaseClient, connect };
    return { backend, connect, stop };
};

describe('PdfViewport with an injected backend', () => {
    it('keeps marks in the backend database and hands it the session, read-only and anonymous', async () => {
        const db = new ScribblerDb(`backend-test-${crypto.randomUUID()}`);
        const at = new Date(0).toISOString();
        await db.annotations.put({
            id: 'a1',
            docId: 'doc-1',
            page: 0,
            kind: 'stroke',
            color: '#000',
            payload: { pts: [0, 0, 1], w: 0.02 },
            createdBy: 'owner',
            createdAt: at,
            updatedAt: at,
            deletedAt: null,
            seq: 1,
            pending: 0,
        });
        const { backend, connect, stop } = fakeBackend(db);
        let store: AnnotationStore | null = null;
        const { unmount } = render(
            <ViewerBackendProvider value={backend}>
                <PdfViewport
                    docId="doc-1"
                    readOnly
                    onStoreReady={(s) => (store = s)}
                    sync={{
                        userId: 'viewer-1',
                        name: 'Anonymous Otter',
                        isAnonymous: true,
                        via: 'link',
                        canWrite: false,
                    }}
                />
            </ViewerBackendProvider>,
        );
        await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
        const args = connect.mock.calls[0]![0];
        expect(args.docId).toBe('doc-1');
        expect(args.canWrite).toBe(false);
        expect(args.self).toMatchObject({
            userId: 'viewer-1',
            name: 'Anonymous Otter',
            isAnonymous: true,
            via: 'link',
        });
        await waitFor(() => expect(store?.get('a1')).toBeDefined());
        unmount();
        expect(stop).toHaveBeenCalledTimes(1);
        db.close();
    });

    it('connects nothing for a score with no sync', async () => {
        const db = new ScribblerDb(`backend-test-${crypto.randomUUID()}`);
        const { backend, connect } = fakeBackend(db);
        render(
            <ViewerBackendProvider value={backend}>
                <PdfViewport docId="doc-2" />
            </ViewerBackendProvider>,
        );
        await new Promise((r) => setTimeout(r, 20));
        expect(connect).not.toHaveBeenCalled();
        db.close();
    });
});
