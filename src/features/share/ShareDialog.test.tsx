import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ShareDialog } from '@/features/share/ShareDialog';
import type * as ShareServiceModule from '@/features/share/shareService';
import type { DocumentMemberListing, ShareLinkRow } from '@/types/database';

const createShareLink = vi.fn();
const listShareLinks = vi.fn();
const listDocumentMembers = vi.fn();
const revokeShareLink = vi.fn();
const setMemberRole = vi.fn();
const removeMember = vi.fn();
const leaveDocument = vi.fn();

vi.mock('@/features/share/shareService', async () => {
    const actual = await vi.importActual<typeof ShareServiceModule>('@/features/share/shareService');
    return {
        ...actual,
        createShareLink: (...args: unknown[]) => createShareLink(...args),
        listShareLinks: (...args: unknown[]) => listShareLinks(...args),
        listDocumentMembers: (...args: unknown[]) => listDocumentMembers(...args),
        revokeShareLink: (...args: unknown[]) => revokeShareLink(...args),
        setMemberRole: (...args: unknown[]) => setMemberRole(...args),
        removeMember: (...args: unknown[]) => removeMember(...args),
        leaveDocument: (...args: unknown[]) => leaveDocument(...args),
    };
});

const DAY = 24 * 60 * 60 * 1000;

const link = (token: string, overrides: Partial<ShareLinkRow> = {}): ShareLinkRow => ({
    token,
    document_id: 'doc-1',
    role: 'viewer',
    created_by: 'owner-1',
    created_at: '2026-10-01T00:00:00Z',
    expires_at: new Date(Date.now() + 5 * DAY).toISOString(),
    revoked_at: null,
    ...overrides,
});

const member = (userId: string, overrides: Partial<DocumentMemberListing> = {}): DocumentMemberListing => ({
    user_id: userId,
    role: 'editor',
    display_name: null,
    email: null,
    is_anonymous: false,
    is_student: false,
    joined_via_link: null,
    joined_at: '2026-10-01T00:00:00Z',
    ...overrides,
});

const MEMBERS = [
    member('owner-1', { role: 'owner', display_name: 'Olive', email: 'olive@x.test' }),
    member('ed', { role: 'editor', display_name: 'Ed', email: 'ed@x.test' }),
    member('guest', { role: 'editor', display_name: 'Guest One', is_anonymous: true, joined_via_link: 'tok-edit' }),
    member('vi', { role: 'viewer', email: 'vi@x.test', joined_via_link: 'tok-edit' }),
];

const renderOwner = () => render(<ShareDialog docId="doc-1" userId="owner-1" role="owner" onClose={vi.fn()} />);

beforeEach(() => {
    vi.clearAllMocks();
    listShareLinks.mockResolvedValue([
        link('tok-edit', { role: 'editor', expires_at: null }),
        link('tok-old', { expires_at: new Date(Date.now() - DAY).toISOString() }),
    ]);
    // userEvent.setup() supplies navigator.clipboard for the copy step.
    listDocumentMembers.mockResolvedValue(MEMBERS);
});

afterEach(() => {
    cleanup();
});

