import { useState } from 'react';

import { isLinkExpired, linkExpiryText, revokeShareLink, shareUrlFor } from '@/features/share/shareService';
import { middleEllipsis, useFlash } from '@/lib/useFlash';
import type { ShareLinkRow } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { ErrorText } from '@/ui/ErrorText';
import { SwapLabel } from '@/ui/SwapLabel';
import { CheckIcon } from '@/ui/icons';

export interface OlderLinksSectionProps {
    /** Unrevoked links made before General access (D2). */
    links: ShareLinkRow[];
    onChanged: () => Promise<void>;
}

/**
 * Links made before Share v2, while any is still unrevoked: copy and revoke
 * only, nothing new is made here (D2). Revoking always takes the people who
 * joined with the link with it (D4).
 */
export const OlderLinksSection = ({ links, onChanged }: OlderLinksSectionProps) => {
    const [target, setTarget] = useState<ShareLinkRow | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, flashCopied] = useFlash<string>(1500);

    if (links.length === 0) {
        return null;
    }

    const copy = async (token: string) => {
        try {
            await navigator.clipboard.writeText(shareUrlFor(token));
            flashCopied(token);
        } catch {
            setError('Could not copy — long-press the link to copy it manually.');
        }
    };

    const revoke = async (link: ShareLinkRow) => {
        setBusy(true);
        setError(null);
        try {
            await revokeShareLink(link.token, { removeMembers: true });
            await onChanged();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not revoke the link.');
        } finally {
            setBusy(false);
            setTarget(null);
        }
    };

    return (
        <section className="mt-5">
            <h3 className="text-sm font-medium text-stone-600">Older links ({links.length})</h3>
            <ul className="mt-2 space-y-2">
                {links.map((link) => {
                    const expired = isLinkExpired(link);
                    return (
                        <li key={link.token} className="rounded-lg border border-stone-200 px-3 py-2">
                            <div className="flex items-center gap-2">
                                <Badge tone={link.role === 'editor' ? 'ok' : 'neutral'}>
                                    {link.role === 'editor' ? 'edit' : 'view'}
                                </Badge>
                                <span
                                    className="min-w-0 flex-1 truncate text-xs text-stone-500"
                                    title={shareUrlFor(link.token)}
                                >
                                    {middleEllipsis(shareUrlFor(link.token), 32)}
                                </span>
                                <button
                                    type="button"
                                    disabled={expired}
                                    onClick={() => void copy(link.token)}
                                    className="rounded px-2 py-1 text-xs text-accent transition-colors hover:bg-accent-soft disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                                >
                                    <SwapLabel
                                        scale
                                        labels={{
                                            copy: 'Copy',
                                            copied: (
                                                <span className="inline-flex items-center gap-1">
                                                    <CheckIcon size={12} aria-hidden="true" />
                                                    Copied!
                                                </span>
                                            ),
                                        }}
                                        active={copied === link.token ? 'copied' : 'copy'}
                                    />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setTarget(link)}
                                    className="rounded px-2 py-1 text-xs text-danger transition-colors hover:bg-red-50 pointer-coarse:ml-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                                >
                                    Revoke
                                </button>
                            </div>
                            <p className="mt-1 text-xs text-stone-500">{linkExpiryText(link.expires_at)}</p>
                        </li>
                    );
                })}
            </ul>
            {error ? <ErrorText className="mt-2">{error}</ErrorText> : null}
            {target ? (
                <ConfirmDialog
                    title="Revoke this link?"
                    body="Nobody can join with it any more, and the people who joined with it lose access to this score (students keep the access their assignment gives them)."
                    confirmLabel="Revoke link"
                    danger
                    busy={busy}
                    onConfirm={() => void revoke(target)}
                    onCancel={() => setTarget(null)}
                />
            ) : null}
        </section>
    );
};
