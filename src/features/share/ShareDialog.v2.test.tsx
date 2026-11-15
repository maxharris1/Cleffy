import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShareDialog } from '@/features/share/ShareDialog';
import type * as ShareServiceModule from '@/features/share/shareService';
import type { DocumentMemberListing, ShareLinkRow } from '@/types/database';

const flags = vi.hoisted(() => ({ shareV2: true }));
vi.mock('@/lib/features', () => ({ features: flags }));

const svc = vi.hoisted(() => ({
    loadOwnerSharing: vi.fn(),
    listDocumentMembers: vi.fn(),
    listPendingInvites: vi.fn(),
    setGeneralAccess: vi.fn(),
    changeGeneralLinkRole: vi.fn(),
    resetGeneralLink: vi.fn(),
    renewLink: vi.fn(),
    inviteByEmail: vi.fn(),
    resendInvite: vi.fn(),
    cancelInvite: vi.fn(),
    getLinkGuestRetention: vi.fn(),
    setLinkGuestRetention: vi.fn(),
    revokeShareLink: vi.fn(),
    setMemberRole: vi.fn(),
    removeMember: vi.fn(),
    listShareLinks: vi.fn(),
}));

vi.mock('@/features/share/shareService', async () => {
    const actual = await vi.importActual<typeof ShareServiceModule>('@/features/share/shareService');
    const wrapped = Object.fromEntries(
        Object.entries(svc).map(([name, fn]) => [name, (...args: unknown[]) => fn(...args)]),
    );
    return { ...actual, ...wrapped };
});

const DAY = 24 * 60 * 60 * 1000;

const link = (token: string, overrides: Partial<ShareLinkRow> = {}): ShareLinkRow => ({
    id: `id-${token}`,
    token,
    document_id: 'doc-1',
    role: 'viewer',
    created_by: 'owner-1',
    created_at: '2026-10-01T00:00:00Z',
    expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
    revoked_at: null,
    general: true,
    ...overrides,
});

const member = (userId: string, overrides: Partial<DocumentMemberListing> = {}): DocumentMemberListing => ({
    user_id: userId,
    role: 'editor',
    display_name: null,
    email: null,
    is_anonymous: false,
    is_assigned: false,
    joined_via_link: null,
    joined_at: '2026-10-01T00:00:00Z',
    ...overrides,
});

const MEMBERS = [
    member('owner-1', { role: 'owner', display_name: 'Max Harris', email: 'max@x.test' }),
    member('leo', { role: 'editor', display_name: 'Leo', email: 'leo@x.test' }),
    member('sam', { role: 'viewer', display_name: 'Sam', is_anonymous: true, joined_via_link: 'tok-gen' }),
];

const renderOwner = (linkViewers = 0) =>
    render(<ShareDialog docId="doc-1" userId="owner-1" role="owner" linkViewers={linkViewers} onClose={vi.fn()} />);

