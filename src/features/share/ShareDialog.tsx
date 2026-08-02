import { useEffect, useState } from 'react';

import { createShareLink, listShareLinks, revokeShareLink, shareUrlFor } from '@/features/share/shareService';
import type { ShareLinkRow, ShareRole } from '@/types/database';

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
        <div
            data-ui-overlay
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
            onClick={onClose}
        >
            <div
                role="dialog"
                aria-label="Share this score"
                className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-stone-800">Share this score</h2>
                    <button
                        type="button"
                        aria-label="Close"
                        onClick={onClose}
                        className="rounded-lg px-2 py-1 text-stone-500 hover:bg-stone-100"
                    >
                        ✕
                    </button>
                </div>

                <div className="mt-4 flex items-center gap-2">
                    <div className="flex rounded-lg border border-stone-300 p-0.5">
                        {(['editor', 'viewer'] as const).map((r) => (
                            <button
                                key={r}
                                type="button"
                                aria-pressed={role === r}
                                onClick={() => setRole(r)}
                                className={`rounded-md px-3 py-1.5 text-sm ${
                                    role === r ? 'bg-indigo-600 text-white' : 'text-stone-600 hover:bg-stone-100'
                                }`}
                            >
                                {r === 'editor' ? 'Can edit' : 'View only'}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void create()}
                        className="flex-1 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-indigo-500 disabled:opacity-50"
                    >
                        {busy ? 'Creating…' : 'Create link & copy'}
                    </button>
                </div>

                {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

                <div className="mt-4">
                    <h3 className="text-sm font-medium text-stone-600">Active links</h3>
                    {links === null ? (
                        <p className="mt-2 animate-pulse text-sm text-stone-500">Loading…</p>
                    ) : links.length === 0 ? (
                        <p className="mt-2 text-sm text-stone-500">No links yet.</p>
                    ) : (
                        <ul className="mt-2 space-y-2">
                            {links.map((link) => (
                                <li
                                    key={link.token}
                                    className="flex items-center gap-2 rounded-lg border border-stone-200 px-3 py-2"
                                >
                                    <span
                                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                            link.role === 'editor'
                                                ? 'bg-emerald-100 text-emerald-700'
                                                : 'bg-stone-100 text-stone-600'
                                        }`}
                                    >
                                        {link.role === 'editor' ? 'edit' : 'view'}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-xs text-stone-500">
                                        {shareUrlFor(link.token)}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => void copy(link.token)}
                                        className="rounded px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50"
                                    >
                                        {copiedToken === link.token ? 'Copied!' : 'Copy'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void revoke(link.token)}
                                        className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                                    >
                                        Revoke
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
};
