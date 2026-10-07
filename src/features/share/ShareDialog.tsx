import { useEffect, useState } from 'react';

import {
    DEFAULT_LINK_EXPIRY,
    DEFAULT_LINK_ROLE,
    LINK_EXPIRY_CHOICES,
    createShareLink,
    isLinkExpired,
    leaveDocument,
    linkExpiryLabel,
    listDocumentMembers,
    listShareLinks,
    memberLabel,
    removeMember,
    revokeShareLink,
    setMemberRole,
    shareUrlFor,
    type LinkExpiry,
} from '@/features/share/shareService';
import type { DocumentMemberListing, MemberRole, ShareLinkRow, ShareRole } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Dialog } from '@/ui/Dialog';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { fieldClassName } from '@/ui/classNames';

export interface ShareDialogProps {
    docId: string;
    userId: string;
    /** The caller's role on the score: the owner manages, everyone else sees who is here and can leave. */
    role: MemberRole;
    /** False for a roster student, whose scores are their teacher's to withdraw. */
    canLeave?: boolean;
    onClose: () => void;
    /** The caller left the score; local caches are the parent's to purge once the viewer is down. */
    onLeft?: () => void;
}

const ROLE_LABEL: Record<ShareRole, string> = { editor: 'Can edit', viewer: 'View only' };

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/**
 * Sharing for one score. The owner creates, copies and revokes links and
 * manages who has access; a member sees what they can do (and, as an editor,
 * who else is here) and can leave.
 */
export const ShareDialog = ({ docId, userId, role, canLeave = true, onClose, onLeft }: ShareDialogProps) => (
    <Dialog label={role === 'owner' ? 'Share this score' : 'Sharing'} onClose={onClose}>
        {role === 'owner' ? (
            <OwnerSharing docId={docId} userId={userId} />
        ) : (
            <MemberSharing docId={docId} userId={userId} role={role} canLeave={canLeave} onLeft={onLeft} />
        )}
    </Dialog>
);

// ---------------------------------------------------------------------------
// Owner

