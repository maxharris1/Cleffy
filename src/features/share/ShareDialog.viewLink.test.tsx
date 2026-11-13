import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShareDialog } from '@/features/share/ShareDialog';
import type * as ShareServiceModule from '@/features/share/shareService';
import type { ViewLinkRow } from '@/types/database';

/** Release flags (src/lib/features.ts), flipped per test; read at render. */
const flags = vi.hoisted(() => ({ viewLinks: false }));
vi.mock('@/lib/features', () => ({ features: flags }));

const listShareLinks = vi.fn();
const listDocumentMembers = vi.fn();
const getViewLink = vi.fn();
const createViewLink = vi.fn();
const rotateViewLink = vi.fn();
const revokeViewLink = vi.fn();

vi.mock('@/features/share/shareService', async () => {
    const actual = await vi.importActual<typeof ShareServiceModule>('@/features/share/shareService');
    return {
        ...actual,
        listShareLinks: (...args: unknown[]) => listShareLinks(...args),
        listDocumentMembers: (...args: unknown[]) => listDocumentMembers(...args),
        getViewLink: (...args: unknown[]) => getViewLink(...args),
        createViewLink: (...args: unknown[]) => createViewLink(...args),
        rotateViewLink: (...args: unknown[]) => rotateViewLink(...args),
        revokeViewLink: (...args: unknown[]) => revokeViewLink(...args),
    };
});

const TOKEN = 'v'.repeat(43);
const NEW_TOKEN = 'n'.repeat(43);
const HEADING = 'View link for students (no account)';
const COPY =
    'Shows this score live to anyone with the link. No account, nothing to type. Use it for students under 13 instead of an account.';

const DAY = 24 * 60 * 60 * 1000;

/** An unrevoked row; live for another 30 days unless `expiresInMs` says otherwise. */
const row = (token: string, expiresInMs = 30 * DAY): ViewLinkRow => ({
    id: 'vl-1',
    document_id: 'doc-1',
    created_by: 'owner-1',
    token,
    created_at: new Date(Date.now() + expiresInMs - 90 * DAY).toISOString(),
    expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    revoked_at: null,
});

const renderAs = (role: 'owner' | 'editor' | 'viewer') =>
    render(<ShareDialog docId="doc-1" userId="owner-1" role={role} onClose={vi.fn()} />);

const section = async () => {
    const heading = await screen.findByRole('heading', { name: HEADING });
    return heading.closest('section') as HTMLElement;
};

beforeEach(() => {
    vi.clearAllMocks();
    flags.viewLinks = false;
    listShareLinks.mockResolvedValue([]);
    listDocumentMembers.mockResolvedValue([]);
    getViewLink.mockResolvedValue(null);
});

afterEach(() => {
    cleanup();
    flags.viewLinks = false;
});

describe('with the switch off', () => {
    it('shows no view-link section and makes no view-link call', async () => {
        renderAs('owner');
        await screen.findByText('No links yet.');
        expect(screen.queryByText(HEADING)).toBeNull();
        expect(screen.queryByText(/view link/i)).toBeNull();
        expect(getViewLink).not.toHaveBeenCalled();
    });
});

