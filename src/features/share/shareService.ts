import { callEdgeFunction } from '@/features/billing/billingApi';
import { features } from '@/lib/features';
import { getSupabase } from '@/lib/supabase';
import type { DocumentInviteRow, DocumentMemberListing, ShareLinkRow, ShareRole } from '@/types/database';

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

/**
 * redeem_share_link's refusal of an unknown, revoked or expired link: SQLSTATE
 * PT404 (HTTP 404) with `{"code":"invalid_share_link"}` in detail, since
 * 20261009120200. Before that it was P0002 (an HTTP 500) with only the message
 * to go on, which is still matched for the window between this frontend
 * reaching users and that migration reaching their backend.
 */
const isDeadLinkError = (error: { code?: string; message: string; details?: string | null }): boolean =>
    detailCodeOf(error.details) === 'invalid_share_link' ||
    error.code === 'PT404' ||
    (error.code === 'P0002' && error.message.includes('invalid or expired share link'));

/** Join a document via share token (SECURITY DEFINER RPC — see migrations). */
export const redeemShareLink = async (token: string): Promise<RedeemResult> => {
    const { data, error } = await getSupabase().rpc('redeem_share_link', { p_token: token });
    if (error) {
        throw new Error(isDeadLinkError(error) ? 'invalid_link' : error.message);
    }
    const first = data[0];
    if (!first) {
        throw new Error('invalid_link');
    }
    return { documentId: first.document_id, role: first.granted_role };
};

/** What a link would do for whoever opens it now. */
export type LinkPeek = { valid: true; role: ShareRole } | { valid: false };

/**
 * Check a link before anyone is created to redeem it: the join page asks this
 * ahead of signing a guest in, so a dead link costs no anonymous account.
 * Works with no session at all (peek_share_link is granted to anon).
 *
 * Resolves null when the server could not say — offline, or a backend that
 * predates peek_share_link — and the caller should carry on as it did before
 * peeking existed: redeem_share_link still refuses a dead link either way.
 */
export const peekShareLink = async (token: string): Promise<LinkPeek | null> => {
    try {
        const { data, error } = await getSupabase().rpc('peek_share_link', { p_token: token });
        const row = error ? undefined : data?.[0];
        if (!row) {
            return null;
        }
        return row.valid && (row.role === 'editor' || row.role === 'viewer')
            ? { valid: true, role: row.role }
            : { valid: false };
    } catch {
        return null;
    }
};

/**
 * The address to hand out for a link. Share v2 puts the token in the fragment
 * (/s#<token>, D14), which the browser never sends to a server; before it,
 * /join/<token>, which still works.
 */
export const shareUrlFor = (token: string): string =>
    features.shareV2 ? `${window.location.origin}/s#${token}` : `${window.location.origin}/join/${token}`;

// ---------------------------------------------------------------------------
// Share v2 (#105): General access, invites by email and the owner's settings.
// The legacy exports above stay for the dialog the flag-off build shows.

/** How long a General access link admits people (D15): the one list for create and Renew. */
export type LinkExpiryChoice = '1d' | '7d' | '30d' | '90d' | '365d' | 'never';

export const LINK_EXPIRY_CHOICES_V2: ReadonlyArray<{
    value: LinkExpiryChoice;
    label: string;
    interval: string | null;
}> = [
    { value: '1d', label: '1 day', interval: '1 day' },
    { value: '7d', label: '7 days', interval: '7 days' },
    { value: '30d', label: '30 days', interval: '30 days' },
    { value: '90d', label: '90 days', interval: '90 days' },
    { value: '365d', label: '1 year', interval: '365 days' },
    { value: 'never', label: 'Never', interval: null },
];

export const DEFAULT_LINK_EXPIRY_V2: LinkExpiryChoice = '7d';

/** How long idle link guests on the owner's scores are kept (D8), in days. */
export const LINK_GUEST_RETENTION_CHOICES = [7, 14, 30, 60, 90] as const;
export const DEFAULT_LINK_GUEST_RETENTION = 30;