const OwnerSharing = ({ docId, userId }: { docId: string; userId: string }) => {
    const [links, setLinks] = useState<ShareLinkRow[] | null>(null);
    const [members, setMembers] = useState<DocumentMemberListing[] | null>(null);
    const [linkRole, setLinkRole] = useState<ShareRole>(DEFAULT_LINK_ROLE);
    const [expiry, setExpiry] = useState<LinkExpiry>(DEFAULT_LINK_EXPIRY);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copiedToken, setCopiedToken] = useState<string | null>(null);
    const [revokeTarget, setRevokeTarget] = useState<ShareLinkRow | null>(null);
    const [removeTarget, setRemoveTarget] = useState<DocumentMemberListing | null>(null);

    const refresh = async () => {
        try {
            const [nextLinks, nextMembers] = await Promise.all([listShareLinks(docId), listDocumentMembers(docId)]);
            setLinks(nextLinks);
            setMembers(nextMembers);
        } catch (err) {
            setError(errorText(err, 'Could not load sharing.'));
        }
    };

    useEffect(() => {
        let cancelled = false;
        Promise.all([listShareLinks(docId), listDocumentMembers(docId)])
            .then(([nextLinks, nextMembers]) => {
                if (!cancelled) {
                    setLinks(nextLinks);
                    setMembers(nextMembers);
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setError(errorText(err, 'Could not load sharing.'));
                    setLinks((prev) => prev ?? []);
                    setMembers((prev) => prev ?? []);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [docId]);

    const joinedVia = (token: string) => (members ?? []).filter((m) => m.joined_via_link === token);

    const copy = async (token: string) => {
        try {
            await navigator.clipboard.writeText(shareUrlFor(token));
            setCopiedToken(token);
            setTimeout(() => setCopiedToken(null), 1500);
        } catch {
            setError('Could not copy — long-press the link to copy it manually.');
        }
    };

    const create = async () => {
        setBusy(true);
        setError(null);
        try {
            const link = await createShareLink(docId, linkRole, userId, expiry);
            await refresh();
            await copy(link.token);
        } catch (err) {
            setError(errorText(err, 'Could not create the link.'));
        } finally {
            setBusy(false);
        }
    };

    const changeRole = async (member: DocumentMemberListing, next: ShareRole) => {
        setError(null);
        const previous = member.role;
        setMembers((prev) => prev?.map((m) => (m.user_id === member.user_id ? { ...m, role: next } : m)) ?? prev);
        try {
            await setMemberRole(docId, member.user_id, next);
        } catch (err) {
            setMembers(
                (prev) => prev?.map((m) => (m.user_id === member.user_id ? { ...m, role: previous } : m)) ?? prev,
            );
            setError(errorText(err, 'Could not change their access.'));
        }
    };

    const confirmRemove = async () => {
        if (!removeTarget) {
            return;
        }
        const target = removeTarget;
        setBusy(true);
        setError(null);
        try {
            await removeMember(docId, target.user_id);
            setMembers((prev) => prev?.filter((m) => m.user_id !== target.user_id) ?? prev);
        } catch (err) {
            setError(errorText(err, 'Could not remove them.'));
        } finally {
            setBusy(false);
            setRemoveTarget(null);
        }
    };

    const confirmRevoke = async (removeMembers: boolean) => {
        if (!revokeTarget) {
            return;
        }
        const target = revokeTarget;
        setBusy(true);
        setError(null);
        try {
            await revokeShareLink(target.token, { removeMembers });
            await refresh();
        } catch (err) {
            setError(errorText(err, 'Could not revoke the link.'));
        } finally {
            setBusy(false);
            setRevokeTarget(null);
        }
    };

    const activeLink = (token: string | null) =>
        token !== null && (links ?? []).some((l) => l.token === token && !isLinkExpired(l));

    return (
        <>
            <div className="mt-1 flex flex-wrap items-center gap-2">
                <div role="group" aria-label="Link access" className="flex rounded-lg border border-stone-300 p-0.5">
                    {(['viewer', 'editor'] as const).map((r) => (
                        <button
                            key={r}
                            type="button"
                            aria-pressed={linkRole === r}
                            onClick={() => setLinkRole(r)}
                            className={`rounded-md px-3 py-1.5 text-sm transition ${
                                linkRole === r ? 'bg-accent text-white' : 'text-stone-600 hover:bg-ink/5'
                            }`}
                        >
                            {ROLE_LABEL[r]}
                        </button>
                    ))}
                </div>
                <label className="flex items-center gap-1.5 text-sm text-stone-600">
                    Expires
                    <select
                        aria-label="Link expires after"
                        value={expiry}
                        onChange={(e) => setExpiry(e.target.value as LinkExpiry)}
                        className={fieldClassName('sm', 'w-auto py-1.5')}
                    >
                        {LINK_EXPIRY_CHOICES.map((choice) => (
                            <option key={choice.value} value={choice.value}>
                                {choice.label}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            <Button size="sm" disabled={busy} onClick={() => void create()} className="mt-2 w-full">
                {busy ? 'Working…' : 'Create link & copy'}
            </Button>

            {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}

            <section className="mt-4">
                <h3 className="text-sm font-medium text-stone-600">Links</h3>
                {links === null ? (
                    <LoadingText className="mt-2 text-sm">Loading…</LoadingText>
                ) : links.length === 0 ? (
                    <p className="mt-2 text-sm text-stone-500">No links yet.</p>
                ) : (
                    <ul className="mt-2 space-y-2">
                        {links.map((link) => {
                            const expired = isLinkExpired(link);
                            const joined = joinedVia(link.token).length;
                            return (
                                <li key={link.token} className="rounded-lg border border-stone-200 px-3 py-2">
                                    <div className="flex items-center gap-2">
                                        <Badge tone={link.role === 'editor' ? 'ok' : 'neutral'}>
                                            {link.role === 'editor' ? 'edit' : 'view'}
                                        </Badge>
                                        <span className="min-w-0 flex-1 truncate text-xs text-stone-500">
                                            {shareUrlFor(link.token)}
                                        </span>
                                        <button
                                            type="button"
                                            disabled={expired}
                                            onClick={() => void copy(link.token)}
                                            className="rounded px-2 py-1 text-xs text-accent transition hover:bg-accent-soft disabled:opacity-40"
                                        >
                                            {copiedToken === link.token ? 'Copied!' : 'Copy'}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setRevokeTarget(link)}
                                            className="rounded px-2 py-1 text-xs text-danger transition hover:bg-red-50"
                                        >
                                            Revoke
                                        </button>
                                    </div>
                                    <p className="mt-1 text-xs text-stone-500">
                                        {expired ? <Badge tone="warn">Expired</Badge> : linkExpiryLabel(link)}
                                        {joined > 0 ? ` · ${joined} joined` : ''}
                                    </p>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            <section className="mt-5">
                <h3 className="text-sm font-medium text-stone-600">People with access</h3>
                {members === null ? (
                    <LoadingText className="mt-2 text-sm">Loading…</LoadingText>
                ) : (
                    <ul className="mt-2 divide-y divide-stone-100">
                        {members.map((member) => {
                            const label = memberLabel(member);
                            const isSelf = member.user_id === userId;
                            const detail =
                                member.email && member.email !== label
                                    ? member.email
                                    : member.is_student
                                      ? 'Student'
                                      : member.is_anonymous
                                        ? 'Guest'
                                        : null;
                            return (
                                <li key={member.user_id} className="flex items-center gap-2 py-2">
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm text-stone-800">
                                            {label}
                                            {isSelf ? <span className="text-stone-500"> (you)</span> : null}
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
                                                onChange={(e) => void changeRole(member, e.target.value as ShareRole)}
                                                className={fieldClassName('sm', 'w-auto py-1.5')}
                                            >
                                                <option value="editor">{ROLE_LABEL.editor}</option>
                                                <option value="viewer">{ROLE_LABEL.viewer}</option>
                                            </select>
                                            <button
                                                type="button"
                                                aria-label={`Remove ${label}`}
                                                disabled={busy}
                                                onClick={() => setRemoveTarget(member)}
                                                className="rounded px-2 py-1 text-xs text-danger transition hover:bg-red-50 disabled:opacity-40"
                                            >
                                                Remove
                                            </button>
                                        </>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            {revokeTarget ? (
                <RevokeLinkDialog
                    link={revokeTarget}
                    joined={joinedVia(revokeTarget.token)}
                    busy={busy}
                    onConfirm={(removeMembers) => void confirmRevoke(removeMembers)}
                    onCancel={() => setRevokeTarget(null)}
                />
            ) : null}
            {removeTarget ? (
                <ConfirmDialog
                    title={`Remove ${memberLabel(removeTarget)}?`}
                    body={[
                        'They lose access to this score on every device right away. Marks they made stay on the score.',
                        removeTarget.is_student ? 'This also withdraws the score from their assignments.' : '',
                        activeLink(removeTarget.joined_via_link)
                            ? 'The link they joined with still works — revoke it too if they should not come back.'
                            : '',
                    ]
                        .filter(Boolean)
                        .join(' ')}
                    confirmLabel="Remove"
                    danger
                    busy={busy}
                    onConfirm={() => void confirmRemove()}
                    onCancel={() => setRemoveTarget(null)}
                />
            ) : null}
        </>
    );
};

/**
 * Revoking stops new joins; the checkbox decides whether the people who
 * already joined through the link keep the score. It starts ticked: someone
 * revoking a link is usually taking access back, and leaving everyone it let
 * in is the surprising outcome.
 */
const RevokeLinkDialog = ({
    link,
    joined,
    busy,
    onConfirm,
    onCancel,
}: {
    link: ShareLinkRow;
    joined: DocumentMemberListing[];
    busy: boolean;
    onConfirm: (removeMembers: boolean) => void;
    onCancel: () => void;
}) => {
    const [removeMembers, setRemoveMembers] = useState(true);
    const students = joined.filter((m) => m.is_student).length;
    return (
        <Dialog label="Revoke this link?" onClose={onCancel}>
            <p className="text-sm leading-relaxed text-stone-600">
                Nobody new can join with this {link.role === 'editor' ? 'edit' : 'view'} link once it is revoked.
            </p>
            {joined.length > 0 ? (
                <label className="mt-3 flex items-start gap-2 text-sm text-stone-700">
                    <input
                        type="checkbox"
                        checked={removeMembers}
                        onChange={(e) => setRemoveMembers(e.target.checked)}
                        className="mt-0.5"
                    />
                    <span>
                        Also remove the {joined.length === 1 ? 'person' : `${joined.length} people`} who joined with it
                        {students > 0 ? ' (students keep the access their assignment gives them)' : ''}
                    </span>
                </label>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
                <Button
                    variant="danger"
                    size="sm"
                    onClick={() => onConfirm(joined.length > 0 && removeMembers)}
                    disabled={busy}
                >
                    Revoke link
                </Button>
            </div>
        </Dialog>
    );
};

// ---------------------------------------------------------------------------
// Member

const MemberSharing = ({
    docId,
    userId,
    role,
    canLeave,
    onLeft,
}: {
    docId: string;
    userId: string;
    role: MemberRole;
    canLeave: boolean;
    onLeft?: () => void;
}) => {
    // Only editors may list collaborators (list_document_members refuses
    // viewers, who never saw names beyond presence).
    const canList = role === 'editor';
    const [members, setMembers] = useState<DocumentMemberListing[] | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!canList) {
            return;
        }
        let cancelled = false;
        listDocumentMembers(docId)
            .then((rows) => {
                if (!cancelled) {
                    setMembers(rows);
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setError(errorText(err, 'Could not load collaborators.'));
                }
            });
        return () => {
            cancelled = true;
        };
    }, [docId, canList]);

    const leave = async () => {
        setBusy(true);
        setError(null);
        try {
            await leaveDocument(docId);
            setConfirming(false);
            onLeft?.();
        } catch (err) {
            setConfirming(false);
            setError(errorText(err, 'Could not leave this score.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <p className="text-sm text-stone-600">
                This score was shared with you. You can {role === 'editor' ? 'view and mark it up' : 'view it'}.
            </p>

            {canList ? (
                <section className="mt-4">
                    <h3 className="text-sm font-medium text-stone-600">People with access</h3>
                    {members === null ? (
                        error ? null : (
                            <LoadingText className="mt-2 text-sm">Loading…</LoadingText>
                        )
                    ) : (
                        <ul className="mt-2 divide-y divide-stone-100">
                            {members.map((member) => (
                                <li key={member.user_id} className="flex items-center gap-2 py-2">
                                    <p className="min-w-0 flex-1 truncate text-sm text-stone-800">
                                        {memberLabel(member)}
                                        {member.user_id === userId ? (
                                            <span className="text-stone-500"> (you)</span>
                                        ) : null}
                                    </p>
                                    <Badge tone={member.role === 'owner' ? 'accent' : 'neutral'}>
                                        {member.role === 'owner' ? 'Owner' : ROLE_LABEL[member.role]}
                                    </Badge>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            ) : null}

            {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}

            {canLeave ? (
                <div className="mt-5 flex justify-end">
                    <Button variant="dangerGhost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
                        Leave score
                    </Button>
                </div>
            ) : null}

            {confirming ? (
                <ConfirmDialog
                    title="Leave this score?"
                    body="It will be removed from your library and from this device. Marks you made stay on the score for everyone else. To come back you would need a new link from its owner."
                    confirmLabel="Leave"
                    danger
                    busy={busy}
                    onConfirm={() => void leave()}
                    onCancel={() => setConfirming(false)}
                />
            ) : null}
        </>
    );
};
