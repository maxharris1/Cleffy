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
const deleteGuestProfile = vi.fn();

vi.mock('@/features/account/accountDeletion', () => ({
    GUEST_DELETED_PATH: '/account-deleted?guest=1',
    deleteGuestProfile: () => deleteGuestProfile(),
}));

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
    is_assigned: false,
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

    it('still removes late joiners when the list showed nobody joined through the link', async () => {
        const user = userEvent.setup();
        revokeShareLink.mockResolvedValue(0);
        renderOwner();
        const items = await screen.findAllByRole('listitem');
        const oldLink = items.find((li) => li.textContent?.includes('/join/tok-old')) as HTMLElement;

        await user.click(within(oldLink).getByRole('button', { name: 'Revoke' }));
        const confirm = screen.getByRole('dialog', { name: 'Revoke this link?' });
        expect(within(confirm).queryByRole('checkbox')).not.toBeInTheDocument();
        expect(confirm).toHaveTextContent('Anyone who has joined with it loses access too.');
        await user.click(within(confirm).getByRole('button', { name: 'Revoke link' }));

        // The server removes by its own provenance: someone who joined after
        // the list loaded goes too, which is what revoking means by default.
        await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('tok-old', { removeMembers: true }));
    });

    it('keeps links visible and revocable when the member list fails to load', async () => {
        const user = userEvent.setup();
        listDocumentMembers.mockRejectedValue(new Error('Could not load collaborators: function does not exist'));
        revokeShareLink.mockResolvedValue(1);
        renderOwner();

        expect(await screen.findByText('Could not load collaborators: function does not exist')).toBeInTheDocument();
        const items = await screen.findAllByRole('listitem');
        const editLink = items.find((li) => li.textContent?.includes('/join/tok-edit')) as HTMLElement;
        expect(editLink).toBeDefined();
        expect(screen.queryByText('No links yet.')).not.toBeInTheDocument();

        await user.click(within(editLink).getByRole('button', { name: 'Revoke' }));
        const confirm = screen.getByRole('dialog', { name: 'Revoke this link?' });
        await user.click(within(confirm).getByRole('button', { name: 'Revoke link' }));

        // Nobody is known to have joined, and the owner made no choice to keep
        // anyone: the conservative default reaches the server.
        await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('tok-edit', { removeMembers: true }));
    });

    it('keeps the member list when only the links fail to load', async () => {
        listShareLinks.mockRejectedValue(new Error('Could not load share links: timeout'));
        renderOwner();

        expect(await screen.findByText('Ed')).toBeInTheDocument();
        expect(await screen.findByText('Could not load share links: timeout')).toBeInTheDocument();
        expect(screen.queryByText('No links yet.')).not.toBeInTheDocument();
    });

    it('shows and copies a new link even when the reload after creating it fails', async () => {
        const user = userEvent.setup();
        createShareLink.mockResolvedValue(link('tok-new'));
        renderOwner();
        await screen.findByText('Ed');

        listShareLinks.mockRejectedValue(new Error('Could not load share links: timeout'));
        await user.click(screen.getByRole('button', { name: 'Create link & copy' }));

        await waitFor(() => expect(screen.getByText(/\/join\/tok-new/)).toBeInTheDocument());
        expect(await navigator.clipboard.readText()).toContain('/join/tok-new');
        expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
        expect(screen.queryByText(/Could not create the link/)).not.toBeInTheDocument();
    });

    it('warns, and offers to revoke, when a demoted member’s edit link still works', async () => {
        const user = userEvent.setup();
        setMemberRole.mockResolvedValue(undefined);
        revokeShareLink.mockResolvedValue(2);
        renderOwner();
        await screen.findByText('Guest One');

        await user.selectOptions(screen.getByRole('combobox', { name: 'Access for Guest One' }), 'viewer');

        const notice = await screen.findByRole('status');
        expect(notice).toHaveTextContent('Guest One can only view now, but the edit link they joined with still works');
        await user.click(within(notice).getByRole('button', { name: 'Revoke that link…' }));
        const confirm = screen.getByRole('dialog', { name: 'Revoke this link?' });
        await user.click(within(confirm).getByRole('button', { name: 'Revoke link' }));

        await waitFor(() => expect(revokeShareLink).toHaveBeenCalledWith('tok-edit', { removeMembers: true }));
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    });

    it('says nothing extra when a demoted member joined some other way', async () => {
        const user = userEvent.setup();
        setMemberRole.mockResolvedValue(undefined);
        renderOwner();
        await screen.findByText('Ed');

        await user.selectOptions(screen.getByRole('combobox', { name: 'Access for Ed' }), 'viewer');

        await waitFor(() => expect(setMemberRole).toHaveBeenCalledWith('doc-1', 'ed', 'viewer'));
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
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

    it('offers a registered member no guest-profile deletion', () => {
        render(<ShareDialog docId="doc-1" userId="vi" role="viewer" onClose={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Delete my guest profile' })).not.toBeInTheDocument();
    });
});

describe('ShareDialog for a share-link guest', () => {
    it('deletes the guest profile after confirming, then leaves the page', async () => {
        const user = userEvent.setup();
        const onGuestDeleted = vi.fn();
        deleteGuestProfile.mockResolvedValue(undefined);
        render(
            <ShareDialog
                docId="doc-1"
                userId="guest"
                role="editor"
                isGuest
                onClose={vi.fn()}
                onGuestDeleted={onGuestDeleted}
            />,
        );

        // Leaving one score is still on offer beside it.
        expect(screen.getByRole('button', { name: 'Leave score' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Delete my guest profile' }));
        const confirm = screen.getByRole('dialog', { name: 'Delete your guest profile?' });
        expect(confirm).toHaveTextContent(/removed from every score shared with you/);
        expect(confirm).toHaveTextContent(/Marks you made stay on the scores/);
        expect(deleteGuestProfile).not.toHaveBeenCalled();
        await user.click(within(confirm).getByRole('button', { name: 'Delete guest profile' }));

        await waitFor(() => expect(onGuestDeleted).toHaveBeenCalled());
        expect(deleteGuestProfile).toHaveBeenCalledTimes(1);
        expect(leaveDocument).not.toHaveBeenCalled();
    });

    it('stays put and explains when the deletion did not finish', async () => {
        const user = userEvent.setup();
        const onGuestDeleted = vi.fn();
        deleteGuestProfile.mockRejectedValue(new Error('We could not finish deleting your guest profile.'));
        render(
            <ShareDialog
                docId="doc-1"
                userId="guest"
                role="viewer"
                isGuest
                onClose={vi.fn()}
                onGuestDeleted={onGuestDeleted}
            />,
        );

        await user.click(screen.getByRole('button', { name: 'Delete my guest profile' }));
        await user.click(screen.getByRole('button', { name: 'Delete guest profile' }));

        expect(await screen.findByText(/could not finish deleting your guest profile/)).toBeInTheDocument();
        expect(onGuestDeleted).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Delete my guest profile' })).toBeEnabled();
    });
});