describe('ShareDialog for the owner', () => {
    it('defaults a new link to view-only, expiring in 7 days', async () => {
        const user = userEvent.setup();
        createShareLink.mockResolvedValue(link('tok-new'));
        renderOwner();

        expect(screen.getByRole('button', { name: 'View only' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Can edit' })).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByRole('combobox', { name: 'Link expires after' })).toHaveValue('7d');

        await user.click(screen.getByRole('button', { name: 'Create link & copy' }));
        await waitFor(() => expect(createShareLink).toHaveBeenCalledWith('doc-1', 'viewer', 'owner-1', '7d'));
    });

    it('creates the link the owner picked', async () => {
        const user = userEvent.setup();
        createShareLink.mockResolvedValue(link('tok-new'));
        renderOwner();

        await user.click(screen.getByRole('button', { name: 'Can edit' }));
        await user.selectOptions(screen.getByRole('combobox', { name: 'Link expires after' }), 'never');
        await user.click(screen.getByRole('button', { name: 'Create link & copy' }));

        await waitFor(() => expect(createShareLink).toHaveBeenCalledWith('doc-1', 'editor', 'owner-1', 'never'));
    });

    it('shows each link’s access, expiry and how many joined through it', async () => {
        renderOwner();
        const items = await screen.findAllByRole('listitem');
        const editLink = items.find((li) => li.textContent?.includes('/join/tok-edit')) as HTMLElement;
        const oldLink = items.find((li) => li.textContent?.includes('/join/tok-old')) as HTMLElement;

        expect(editLink).toHaveTextContent('edit');
        expect(editLink).toHaveTextContent('Never expires · 2 joined');
        expect(oldLink).toHaveTextContent('Expired');
        expect(within(oldLink).getByRole('button', { name: 'Copy' })).toBeDisabled();
    });

    it('lists people with their access, the owner fixed and labelled', async () => {
        renderOwner();
        await screen.findByText('Ed');

        expect(screen.getByText('Olive')).toBeInTheDocument();
        expect(screen.getByText('Owner')).toBeInTheDocument();
        expect(screen.queryByRole('combobox', { name: 'Access for Olive' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Remove Olive' })).not.toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Access for Ed' })).toHaveValue('editor');
        expect(screen.getByRole('combobox', { name: 'Access for vi@x.test' })).toHaveValue('viewer');
        expect(screen.getByText('Guest')).toBeInTheDocument();
    });

    it('changes a member’s role through the RPC', async () => {
        const user = userEvent.setup();
        setMemberRole.mockResolvedValue(undefined);
        renderOwner();
        await screen.findByText('Ed');

        await user.selectOptions(screen.getByRole('combobox', { name: 'Access for Ed' }), 'viewer');

        expect(setMemberRole).toHaveBeenCalledWith('doc-1', 'ed', 'viewer');
        expect(screen.getByRole('combobox', { name: 'Access for Ed' })).toHaveValue('viewer');
    });

    it('puts the role back when the change is refused', async () => {
        const user = userEvent.setup();
        setMemberRole.mockRejectedValue(new Error('Could not change their access: denied'));
        renderOwner();
        await screen.findByText('Ed');

        await user.selectOptions(screen.getByRole('combobox', { name: 'Access for Ed' }), 'viewer');

        expect(await screen.findByText('Could not change their access: denied')).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Access for Ed' })).toHaveValue('editor');
    });

    it('removes a member only after confirming', async () => {
        const user = userEvent.setup();
        removeMember.mockResolvedValue(undefined);
        renderOwner();
        await screen.findByText('Guest One');

        await user.click(screen.getByRole('button', { name: 'Remove Guest One' }));
        const confirm = screen.getByRole('dialog', { name: 'Remove Guest One?' });
        // Their link still works — the owner should know they can come back.
        expect(confirm).toHaveTextContent('The link they joined with still works');
        expect(removeMember).not.toHaveBeenCalled();

        await user.click(within(confirm).getByRole('button', { name: 'Remove' }));

        await waitFor(() => expect(removeMember).toHaveBeenCalledWith('doc-1', 'guest'));
        await waitFor(() => expect(screen.queryByText('Guest One')).not.toBeInTheDocument());
    });

    it('revokes a link and, by default, removes the people who joined with it', async () => {
        const user = userEvent.setup();
        revokeShareLink.mockResolvedValue(2);
        renderOwner();
        const items = await screen.findAllByRole('listitem');
        const editLink = items.find((li) => li.textContent?.includes('/join/tok-edit')) as HTMLElement;

        await user.click(within(editLink).getByRole('button', { name: 'Revoke' }));
        const confirm = screen.getByRole('dialog', { name: 'Revoke this link?' });
        const checkbox = within(confirm).getByRole('checkbox', { name: /remove the 2 people who joined/ });
        expect(checkbox).toBeChecked();

        await user.click(within(confirm).getByRole('button', { name: 'Revoke link' }));

        await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('tok-edit', { removeMembers: true }));
        expect(listShareLinks).toHaveBeenCalledTimes(2);
    });

    it('can revoke a link and keep the people who joined', async () => {
        const user = userEvent.setup();
        revokeShareLink.mockResolvedValue(0);
        renderOwner();
        const items = await screen.findAllByRole('listitem');
        const editLink = items.find((li) => li.textContent?.includes('/join/tok-edit')) as HTMLElement;

        await user.click(within(editLink).getByRole('button', { name: 'Revoke' }));
        const confirm = screen.getByRole('dialog', { name: 'Revoke this link?' });
        await user.click(within(confirm).getByRole('checkbox'));
        await user.click(within(confirm).getByRole('button', { name: 'Revoke link' }));

        await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('tok-edit', { removeMembers: false }));
    });

    it('offers no removal choice for a link nobody joined through', async () => {
        const user = userEvent.setup();
        revokeShareLink.mockResolvedValue(0);
        renderOwner();
        const items = await screen.findAllByRole('listitem');
        const oldLink = items.find((li) => li.textContent?.includes('/join/tok-old')) as HTMLElement;

        await user.click(within(oldLink).getByRole('button', { name: 'Revoke' }));
        const confirm = screen.getByRole('dialog', { name: 'Revoke this link?' });
        expect(within(confirm).queryByRole('checkbox')).not.toBeInTheDocument();
        await user.click(within(confirm).getByRole('button', { name: 'Revoke link' }));

        await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('tok-old', { removeMembers: false }));
    });

    it('never offers the owner a way to leave their own score', async () => {
        renderOwner();
        await screen.findByText('Ed');
        expect(screen.queryByRole('button', { name: 'Leave score' })).not.toBeInTheDocument();
    });
});

