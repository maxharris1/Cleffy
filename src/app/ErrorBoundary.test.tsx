import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy, Suspense } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from '@/app/ErrorBoundary';
import { resetStaleChunkStateForTests } from '@/lib/staleChunk';
import { getDb } from '@/sync/db';

const reportError = vi.fn();

vi.mock('@/lib/monitoring', () => ({
    reportError: (...args: unknown[]) => reportError(...args),
}));

const Boom = (): never => {
    throw new Error('render failed');
};

/** A route chunk from a build that has since been replaced: its file is gone. */
const missingChunk = () =>
    lazy(() =>
        Promise.reject(
            new TypeError(
                'Failed to fetch dynamically imported module: https://dev.cleffy.io/assets/StudentClaimPage-old.js',
            ),
        ),
    );

describe('ErrorBoundary', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        resetStaleChunkStateForTests();
        // React logs the caught error itself; keep the test output readable.
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        cleanup();
        reportError.mockClear();
        vi.restoreAllMocks();
        resetStaleChunkStateForTests();
    });

    it('reports a render crash with its component stack and shows the recovery screen', () => {
        render(
            <MemoryRouter>
                <ErrorBoundary>
                    <Boom />
                </ErrorBoundary>
            </MemoryRouter>,
        );

        expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
        expect(reportError).toHaveBeenCalledTimes(1);
        const [error, context] = reportError.mock.calls[0] as [Error, { componentStack?: string; tags?: object }];
        expect(error.message).toBe('render failed');
        expect(context.tags).toEqual({ source: 'error-boundary' });
        expect(context.componentStack).toContain('Boom');
    });

    it('shows the recovery screen with no router around it, as App mounts it', () => {
        // App.tsx puts the boundary OUTSIDE BrowserRouter. A router Link in the
        // fallback threw "useContext(...) is null" there and left a blank page.
        render(
            <ErrorBoundary>
                <Boom />
            </ErrorBoundary>,
        );

        expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Cleffy' })).toHaveAttribute('href', '/');
    });

    it('reloads for the current build when a lazy chunk from an older one is gone, without reporting', async () => {
        const Missing = missingChunk();
        render(
            <ErrorBoundary>
                <Suspense fallback={<p>loading</p>}>
                    <Missing />
                </Suspense>
            </ErrorBoundary>,
        );

        expect(await screen.findByRole('heading', { name: 'Updating Cleffy…' })).toBeInTheDocument();
        // The guard the next page load reads, so a chunk that is still missing
        // after the reload cannot loop.
        expect(window.sessionStorage.getItem('cleffy:stale-chunk-reload-at')).not.toBeNull();
        expect(reportError).not.toHaveBeenCalled();
    });

    it('shows the crash screen, not another reload, when the chunk is still missing right after one', async () => {
        window.sessionStorage.setItem('cleffy:stale-chunk-reload-at', String(Date.now() - 2_000));
        const Missing = missingChunk();
        render(
            <ErrorBoundary>
                <Suspense fallback={<p>loading</p>}>
                    <Missing />
                </Suspense>
            </ErrorBoundary>,
        );

        expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
        expect(screen.getByText(/Part of Cleffy could not be loaded/)).toBeInTheDocument();
        expect(reportError).toHaveBeenCalledTimes(1);
    });

    it('offers to clear the cached lists a reload would crash on again, keeping every unsynced change', async () => {
        const user = userEvent.setup();
        const db = getDb();
        // What sent the student here: a cached list this build cannot render.
        await db.assignmentsCache.put({
            userId: 'student-1',
            scores: [{ assignment: null, document: null }] as never,
            cachedAt: '2026-10-10T00:00:00Z',
        });
        await db.rosterCache.put({ userId: 'teacher-1', students: [], assignmentCounts: [], cachedAt: 'x' });
        // ...and the work that must survive it.
        const DOC = 'c0ffee00-0000-4000-8000-0000000000aa';
        await db.ops.add({
            docId: DOC,
            annotationId: 'queued-mark',
            type: 'create',
            payload: {},
            createdAt: '2026-10-10T00:00:00Z',
            userId: 'student-1',
        } as never);
        await db.annotations.put({ id: 'queued-mark', docId: DOC, page: 0 } as never);
        await db.pdfCache.put({ docId: DOC, bytes: new ArrayBuffer(4), title: 'Prelude', cachedAt: 'x' } as never);

        render(
            <ErrorBoundary>
                <Boom />
            </ErrorBoundary>,
        );
        await user.click(screen.getByRole('button', { name: 'Clear cached data and reload' }));

        await waitFor(async () => expect(await db.assignmentsCache.count()).toBe(0));
        expect(await db.rosterCache.count()).toBe(0);
        expect(await db.ops.where('docId').equals(DOC).count()).toBe(1);
        expect(await db.annotations.where('docId').equals(DOC).count()).toBe(1);
        expect(await db.pdfCache.count()).toBe(1);
        await Promise.all([db.ops.clear(), db.annotations.clear(), db.pdfCache.clear()]);
    });

    it('does not offer the clear for a chunk that could not load: the cache is not why', async () => {
        window.sessionStorage.setItem('cleffy:stale-chunk-reload-at', String(Date.now() - 2_000));
        const Missing = missingChunk();
        render(
            <ErrorBoundary>
                <Suspense fallback={<p>loading</p>}>
                    <Missing />
                </Suspense>
            </ErrorBoundary>,
        );

        expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Clear cached data and reload' })).not.toBeInTheDocument();
    });

    it('reports nothing when the tree renders', () => {
        render(
            <MemoryRouter>
                <ErrorBoundary>
                    <p>fine</p>
                </ErrorBoundary>
            </MemoryRouter>,
        );
        expect(screen.getByText('fine')).toBeInTheDocument();
        expect(reportError).not.toHaveBeenCalled();
    });
});
