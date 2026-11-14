import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { GeneralAccessSection } from '@/features/share/owner/GeneralAccessSection';
import { LinkGuestRetentionRow } from '@/features/share/owner/LinkGuestRetentionRow';
import { OlderLinksSection } from '@/features/share/owner/OlderLinksSection';
import {
    cancelInvite,
    inviteByEmail,
    listDocumentMembers,
    listPendingInvites,
    loadOwnerSharing,
    memberLabel,
    removeMember,
    resendInvite,
    setMemberRole,
    type PendingInvite,
} from '@/features/share/shareService';
import type { DocumentMemberListing, ShareLinkRow, ShareRole } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { SwapLabel } from '@/ui/SwapLabel';
import { fieldClassName } from '@/ui/classNames';

const ROLE_LABEL: Record<ShareRole, string> = { editor: 'Editor', viewer: 'Viewer' };
const ROLE_SELECT_CLASS = fieldClassName('sm', 'shrink-0 py-1.5', { width: 'auto' });

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

const shortDate = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(iso));

interface Loaded {
    general: ShareLinkRow | null;
    older: ShareLinkRow[];
    members: DocumentMemberListing[] | null;
    invites: PendingInvite[] | null;
    error: string | null;
}

export interface OwnerSharingV2Props {
    docId: string;
    userId: string;
    /** Signed-out people on the score through its view link (presence peers with via 'link'). */
    linkViewers: number;
}

/**
 * The owner's Share dialog under Share v2 (D6: only the owner shares):
 * invite by email, people with access and pending invites, General access,
 * older links while any is active, and the D8 guest retention setting.
 */
export const OwnerSharingV2 = ({ docId, userId, linkViewers }: OwnerSharingV2Props) => {
    const [loaded, setLoaded] = useState<Loaded | null>(null);

    const fetchAll = useCallback(async (): Promise<Loaded> => {
        const [links, members, invites] = await Promise.allSettled([
            loadOwnerSharing(docId),
            listDocumentMembers(docId),
            listPendingInvites(docId),
        ]);
        const failed = [links, members, invites].find((r) => r.status === 'rejected');
        return {
            general: links.status === 'fulfilled' ? links.value.general : null,
            older: links.status === 'fulfilled' ? links.value.older : [],
            members: members.status === 'fulfilled' ? members.value : null,
            invites: invites.status === 'fulfilled' ? invites.value : null,
            error: failed ? errorText(failed.reason, 'Could not load sharing.') : null,
        };
    }, [docId]);

    const reload = useCallback(async () => setLoaded(await fetchAll()), [fetchAll]);

    useEffect(() => {
        let current = true;
        void fetchAll().then((next) => current && setLoaded(next));
        return () => {
            current = false;
        };
    }, [fetchAll]);

    if (!loaded) {
        return <LoadingText className="text-sm">Loading…</LoadingText>;
    }

    return (
        <>
            <InviteRow docId={docId} onInvited={reload} />
            {loaded.error ? <ErrorText className="mt-3">{loaded.error}</ErrorText> : null}
            <PeopleSection
                docId={docId}
                userId={userId}
                members={loaded.members}
                invites={loaded.invites}
                onChanged={reload}
            />
            <GeneralAccessSection docId={docId} link={loaded.general} linkViewers={linkViewers} onChanged={reload} />
            <OlderLinksSection links={loaded.older} onChanged={reload} />
            <LinkGuestRetentionRow />
        </>
    );
};

