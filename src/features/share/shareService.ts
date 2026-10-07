import { getSupabase } from '@/lib/supabase';
import type { DocumentMemberListing, ShareLinkRow, ShareRole } from '@/types/database';

/**
 * How long a new link keeps admitting people. Expiry only stops NEW joins —
 * someone who already joined keeps their access until the owner removes them
 * or revokes the link with "remove people who joined" ticked.
 */
export type LinkExpiry = '7d' | '30d' | 'never';

export const LINK_EXPIRY_CHOICES: ReadonlyArray<{ value: LinkExpiry; label: string }> = [
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: 'never', label: 'Never' },
];

/**
 * A link is a credential that can be forwarded, so a fresh one is view-only
 * and short-lived unless the owner says otherwise.
 */
export const DEFAULT_LINK_ROLE: ShareRole = 'viewer';
export const DEFAULT_LINK_EXPIRY: LinkExpiry = '7d';

const DAY_MS = 24 * 60 * 60 * 1000;

/** expires_at for a link created at `now`; null means it never expires. */
export const expiresAtFor = (expiry: LinkExpiry, now: Date = new Date()): string | null => {
    if (expiry === 'never') {
        return null;
    }
    const days = expiry === '7d' ? 7 : 30;
    return new Date(now.getTime() + days * DAY_MS).toISOString();
};

export const isLinkExpired = (link: Pick<ShareLinkRow, 'expires_at'>, now: Date = new Date()): boolean =>
    link.expires_at !== null && new Date(link.expires_at).getTime() <= now.getTime();

/** "Expires in 3 days", "Expires today", "Expired", "Never expires". */
export const linkExpiryLabel = (link: Pick<ShareLinkRow, 'expires_at'>, now: Date = new Date()): string => {
    if (link.expires_at === null) {
        return 'Never expires';
    }
    const remaining = new Date(link.expires_at).getTime() - now.getTime();
    if (remaining <= 0) {
        return 'Expired';
    }
    // Ceil: a link with 6.2 days left reads "7 days", matching what was chosen
    // a few hours ago rather than looking a day short.
    const days = Math.ceil(remaining / DAY_MS);
    if (days <= 1) {
        return remaining < 12 * 60 * 60 * 1000 ? 'Expires today' : 'Expires in 1 day';
    }
    return `Expires in ${days} days`;
};

export const createShareLink = async (
    docId: string,
    role: ShareRole,
    createdBy: string,
    expiry: LinkExpiry = DEFAULT_LINK_EXPIRY,
): Promise<ShareLinkRow> => {
    const { data, error } = await getSupabase()
        .from('share_links')
        .insert({ document_id: docId, role, created_by: createdBy, expires_at: expiresAtFor(expiry) })
        .select()
        .single();
    if (error) {
        throw new Error(`Could not create share link: ${error.message}`);
    }
    return data;
};

/**
 * Unrevoked links, newest first. Expired ones are kept: revoking one is still
 * how an owner removes the people who joined through it.
 */
export const listShareLinks = async (docId: string): Promise<ShareLinkRow[]> => {
    const { data, error } = await getSupabase()
        .from('share_links')
        .select('*')
        .eq('document_id', docId)
        .is('revoked_at', null)
        .order('created_at', { ascending: false });
    if (error) {
        throw new Error(`Could not load share links: ${error.message}`);
    }
    return data;
};

/**
 * Revoke a link. With `removeMembers`, everyone whose access came from this
 * link loses it too (a roster student falls back to their assignment's
 * access instead). Resolves to how many people were affected.
 */
export const revokeShareLink = async (token: string, options: { removeMembers: boolean }): Promise<number> => {
    const { data, error } = await getSupabase().rpc('revoke_share_link', {
        p_token: token,
        p_remove_members: options.removeMembers,
    });
    if (error) {
        throw new Error(`Could not revoke link: ${error.message}`);
    }
    return data ?? 0;
};

export const listDocumentMembers = async (docId: string): Promise<DocumentMemberListing[]> => {
    const { data, error } = await getSupabase().rpc('list_document_members', { p_document: docId });
    if (error) {
        throw new Error(`Could not load collaborators: ${error.message}`);
    }
    return data ?? [];
};

export const setMemberRole = async (docId: string, userId: string, role: ShareRole): Promise<void> => {
    const { error } = await getSupabase().rpc('set_document_member_role', {
        p_document: docId,
        p_user: userId,
        p_role: role,
    });
    if (error) {
        throw new Error(`Could not change their access: ${error.message}`);
    }
};

export const removeMember = async (docId: string, userId: string): Promise<void> => {
    const { error } = await getSupabase().rpc('remove_document_member', { p_document: docId, p_user: userId });
    if (error) {
        throw new Error(`Could not remove them: ${error.message}`);
    }
};

/** The `detail` code a SECURITY DEFINER raise attached, if any. */
const detailCodeOf = (details: string | null | undefined): string | null => {
    if (!details) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(details);
        if (parsed && typeof parsed === 'object' && 'code' in parsed && typeof parsed.code === 'string') {
            return parsed.code;
        }
    } catch {
        // Not JSON: no code.
    }
    return null;
};

/**
 * Leave a score shared with you (server side only — local caches are the
 * caller's to purge, after anything still syncing it has stopped).
 */
export const leaveDocument = async (docId: string): Promise<void> => {
    const { error } = await getSupabase().rpc('leave_document', { p_document: docId });
    if (!error) {
        return;
    }
    const code = detailCodeOf(error.details);
    if (code === 'assigned_score') {
        throw new Error('Your teacher assigned this score, so only they can remove it from your library.');
    }
    if (code === 'owner_cannot_leave') {
        throw new Error('This is your own score — delete it instead.');
    }
    throw new Error(`Could not leave this score: ${error.message}`);
};

/**
 * What to call a member in the list. Owners get an email from the server;
 * editors never do, so a guest without a display name reads "Guest".
 */
export const memberLabel = (member: Pick<DocumentMemberListing, 'display_name' | 'email' | 'is_anonymous'>) =>
    member.display_name ?? member.email ?? (member.is_anonymous ? 'Guest' : 'Collaborator');

export interface RedeemResult {
    documentId: string;
    role: string;
}

/** Join a document via share token (SECURITY DEFINER RPC — see migrations). */
export const redeemShareLink = async (token: string): Promise<RedeemResult> => {
    const { data, error } = await getSupabase().rpc('redeem_share_link', { p_token: token });
    if (error) {
        throw new Error(error.message.includes('invalid or expired') ? 'invalid_link' : error.message);
    }
    const first = data[0];
    if (!first) {
        throw new Error('invalid_link');
    }
    return { documentId: first.document_id, role: first.granted_role };
};

export const shareUrlFor = (token: string): string => {
    return `${window.location.origin}/join/${token}`;
};