describe('ShareDialog for a member', () => {
    it('shows an editor who else is here, read-only, and offers to leave', async () => {
        render(<ShareDialog docId="doc-1" userId="ed" role="editor" onClose={vi.fn()} />);

        expect(await screen.findByText('Olive')).toBeInTheDocument();
        expect(screen.getByText('(you)')).toBeInTheDocument();
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Create link & copy' })).not.toBeInTheDocument();
        expect(listShareLinks).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Leave score' })).toBeInTheDocument();
    });

    it('does not ask a viewer’s session for the member list', async () => {
        render(<ShareDialog docId="doc-1" userId="vi" role="viewer" onClose={vi.fn()} />);

        expect(screen.getByText(/You can view it/)).toBeInTheDocument();
        expect(listDocumentMembers).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Leave score' })).toBeInTheDocument();
    });

    it('leaves after confirming, then tells the parent', async () => {
        const user = userEvent.setup();
        const onLeft = vi.fn();
        leaveDocument.mockResolvedValue(undefined);
        render(<ShareDialog docId="doc-1" userId="vi" role="viewer" onClose={vi.fn()} onLeft={onLeft} />);

        await user.click(screen.getByRole('button', { name: 'Leave score' }));
        const confirm = screen.getByRole('dialog', { name: 'Leave this score?' });
        expect(leaveDocument).not.toHaveBeenCalled();
        await user.click(within(confirm).getByRole('button', { name: 'Leave' }));

        await waitFor(() => expect(onLeft).toHaveBeenCalled());
        expect(leaveDocument).toHaveBeenCalledWith('doc-1');
    });

    it('stays put and explains when leaving is refused', async () => {
        const user = userEvent.setup();
        const onLeft = vi.fn();
        leaveDocument.mockRejectedValue(new Error('Your teacher assigned this score, so only they can remove it.'));
        render(<ShareDialog docId="doc-1" userId="vi" role="viewer" onClose={vi.fn()} onLeft={onLeft} />);

        await user.click(screen.getByRole('button', { name: 'Leave score' }));
        await user.click(screen.getByRole('button', { name: 'Leave' }));

        expect(await screen.findByText(/Your teacher assigned this score/)).toBeInTheDocument();
        expect(onLeft).not.toHaveBeenCalled();
    });

    it('hides Leave when the caller cannot leave', () => {
        render(<ShareDialog docId="doc-1" userId="vi" role="viewer" canLeave={false} onClose={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Leave score' })).not.toBeInTheDocument();
    });
});
