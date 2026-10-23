import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/export/ShareExportMenu', () => ({
    ShareExportMenu: ({
        docId,
        title,
        userId,
        lostAccess,
    }: {
        docId: string;
        title: string;
        userId?: string | null;
        lostAccess?: boolean;
    }) => (
        <button type="button" data-doc={docId} data-user={userId ?? ''} data-lost={String(Boolean(lostAccess))}>
            {`Export ${title}`}
        </button>
    ),
}));

import { SignedOutInkGate } from '@/app/SignedOutInkGate';
import { ScribblerDb } from '@/sync/db';
import {
    closeDocInk,
    heldInkForExport,
    heldMarkIds,
    holdOps,
    rememberScoreSource,
    resetInkRecoveryForTests,
    retireAccountInk,
} from '@/sync/inkRecovery';
import type { Annotation } from '@/types/models';

const DOC = 'c0ffee00-0000-4000-8000-0000000000f1';
const USER = 'user-1';

const stroke = (id: string): Annotation => ({
    id,
    docId: DOC,
    page: 0,
    kind: 'stroke',
    color: '#111111',
    payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
    createdBy: null,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

const holdTwo = () => {
    const close = rememberScoreSource(DOC, 'Clair de lune', new ArrayBuffer(4));
    holdOps(new ScribblerDb(`signed-out-${crypto.randomUUID()}`), DOC, [
        { op: { type: 'create', annotation: stroke('a1') }, author: USER },
        { op: { type: 'create', annotation: stroke('a2') }, author: USER },
    ]);
    close();
};

afterEach(() => {
    cleanup();
    resetInkRecoveryForTests();
});

describe('SignedOutInkNotice (round 3, items 2–3)', () => {
    it('is not there while nothing of a signed-out account is held', () => {
        holdTwo();
        render(<SignedOutInkGate />);
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('after a sign-out in another tab: says so, with Export and Discard', async () => {
        holdTwo();
        render(<SignedOutInkGate />);

        retireAccountInk(USER, 'other-tab');

        const notice = await screen.findByRole('status');
        expect(notice).toHaveTextContent(
            'You were signed out in another tab. Your unsaved ink couldn’t be saved and is still on this device: export a copy to keep it.',
        );
        expect(within(notice).getByRole('button', { name: 'Export' })).toBeInTheDocument();
        expect(within(notice).getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    });

    it('Export lists each score, exported for the account that made the marks', async () => {
        holdTwo();
        render(<SignedOutInkGate />);
        retireAccountInk(USER);

        await userEvent.click(await screen.findByRole('button', { name: 'Export' }));

        const dialog = screen.getByRole('dialog', { name: 'Export your unsaved ink' });
        expect(dialog).toHaveTextContent('Clair de lune (2 marks)');
        const menu = within(dialog).getByRole('button', { name: 'Export Clair de lune' });
        expect(menu).toHaveAttribute('data-doc', DOC);
        expect(menu).toHaveAttribute('data-user', USER);
        expect(menu).toHaveAttribute('data-lost', 'false');
    });

    it('Discard asks first and offers Export; only its confirm discards', async () => {
        holdTwo();
        render(<SignedOutInkGate />);
        retireAccountInk(USER);

        await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
        const confirm = screen.getByRole('dialog', { name: 'Discard your unsaved ink?' });
        expect(confirm).toHaveTextContent(
            '2 unsaved marks on 1 score are only in this tab. Discarding deletes them for good. Export a copy first to keep them.',
        );
        await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
        expect(heldInkForExport(USER, DOC).held).toHaveLength(2);

        await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
        await userEvent.click(
            within(screen.getByRole('dialog', { name: 'Discard your unsaved ink?' })).getByRole('button', {
                name: 'Export first',
            }),
        );
        expect(screen.getByRole('dialog', { name: 'Export your unsaved ink' })).toBeInTheDocument();
        expect(heldInkForExport(USER, DOC).held).toHaveLength(2);
        await userEvent.click(screen.getByRole('button', { name: 'Close' }));

        await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
        await userEvent.click(
            within(screen.getByRole('dialog', { name: 'Discard your unsaved ink?' })).getByRole('button', {
                name: 'Discard',
            }),
        );

        expect(heldInkForExport(USER, DOC).held).toEqual([]);
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
});

describe('held ink of a score lost to this device (decision 65(1))', () => {
    it('access lost: the same notice, saying the marks are still on this device, with Export and Discard', async () => {
        holdTwo();
        render(<SignedOutInkGate />);
        expect(screen.queryByRole('status')).not.toBeInTheDocument();

        // Removed from the share, or the score deleted by someone else: purged here.
        closeDocInk(DOC);

        const notice = await screen.findByRole('status');
        expect(notice).toHaveTextContent(
            'You no longer have access to a score you had unsaved ink on. Those marks couldn’t be saved and are still on this device: export a copy to keep them.',
        );
        // Out of every viewer: nothing draws it or retries it now.
        expect(heldMarkIds(USER, DOC).size).toBe(0);
        expect(heldInkForExport(USER, DOC, true).held).toHaveLength(2);

        await userEvent.click(within(notice).getByRole('button', { name: 'Export' }));
        const dialog = screen.getByRole('dialog', { name: 'Export your unsaved ink' });
        expect(dialog).toHaveTextContent('Clair de lune (2 marks)');
        const menu = within(dialog).getByRole('button', { name: 'Export Clair de lune' });
        expect(menu).toHaveAttribute('data-user', USER);
        expect(menu).toHaveAttribute('data-lost', 'true');
        await userEvent.click(screen.getByRole('button', { name: 'Close' }));

        await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
        await userEvent.click(
            within(screen.getByRole('dialog', { name: 'Discard your unsaved ink?' })).getByRole('button', {
                name: 'Discard',
            }),
        );
        expect(heldInkForExport(USER, DOC, true).held).toEqual([]);
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
});