describe('with the switch on', () => {
    beforeEach(() => {
        flags.viewLinks = true;
    });

    it('shows the section, with its explanation, to the owner', async () => {
        renderAs('owner');
        const el = await section();
        expect(within(el).getByText(COPY)).toBeInTheDocument();
        expect(getViewLink).toHaveBeenCalledWith('doc-1');
    });

    it.each(['editor', 'viewer'] as const)('shows nothing of it to an %s', async (role) => {
        renderAs(role);
        await screen.findByText(/This score was shared with you/);
        expect(screen.queryByText(HEADING)).toBeNull();
        expect(getViewLink).not.toHaveBeenCalled();
    });

    it('creates a link and copies https://<host>/v#<token>', async () => {
        const user = userEvent.setup();
        createViewLink.mockResolvedValue(TOKEN);
        renderAs('owner');
        const el = await section();
        await user.click(within(el).getByRole('button', { name: 'Create view link' }));
        expect(createViewLink).toHaveBeenCalledWith('doc-1');
        expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/v#${TOKEN}`);
        expect(within(el).getByTitle(`${window.location.origin}/v#${TOKEN}`)).toBeInTheDocument();
    });

    it('copies an existing link', async () => {
        const user = userEvent.setup();
        getViewLink.mockResolvedValue(row(TOKEN));
        renderAs('owner');
        const el = await section();
        await user.click(await within(el).findByRole('button', { name: 'Copy' }));
        expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/v#${TOKEN}`);
    });

    it('rotates only after a confirm that says the old link stops working', async () => {
        const user = userEvent.setup();
        getViewLink.mockResolvedValue(row(TOKEN));
        rotateViewLink.mockResolvedValue(NEW_TOKEN);
        renderAs('owner');
        const el = await section();
        await user.click(await within(el).findByRole('button', { name: 'Rotate' }));
        expect(rotateViewLink).not.toHaveBeenCalled();
        const dialog = await screen.findByRole('alertdialog', { name: /new view link/i });
        expect(within(dialog).getByText(/the old link stops working/i)).toBeInTheDocument();
        await user.click(within(dialog).getByRole('button', { name: 'Rotate link' }));
        expect(rotateViewLink).toHaveBeenCalledWith('doc-1');
        expect(await within(el).findByTitle(`${window.location.origin}/v#${NEW_TOKEN}`)).toBeInTheDocument();
        expect(within(el).queryByTitle(`${window.location.origin}/v#${TOKEN}`)).toBeNull();
    });

    it('revokes after a confirm, and offers to create again', async () => {
        const user = userEvent.setup();
        getViewLink.mockResolvedValue(row(TOKEN));
        revokeViewLink.mockResolvedValue(undefined);
        renderAs('owner');
        const el = await section();
        await user.click(await within(el).findByRole('button', { name: 'Revoke' }));
        const dialog = await screen.findByRole('alertdialog', { name: /turn off the view link/i });
        await user.click(within(dialog).getByRole('button', { name: 'Revoke link' }));
        expect(revokeViewLink).toHaveBeenCalledWith('doc-1');
        expect(await within(el).findByRole('button', { name: 'Create view link' })).toBeInTheDocument();
    });

    it('never shows or copies an expired link: it says the link expired and offers Create', async () => {
        const user = userEvent.setup();
        // Expired a second ago and not yet purged: the server answers 410 for it.
        getViewLink.mockResolvedValue(row(TOKEN, -1000));
        createViewLink.mockResolvedValue(NEW_TOKEN);
        renderAs('owner');
        const el = await section();
        expect(await within(el).findByText(/expired/i)).toBeInTheDocument();
        expect(within(el).queryByTitle(`${window.location.origin}/v#${TOKEN}`)).toBeNull();
        expect(within(el).queryByText(new RegExp(TOKEN))).toBeNull();
        expect(within(el).queryByRole('button', { name: 'Copy' })).toBeNull();
        expect(within(el).queryByRole('button', { name: 'Rotate' })).toBeNull();
        expect(within(el).queryByRole('button', { name: 'Revoke' })).toBeNull();
        await user.click(within(el).getByRole('button', { name: 'Create view link' }));
        expect(createViewLink).toHaveBeenCalledWith('doc-1');
        expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/v#${NEW_TOKEN}`);
        expect(await within(el).findByTitle(`${window.location.origin}/v#${NEW_TOKEN}`)).toBeInTheDocument();
        expect(within(el).queryByText(/expired/i)).toBeNull();
    });

    it('says so when a call fails, and keeps the rest of the dialog working', async () => {
        const user = userEvent.setup();
        createViewLink.mockRejectedValue(new Error('Could not create the view link: nope'));
        renderAs('owner');
        const el = await section();
        await user.click(within(el).getByRole('button', { name: 'Create view link' }));
        expect(await within(el).findByText(/Could not create the view link/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Create link & copy' })).toBeEnabled();
    });
});
