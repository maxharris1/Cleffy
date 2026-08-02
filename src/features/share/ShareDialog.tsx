import { useEffect, useState } from 'react';

import { createShareLink, listShareLinks, revokeShareLink, shareUrlFor } from '@/features/share/shareService';
import type { ShareLinkRow, ShareRole } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';

export interface ShareDialogProps {
    docId: string;
    userId: string;
    onClose: () => void;
}

/** Owner-only modal: create, copy, and revoke share links for a score. */
export const ShareDialog = ({ docId, userId, onClose }: ShareDialogProps) => {
    const [links, setLinks] = useState<ShareLinkRow[] | null>(null);
    const [role, setRole] = useState<ShareRole>('editor');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copiedToken, setCopiedToken] = useState<string | null>(null);

    const refresh = async () => {
        try {
            setLinks(await listShareLinks(docId));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load links.');
        }
    };

    useEffect(() => {
        let cancelled = false;
        listShareLinks(docId)
            .then((rows) => {
                if (!cancelled) {
                    setLinks(rows);
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : 'Could not load links.');
                }
            });
        return () => {
            cancelled = true;
        };
    }, [docId]);

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
            const link = await createShareLink(docId, role, userId);
            await refresh();
            await copy(link.token);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not create the link.');
        } finally {
            setBusy(false);
        }
    };

    const revoke = async (token: string) => {
        setError(null);
        try {
            await revokeShareLink(token);
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not revoke the link.');
        }
    };

    return (
        <Dialog label="Share this score" onClose={onClose}>
            <div className="mt-4 flex items-center gap-2">
                <div className="flex rounded-lg border border-stone-300 p-0.5">
                    {(['editor', 'viewer'] as const).map((r) => (
                        <button
                            key={r}
                            type="button"
                            aria-pressed={role === r}
                            onClick={() => setRole(r)}
                            className={`rounded-md px-3 py-1.5 text-sm transition ${
                                role === r ? 'bg-accent text-white' : 'text-stone-600 hover:bg-ink/5'
                            }`}
                        >
                            {r === 'editor' ? 'Can edit' : 'View only'}
                        </button>
                    ))}
                </div>
                <Button size="sm" disabled={busy} onClick={() => void create()} className="flex-1">
                    {busy ? 'Creating…' : 'Create link & copy'}
                </Button>
            </div>

            {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}

            <div className="mt-4">
                <h3 className="text-sm font-medium text-stone-600">Active links</h3>
                {links === null ? (
                    <LoadingText className="mt-2 text-sm">Loading…</LoadingText>
                ) : links.length === 0 ? (
                    <p className="mt-2 text-sm text-stone-500">No links yet.</p>
                ) : (
                    <ul className="mt-2 space-y-2">
                        {links.map((link) => (
                            <li
                                key={link.token}
                                className="flex items-center gap-2 rounded-lg border border-stone-200 px-3 py-2"
                            >
                                <Badge tone={link.role === 'editor' ? 'ok' : 'neutral'}>
                                    {link.role === 'editor' ? 'edit' : 'view'}
                                </Badge>
                                <span className="min-w-0 flex-1 truncate text-xs text-stone-500">
                                    {shareUrlFor(link.token)}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => void copy(link.token)}
                                    className="rounded px-2 py-1 text-xs text-accent transition hover:bg-accent-soft"
                                >
                                    {copiedToken === link.token ? 'Copied!' : 'Copy'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void revoke(link.token)}
                                    className="rounded px-2 py-1 text-xs text-danger transition hover:bg-red-50"
                                >
                                    Revoke
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </Dialog>
    );
};