const intervalFor = (expiry: LinkExpiryChoice): string | null => {
    const choice = LINK_EXPIRY_CHOICES_V2.find((c) => c.value === expiry);
    return choice ? choice.interval : '7 days';
};

const dateText = (iso: string): string =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

/** "Expires 20 Nov 2026 (in 7 days)", "Expires 20 Nov 2026 (today)", "Expired on 20 Nov 2026", "Never expires". */
export const linkExpiryText = (expiresAt: string | null, now: Date = new Date()): string => {
    if (expiresAt === null) {
        return 'Never expires';
    }
    const remaining = new Date(expiresAt).getTime() - now.getTime();
    if (remaining <= 0) {
        return `Expired on ${dateText(expiresAt)}`;
    }
    const days = Math.round(remaining / DAY_MS);
    const when = days < 1 ? 'today' : days === 1 ? 'in 1 day' : `in ${days} days`;
    return `Expires ${dateText(expiresAt)} (${when})`;
};

/** An owner action the server refused, by the code it gave; `message` is what to show. */
export class ShareError extends Error {
    constructor(
        message: string,
        readonly code: string,
    ) {
        super(message);
        this.name = 'ShareError';
    }
}

const RPC_MESSAGES: Record<string, string> = {
    invalid_link_expiry: 'That expiry is outside what links allow (1 hour to 1 year, or never).',
    invalid_retention_days: 'Choose between 1 and 90 days.',
    no_general_link: 'This score has no link to reset.',
    link_revoked: 'That link was turned off, so it cannot be renewed.',
};

const rpcFailure = (error: { message: string; details?: string | null }, fallback: string): ShareError => {
    const code = detailCodeOf(error.details) ?? 'failed';
    return new ShareError(RPC_MESSAGES[code] ?? `${fallback}: ${error.message}`, code);
};

export interface GeneralLink {
    id: string;
    token: string;
    role: ShareRole;
    expiresAt: string | null;
}

/** The score's live General access link, and the older (legacy) links still unrevoked. */
export const loadOwnerSharing = async (
    docId: string,
): Promise<{ general: ShareLinkRow | null; older: ShareLinkRow[] }> => {
    const links = await listShareLinks(docId);
    return {
        general: links.find((l) => l.general) ?? null,
        older: links.filter((l) => !l.general),
    };
};

/** Restricted revokes the link (and everyone it let in); Anyone creates it or changes its role and expiry. */
export const setGeneralAccess = async (
    docId: string,
    mode: 'restricted' | 'anyone',
    role: ShareRole,
    expiry: LinkExpiryChoice,
): Promise<GeneralLink | null> => {
    const { data, error } = await getSupabase().rpc('set_general_access', {
        p_document: docId,
        p_mode: mode,
        p_role: role,
        p_expires_in: intervalFor(expiry),
    });
    if (error) {
        throw rpcFailure(error, 'Could not change who can open the link');
    }
    const row = data?.[0];
    return row ? { id: row.link_id, token: row.token, role: row.role, expiresAt: row.expires_at } : null;
};

/**
 * View or Edit for the live link, keeping the expiry it has: set_general_access
 * always sets one, so the time left goes back as the interval (never under the
 * server's one-hour floor).
 */
export const changeGeneralLinkRole = async (
    docId: string,
    role: ShareRole,
    expiresAt: string | null,
    now: number = Date.now(),
): Promise<void> => {
    const remaining =
        expiresAt === null
            ? null
            : `${Math.max(3600, Math.round((new Date(expiresAt).getTime() - now) / 1000))} seconds`;
    const { error } = await getSupabase().rpc('set_general_access', {
        p_document: docId,
        p_mode: 'anyone',
        p_role: role,
        p_expires_in: remaining,
    });
    if (error) {
        throw rpcFailure(error, 'Could not change what the link allows');
    }
};

