import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as documentsModule from '@/features/library/documentsService';
import type * as dbModule from '@/sync/db';

const buildAnnotatedPdf = vi.fn();
const fetchDocument = vi.fn();

vi.mock('@/sync/db', async (importOriginal) => ({
    ...(await importOriginal<typeof dbModule>()),
    getDb: () => db,
}));
vi.mock('@/features/export/exportPdf', () => ({
    buildAnnotatedPdf: (...args: unknown[]) => buildAnnotatedPdf(...args),
    deliverPdf: async () => 'downloaded',
}));
vi.mock('@/features/library/documentsService', async (importOriginal) => ({
    ...(await importOriginal<typeof documentsModule>()),
    fetchDocument: (...args: unknown[]) => fetchDocument(...args),
}));
vi.mock('@/features/export/exportClaim', () => ({
    claimPdfExport: async () => ({ ok: true }),
    EXPORT_NOT_SENT_MESSAGE: 'Not sent.',
    exportAttemptKey: () => 'attempt',
    markExportDelivered: () => undefined,
}));
vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: null }),
}));
vi.mock('@/features/billing/pricing', () => ({ isBillingConfigured: () => false }));

import { SignedOutInkGate } from '@/app/SignedOutInkGate';
import { purgeLocalDocument } from '@/features/library/documentsService';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { accountSignedIn, rememberScoreSource, resetInkRecoveryForTests } from '@/sync/inkRecovery';
import type { Annotation } from '@/types/models';

const DOC = '6f1c2b9e-3a4d-4e5f-8a7b-1c2d3e4f5a6c';
const USER = 'user-1';
const BYTES = new Uint8Array([37, 80, 68, 70]).buffer;

let db: ScribblerDb;

const stroke = (id: string): Annotation => ({
    id,
    docId: DOC,
    page: 0,
    kind: 'stroke',
    color: '#111111',
    payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
    createdBy: USER,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

beforeEach(() => {
    vi.clearAllMocks();
    buildAnnotatedPdf.mockResolvedValue(new File([], 'Sonata (annotated).pdf'));
    fetchDocument.mockResolvedValue(null);
    db = new ScribblerDb(`undo-export-${crypto.randomUUID()}`);
});

afterEach(() => {
    cleanup();
    resetInkRecoveryForTests();
});

describe('lost-access notice after an Undo overtaken by a purge', () => {
    it('exports the restored marks from the PDF the viewer let go of between the Undo press and the purge', async () => {
        accountSignedIn(USER);
        const store = new AnnotationStore(db, DOC);
        store.setAuthor(USER);
        await store.load();
        await store.create(stroke('a1'));
        await store.create(stroke('a2'));
        const batch = store.beginBatch();
        await store.delete('a1');
        await store.delete('a2');
        store.endBatch(batch);

        const releaseSource = rememberScoreSource(DOC, 'Sonata', BYTES);
        const undoing = store.undoLast();
        releaseSource();
        await Promise.allSettled([undoing, purgeLocalDocument(DOC)]);

        const user = userEvent.setup();
        render(<SignedOutInkGate />);
        await user.click(within(await screen.findByRole('status')).getByRole('button', { name: 'Export' }));
        const dialog = await screen.findByRole('dialog', { name: 'Export your unsaved ink' });
        expect(dialog).toHaveTextContent('Sonata (2 marks)');
        await user.click(within(dialog).getByRole('button', { name: 'Export' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Export whole score as PDF' }));

        await waitFor(() =>
            expect(buildAnnotatedPdf).toHaveBeenCalledWith(
                DOC,
                BYTES,
                'Sonata',
                expect.objectContaining({ userId: USER, lostAccess: true }),
            ),
        );
        expect(fetchDocument).not.toHaveBeenCalled();
        expect(screen.queryByText('This score is no longer available to you.')).not.toBeInTheDocument();
    });
});