const InviteRow = ({ docId, onInvited }: { docId: string; onInvited: () => Promise<void> }) => {
    const [email, setEmail] = useState('');
    const [role, setRole] = useState<ShareRole>('viewer');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState<string | null>(null);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            setError('Enter a valid email address.');
            return;
        }
        setBusy(true);
        setError(null);
        setSent(null);
        try {
            await inviteByEmail(docId, email, role);
            setSent(email.trim());
            setEmail('');
            await onInvited();
        } catch (err) {
            setError(errorText(err, 'Could not send the invite.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <form noValidate onSubmit={(e) => void submit(e)}>
            <div className="mt-1 flex flex-wrap items-center gap-2">
                <input
                    type="email"
                    aria-label="Add people by email"
                    placeholder="Add people by email…"
                    autoComplete="off"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={fieldClassName('sm', 'min-w-0 flex-1 basis-48 py-1.5', { width: 'auto' })}
                />
                <select
                    aria-label="Invite as"
                    value={role}
                    onChange={(e) => setRole(e.target.value as ShareRole)}
                    className={ROLE_SELECT_CLASS}
                >
                    <option value="viewer">{ROLE_LABEL.viewer}</option>
                    <option value="editor">{ROLE_LABEL.editor}</option>
                </select>
                <Button size="sm" type="submit" disabled={busy}>
                    <SwapLabel labels={{ idle: 'Invite', busy: 'Sending…' }} active={busy ? 'busy' : 'idle'} />
                </Button>
            </div>
            {sent ? (
                <p role="status" className="mt-1 text-xs text-stone-500">
                    Invite sent to {sent}.
                </p>
            ) : null}
            {error ? <ErrorText className="mt-2">{error}</ErrorText> : null}
        </form>
    );
};

const PeopleSection = ({
    docId,
    userId,
    members,
    invites,
    onChanged,
}: {
    docId: string;
    userId: string;
    members: DocumentMemberListing[] | null;
    invites: PendingInvite[] | null;
    onChanged: () => Promise<void>;
}) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [removeTarget, setRemoveTarget] = useState<DocumentMemberListing | null>(null);

    const run = async (action: () => Promise<void>, fallback: string) => {
        setBusy(true);
        setError(null);
        try {
            await action();
            await onChanged();
        } catch (err) {
            setError(errorText(err, fallback));
        } finally {
            setBusy(false);
            setRemoveTarget(null);
        }
    };

    return (
        <section className="mt-5">
            <h3 className="text-sm font-medium text-stone-600">People with access</h3>
            {members === null ? null : (
                <ul className="mt-2 divide-y divide-stone-100">
                    {members.map((member) => {
                        const label = memberLabel(member);
                        const detail =
                            member.email && member.email !== label
                                ? member.email
                                : member.is_assigned
                                  ? 'Assigned student'
                                  : member.is_anonymous
                                    ? member.joined_via_link
                                        ? 'guest, joined by link'
                                        : 'guest'
                                    : null;
                        return (
                            <li key={member.user_id} className="flex items-center gap-2 py-2">
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm text-stone-800">
                                        {label}
                                        {member.user_id === userId ? (
                                            <span className="text-stone-500"> (you)</span>
                                        ) : null}
                                    </p>
                                    {detail ? <p className="truncate text-xs text-stone-500">{detail}</p> : null}
                                </div>
                                {member.role === 'owner' ? (
                                    <Badge tone="accent">Owner</Badge>
                                ) : (
                                    <>
                                        <select
                                            aria-label={`Access for ${label}`}
                                            value={member.role}
                                            disabled={busy}
                                            onChange={(e) =>
                                                void run(
                                                    () =>
                                                        setMemberRole(
                                                            docId,
                                                            member.user_id,
                                                            e.target.value as ShareRole,
                                                        ),
                                                    'Could not change their access.',
                                                )
                                            }
                                            className={ROLE_SELECT_CLASS}
                                        >
                                            <option value="editor">{ROLE_LABEL.editor}</option>
                                            <option value="viewer">{ROLE_LABEL.viewer}</option>
                                        </select>
                                        <button
                                            type="button"
                                            aria-label={`Remove ${label}`}
                                            disabled={busy}
                                            onClick={() => setRemoveTarget(member)}
                                            className="shrink-0 rounded px-2 py-1 text-xs text-danger transition-colors hover:bg-red-50 disabled:opacity-40"
                                        >
                                            Remove
                                        </button>
                                    </>
                                )}
                            </li>
                        );
                    })}
                    {(invites ?? []).map((invite) => (
                        <li key={invite.id} className="flex items-center gap-2 py-2">
                            <p className="min-w-0 flex-1 truncate text-sm text-stone-600">
                                {invite.email}
                                <span className="text-xs text-stone-500">
                                    {' '}
                                    · Invited as {ROLE_LABEL[invite.role].toLowerCase()} · expires{' '}
                                    {shortDate(invite.expiresAt)}
                                </span>
                            </p>
                            <button
                                type="button"
                                disabled={busy}
                                onClick={() => void run(() => resendInvite(docId, invite.id), 'Could not resend it.')}
                                className="shrink-0 rounded px-2 py-1 text-xs text-accent transition-colors hover:bg-accent-soft disabled:opacity-40"
                            >
                                Resend
                            </button>
                            <button
                                type="button"
                                aria-label={`Cancel the invite for ${invite.email}`}
                                disabled={busy}
                                onClick={() => void run(() => cancelInvite(docId, invite.id), 'Could not cancel it.')}
                                className="shrink-0 rounded px-2 py-1 text-xs text-danger transition-colors hover:bg-red-50 disabled:opacity-40"
                            >
                                Cancel
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {error ? <ErrorText className="mt-2">{error}</ErrorText> : null}
            {removeTarget ? (
                <ConfirmDialog
                    title={`Remove ${memberLabel(removeTarget)}?`}
                    body={[
                        'They lose access to this score on every device right away. Marks they made stay on the score.',
                        removeTarget.is_assigned ? 'This also withdraws the score from their assignments.' : '',
                    ]
                        .filter(Boolean)
                        .join(' ')}
                    confirmLabel="Remove"
                    danger
                    busy={busy}
                    onConfirm={() =>
                        void run(() => removeMember(docId, removeTarget.user_id), 'Could not remove them.')
                    }
                    onCancel={() => setRemoveTarget(null)}
                />
            ) : null}
        </section>
    );
};