beforeEach(() => {
    vi.clearAllMocks();
    flags.shareV2 = true;
    svc.loadOwnerSharing.mockResolvedValue({ general: null, older: [] });
    svc.listDocumentMembers.mockResolvedValue(MEMBERS);
    svc.listPendingInvites.mockResolvedValue([]);
    svc.getLinkGuestRetention.mockResolvedValue(30);
    svc.setLinkGuestRetention.mockImplementation((days: number) => Promise.resolve(days));
    svc.setGeneralAccess.mockResolvedValue({ id: 'id-new', token: 'tok-new', role: 'viewer', expiresAt: null });
    svc.changeGeneralLinkRole.mockResolvedValue(undefined);
    svc.inviteByEmail.mockResolvedValue(undefined);
    svc.resendInvite.mockResolvedValue(undefined);
    svc.cancelInvite.mockResolvedValue(undefined);
    svc.renewLink.mockResolvedValue(new Date(Date.now() + 30 * DAY).toISOString());
    svc.resetGeneralLink.mockResolvedValue({ id: 'id-r', token: 'tok-reset', role: 'viewer', expiresAt: null });
    svc.revokeShareLink.mockResolvedValue(1);
    svc.setMemberRole.mockResolvedValue(undefined);
    svc.removeMember.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('Share dialog v2 (owner)', () => {
    it('lists people with names, roles and Remove; a link guest reads "guest, joined by link"', async () => {
        renderOwner();
        expect(await screen.findByText('Leo')).toBeInTheDocument();
        expect(screen.getByText('guest, joined by link')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Remove Leo' })).toBeInTheDocument();
        const select = screen.getByRole('combobox', { name: 'Access for Leo' });
        expect(select.className.split(/\s+/)).not.toContain('w-full');
        expect(select).toHaveClass('w-auto', 'shrink-0');
        expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('turning on Anyone with the link uses the chosen expiry (7 days by default) and copies an /s# link', async () => {
        const user = userEvent.setup();
        renderOwner();
        const expiry = await screen.findByRole('combobox', { name: 'Link expires after' });
        expect(expiry).toHaveValue('7d');
        expect([...(expiry as HTMLSelectElement).options].map((o) => o.text)).toEqual([
            '1 day',
            '7 days',
            '30 days',
            '90 days',
            '1 year',
            'Never',
        ]);
        await user.selectOptions(expiry, '30d');
        svc.loadOwnerSharing.mockResolvedValue({ general: link('tok-new'), older: [] });
        await user.selectOptions(screen.getByRole('combobox', { name: 'General access' }), 'anyone');
        await waitFor(() => expect(svc.setGeneralAccess).toHaveBeenCalledWith('doc-1', 'anyone', 'viewer', '30d'));
        expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/s#tok-new`);
        expect(await screen.findByText(/^Expires .* \(in 7 days\)$/)).toBeInTheDocument();
    });

    it('View/Edit changes the role on the same link, keeping its expiry', async () => {
        const user = userEvent.setup();
        const general = link('tok-gen');
        svc.loadOwnerSharing.mockResolvedValue({ general, older: [] });
        renderOwner();
        await user.selectOptions(await screen.findByRole('combobox', { name: 'People with the link can' }), 'editor');
        await waitFor(() =>
            expect(svc.changeGeneralLinkRole).toHaveBeenCalledWith('doc-1', 'editor', general.expires_at),
        );
    });

    it('Restricted asks first, then turns the link off', async () => {
        const user = userEvent.setup();
        svc.loadOwnerSharing.mockResolvedValue({ general: link('tok-gen'), older: [] });
        renderOwner();
        await user.selectOptions(await screen.findByRole('combobox', { name: 'General access' }), 'restricted');
        expect(svc.setGeneralAccess).not.toHaveBeenCalled();
        const dialog = await screen.findByRole('alertdialog', { name: 'Turn off the link?' });
        await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
        await waitFor(() =>
            expect(svc.setGeneralAccess).toHaveBeenCalledWith('doc-1', 'restricted', 'viewer', 'never'),
        );
    });

    it('shows "N viewing now" for a view link', async () => {
        svc.loadOwnerSharing.mockResolvedValue({ general: link('tok-gen'), older: [] });
        renderOwner(3);
        expect(await screen.findByText('3 viewing now')).toBeInTheDocument();
    });

    it('Reset asks first, then issues a new link and copies it', async () => {
        const user = userEvent.setup();
        svc.loadOwnerSharing.mockResolvedValue({ general: link('tok-gen'), older: [] });
        renderOwner();
        await user.click(await screen.findByRole('button', { name: 'Reset link' }));
        const dialog = await screen.findByRole('alertdialog', { name: 'Reset the link?' });
        await user.click(within(dialog).getByRole('button', { name: 'Reset link' }));
        await waitFor(() => expect(svc.resetGeneralLink).toHaveBeenCalledWith('doc-1'));
        expect(await navigator.clipboard.readText()).toBe(`${window.location.origin}/s#tok-reset`);
    });

    it('Renew on an expired link makes it live, and a bounds error from the server shows inline', async () => {
        const user = userEvent.setup();
        const expired = link('tok-gen', { expires_at: new Date(Date.now() - DAY).toISOString() });
        svc.loadOwnerSharing.mockResolvedValue({ general: expired, older: [] });
        renderOwner();
        expect(await screen.findByText(/^Expired on /)).toBeInTheDocument();
        svc.loadOwnerSharing.mockResolvedValue({
            general: link('tok-gen', { expires_at: new Date(Date.now() + 30 * DAY).toISOString() }),
            older: [],
        });
        await user.selectOptions(screen.getByRole('combobox', { name: 'Renew the link for' }), '30d');
        await waitFor(() => expect(svc.renewLink).toHaveBeenCalledWith('id-tok-gen', '30d'));
        expect(await screen.findByText(/\(in 30 days\)$/)).toBeInTheDocument();

        const { ShareError } = await vi.importActual<typeof ShareServiceModule>('@/features/share/shareService');
        svc.renewLink.mockRejectedValue(
            new ShareError(
                'That expiry is outside what links allow (1 hour to 1 year, or never).',
                'invalid_link_expiry',
            ),
        );
        await user.selectOptions(screen.getByRole('combobox', { name: 'Renew the link for' }), '365d');
        expect(await screen.findByText(/outside what links allow/)).toBeInTheDocument();
    });

    it('invites by email and role, and shows the refusal for a roster student (D7) and the 429 wait', async () => {
        const user = userEvent.setup();
        renderOwner();
        await user.type(await screen.findByRole('textbox', { name: 'Add people by email' }), 'ana@example.org');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Invite as' }), 'editor');
        svc.listPendingInvites.mockResolvedValue([
            { id: 'inv-1', email: 'ana@example.org', role: 'editor', expiresAt: '2026-11-27T12:00:00Z' },
        ]);
        await user.click(screen.getByRole('button', { name: 'Invite' }));
        await waitFor(() => expect(svc.inviteByEmail).toHaveBeenCalledWith('doc-1', 'ana@example.org', 'editor'));
        expect(await screen.findByText('Invite sent to ana@example.org.')).toBeInTheDocument();
        expect(screen.getByText(/Invited as editor · expires 27 Nov/)).toBeInTheDocument();

        const { ShareError } = await vi.importActual<typeof ShareServiceModule>('@/features/share/shareService');
        svc.inviteByEmail.mockRejectedValueOnce(
            new ShareError('This address can’t be invited here. If they’re your student, use Assign.', 'cannot_invite'),
        );
        await user.type(screen.getByRole('textbox', { name: 'Add people by email' }), 'kid@school.test');
        await user.click(screen.getByRole('button', { name: 'Invite' }));
        expect(await screen.findByText(/If they’re your student, use Assign/)).toBeInTheDocument();

        svc.inviteByEmail.mockRejectedValueOnce(
            new ShareError('Too many invites just now. Try again in 2 min.', 'rate_limited'),
        );
        await user.click(screen.getByRole('button', { name: 'Invite' }));
        expect(await screen.findByText(/Try again in 2 min/)).toBeInTheDocument();
    });

    it('resends and cancels a pending invite', async () => {
        const user = userEvent.setup();
        svc.listPendingInvites.mockResolvedValue([
            { id: 'inv-1', email: 'ana@example.org', role: 'viewer', expiresAt: '2026-11-27T12:00:00Z' },
        ]);
        renderOwner();
        await user.click(await screen.findByRole('button', { name: 'Resend' }));
        await waitFor(() => expect(svc.resendInvite).toHaveBeenCalledWith('doc-1', 'inv-1'));
        await user.click(screen.getByRole('button', { name: 'Cancel the invite for ana@example.org' }));
        await waitFor(() => expect(svc.cancelInvite).toHaveBeenCalledWith('doc-1', 'inv-1'));
    });

    it('shows Older links only while one is active; revoking always removes who joined (D4)', async () => {
        const user = userEvent.setup();
        const { unmount } = renderOwner();
        await screen.findByText('Leo');
        expect(screen.queryByText(/Older links/)).toBeNull();
        unmount();

        svc.loadOwnerSharing.mockResolvedValue({ general: null, older: [link('tok-old', { general: false })] });
        renderOwner();
        expect(await screen.findByText('Older links (1)')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Revoke' }));
        const dialog = await screen.findByRole('alertdialog', { name: 'Revoke this link?' });
        expect(within(dialog).queryByRole('checkbox')).toBeNull();
        await user.click(within(dialog).getByRole('button', { name: 'Revoke link' }));
        await waitFor(() => expect(svc.revokeShareLink).toHaveBeenCalledWith('tok-old', { removeMembers: true }));
        expect(screen.queryByRole('button', { name: /Create link/ })).toBeNull();
    });

    it('shows the idle-guest setting (30 days), saves a change, and shows a bounds error inline', async () => {
        const user = userEvent.setup();
        renderOwner();
        const select = await screen.findByRole('combobox', { name: 'Remove idle link guests after' });
        await waitFor(() => expect(select).toHaveValue('30'));
        expect([...(select as HTMLSelectElement).options].map((o) => o.value)).toEqual(['7', '14', '30', '60', '90']);
        await user.selectOptions(select, '60');
        await waitFor(() => expect(svc.setLinkGuestRetention).toHaveBeenCalledWith(60));
        expect(await screen.findByText('Saved.')).toBeInTheDocument();

        const { ShareError } = await vi.importActual<typeof ShareServiceModule>('@/features/share/shareService');
        svc.setLinkGuestRetention.mockRejectedValueOnce(
            new ShareError('Choose between 1 and 90 days.', 'invalid_retention_days'),
        );
        await user.selectOptions(select, '90');
        expect(await screen.findByText('Choose between 1 and 90 days.')).toBeInTheDocument();
        expect(select).toHaveValue('60');
    });

    it('members who are not the owner keep the member view (D6)', async () => {
        render(<ShareDialog docId="doc-1" userId="leo" role="editor" onClose={vi.fn()} />);
        expect(await screen.findByText(/This score was shared with you/)).toBeInTheDocument();
        expect(screen.queryByRole('combobox', { name: 'General access' })).toBeNull();
    });
});