/** A new address for the General access link; the old one stops working. */
export const resetGeneralLink = async (docId: string): Promise<GeneralLink> => {
    const { data, error } = await getSupabase().rpc('reset_general_link', { p_document: docId });
    const row = data?.[0];
    if (error || !row) {
        throw error
            ? rpcFailure(error, 'Could not reset the link')
            : new ShareError('Could not reset the link.', 'failed');
    }
    return { id: row.link_id, token: row.token, role: row.role, expiresAt: row.expires_at };
};

/** A new expiry for a link; an expired one comes back to life. Resolves to the new expiry. */
export const renewLink = async (linkId: string, expiry: LinkExpiryChoice): Promise<string | null> => {
    const { data, error } = await getSupabase().rpc('renew_share_link', {
        p_link: linkId,
        p_expires_in: intervalFor(expiry),
    });
    if (error) {
        throw rpcFailure(error, 'Could not renew the link');
    }
    return data ?? null;
};

export interface PendingInvite {
    id: string;
    email: string;
    role: ShareRole;
    expiresAt: string;
}

/** Invites by email not yet accepted, cancelled or expired, oldest first. */
export const listPendingInvites = async (docId: string, now: Date = new Date()): Promise<PendingInvite[]> => {
    const { data, error } = await getSupabase()
        .from('document_invites')
        .select('id, email, role, expires_at, accepted_at, revoked_at')
        .eq('document_id', docId)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .gt('expires_at', now.toISOString())
        .order('created_at', { ascending: true });
    if (error) {
        throw new Error(`Could not load invites: ${error.message}`);
    }
    return (data as Pick<DocumentInviteRow, 'id' | 'email' | 'role' | 'expires_at'>[]).map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        expiresAt: row.expires_at,
    }));
};

const INVITE_MESSAGES: Record<string, string> = {
    cannot_invite: 'This address can’t be invited here. If they’re your student, use Assign.',
    invalid_email: 'Enter a valid email address.',
    not_owner: 'Only the score’s owner can invite people.',
    not_pending: 'That invite has already been used, cancelled or has expired.',
    send_failed: 'The invite email could not be sent. Try again.',
};

const callShareInvite = async (payload: Record<string, unknown>): Promise<void> => {
    const response = await callEdgeFunction('share-invite', payload);
    if (response.ok) {
        return;
    }
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; retry_after?: unknown };
    const code = typeof body.error === 'string' ? body.error : 'failed';
    if (code === 'rate_limited') {
        const wait = typeof body.retry_after === 'number' ? Math.max(1, Math.ceil(body.retry_after / 60)) : null;
        throw new ShareError(
            wait
                ? `Too many invites just now. Try again in ${wait} min.`
                : 'Too many invites just now. Try again soon.',
            code,
        );
    }
    throw new ShareError(INVITE_MESSAGES[code] ?? 'Could not send the invite. Try again.', code);
};

/** Invite someone by email: an account gets the score now, a new address a pending invite (D5, D7). */
export const inviteByEmail = (docId: string, email: string, role: ShareRole): Promise<void> =>
    callShareInvite({ action: 'invite', document_id: docId, email: email.trim(), role });

export const resendInvite = (docId: string, inviteId: string): Promise<void> =>
    callShareInvite({ action: 'resend', document_id: docId, invite_id: inviteId });

export const cancelInvite = (docId: string, inviteId: string): Promise<void> =>
    callShareInvite({ action: 'cancel', document_id: docId, invite_id: inviteId });

export const getLinkGuestRetention = async (): Promise<number> => {
    const { data, error } = await getSupabase().rpc('my_share_settings');
    if (error) {
        throw new Error(`Could not load your sharing settings: ${error.message}`);
    }
    return data?.link_guest_idle_days ?? DEFAULT_LINK_GUEST_RETENTION;
};

export const setLinkGuestRetention = async (days: number): Promise<number> => {
    const { data, error } = await getSupabase().rpc('set_link_guest_retention', { p_days: days });
    if (error) {
        throw rpcFailure(error, 'Could not save that setting');
    }
    return data ?? days;
};
