import { useState } from 'react';

import {
    DEFAULT_LINK_EXPIRY_V2,
    changeGeneralLinkRole,
    LINK_EXPIRY_CHOICES_V2,
    isLinkExpired,
    linkExpiryText,
    renewLink,
    resetGeneralLink,
    setGeneralAccess,
    shareUrlFor,
    type LinkExpiryChoice,
} from '@/features/share/shareService';
import { middleEllipsis, useFlash } from '@/lib/useFlash';
import type { ShareLinkRow, ShareRole } from '@/types/database';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { ErrorText } from '@/ui/ErrorText';
import { SwapLabel } from '@/ui/SwapLabel';
import { fieldClassName } from '@/ui/classNames';
import { CheckIcon } from '@/ui/icons';

const SELECT_CLASS = fieldClassName('sm', 'shrink-0 py-1.5', { width: 'auto' });
const TEXT_BUTTON = 'rounded px-2 py-1 text-xs transition-colors disabled:opacity-40 pointer-coarse:min-h-11';

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

export interface GeneralAccessSectionProps {
    docId: string;
    /** The live General access link, or null while the score is Restricted. */
    link: ShareLinkRow | null;
    /** Signed-out people on the score through the link right now. */
    linkViewers: number;
    /** Something changed on the server: reload the dialog. */
    onChanged: () => Promise<void>;
}

/**
 * "General access" (D2, D15): Restricted, or Anyone with the link who can View
 * or Edit. One link per score: Copy, Renew, Reset; Restricted turns it off and
 * takes everyone it let in with it (D4).
 */
export const GeneralAccessSection = ({ docId, link, linkViewers, onChanged }: GeneralAccessSectionProps) => {
    const [expiry, setExpiry] = useState<LinkExpiryChoice>(DEFAULT_LINK_EXPIRY_V2);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<'restrict' | 'reset' | null>(null);
    const [copied, flashCopied] = useFlash<string>(1500);
    const expired = link ? isLinkExpired(link) : false;

    const run = async (action: () => Promise<unknown>, fallback: string) => {
        setBusy(true);
        setError(null);
        try {
            await action();
            await onChanged();
        } catch (err) {
            setError(errorText(err, fallback));
        } finally {
            setBusy(false);
            setConfirming(null);
        }
    };

    const copy = async (token: string) => {
        try {
            await navigator.clipboard.writeText(shareUrlFor(token));
            flashCopied(token);
        } catch {
            setError('Could not copy — long-press the link to copy it manually.');
        }
    };

    const turnOn = (role: ShareRole) =>
        run(async () => {
            const created = await setGeneralAccess(docId, 'anyone', role, expiry);
            if (created) {
                await copy(created.token);
            }
        }, 'Could not turn the link on.');

    const changeRole = (role: ShareRole) =>
        link
            ? run(() => changeGeneralLinkRole(docId, role, link.expires_at), 'Could not change what the link allows.')
            : Promise.resolve();

    return (
        <section className="mt-5">
            <h3 className="text-sm font-medium text-stone-600">General access</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-stone-700">
                <select
                    aria-label="General access"
                    value={link ? 'anyone' : 'restricted'}
                    disabled={busy}
                    onChange={(e) =>
                        e.target.value === 'restricted' ? setConfirming('restrict') : void turnOn('viewer')
                    }
                    className={SELECT_CLASS}
                >
                    <option value="restricted">Restricted</option>
                    <option value="anyone">Anyone with the link</option>
                </select>
                {link ? (
                    <>
                        <span>can</span>
                        <select
                            aria-label="People with the link can"
                            value={link.role}
                            disabled={busy || expired}
                            title={expired ? 'Renew the link first' : undefined}
                            onChange={(e) => void changeRole(e.target.value as ShareRole)}
                            className={SELECT_CLASS}
                        >
                            <option value="viewer">View</option>
                            <option value="editor">Edit</option>
                        </select>
                    </>
                ) : (
                    <label className="flex items-center gap-1.5 text-stone-600">
                        Link expires after
                        <select
                            aria-label="Link expires after"
                            value={expiry}
                            disabled={busy}
                            onChange={(e) => setExpiry(e.target.value as LinkExpiryChoice)}
                            className={SELECT_CLASS}
                        >
                            {LINK_EXPIRY_CHOICES_V2.map((choice) => (
                                <option key={choice.value} value={choice.value}>
                                    {choice.label}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
            </div>
            {link ? (
                <div className="mt-2 rounded-lg border border-stone-200 px-3 py-2">
                    <div className="flex items-center gap-2">
                        <span
                            className="min-w-0 flex-1 truncate text-xs text-stone-500"
                            title={shareUrlFor(link.token)}
                        >
                            {middleEllipsis(shareUrlFor(link.token), 36)}
                        </span>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void copy(link.token)}
                            className={`${TEXT_BUTTON} text-accent hover:bg-accent-soft`}
                        >
                            <SwapLabel
                                scale
                                labels={{
                                    copy: 'Copy link',
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
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
                        <span className={expired ? 'text-amber-800' : undefined}>
                            {linkExpiryText(link.expires_at)}
                        </span>
                        <select
                            aria-label="Renew the link for"
                            value=""
                            disabled={busy || !link.id}
                            onChange={(e) => {
                                const choice = e.target.value as LinkExpiryChoice;
                                if (choice && link.id) {
                                    void run(() => renewLink(link.id as string, choice), 'Could not renew the link.');
                                }
                            }}
                            className={fieldClassName('xs', 'h-7 shrink-0', { width: 'auto' })}
                        >
                            <option value="">Renew…</option>
                            {LINK_EXPIRY_CHOICES_V2.map((choice) => (
                                <option key={choice.value} value={choice.value}>
                                    {choice.label}
                                </option>
                            ))}
                        </select>
                        <span aria-hidden="true">·</span>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => setConfirming('reset')}
                            className={`${TEXT_BUTTON} text-danger hover:bg-red-50`}
                        >
                            Reset link
                        </button>
                    </div>
                    {link.role === 'viewer' ? (
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-stone-600" role="status">
                            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                            {linkViewers} viewing now
                        </p>
                    ) : null}
                </div>
            ) : (
                <p className="mt-1 text-xs text-stone-500">Only people with access can open this score.</p>
            )}
            {error ? <ErrorText className="mt-2">{error}</ErrorText> : null}

            {confirming === 'restrict' ? (
                <ConfirmDialog
                    title="Turn off the link?"
                    body="The link stops working at once, anyone watching through it is cut off, and people who joined with it lose access to this score."
                    confirmLabel="Turn off"
                    danger
                    busy={busy}
                    onConfirm={() =>
                        void run(
                            () => setGeneralAccess(docId, 'restricted', 'viewer', 'never'),
                            'Could not turn the link off.',
                        )
                    }
                    onCancel={() => setConfirming(null)}
                />
            ) : null}
            {confirming === 'reset' ? (
                <ConfirmDialog
                    title="Reset the link?"
                    body="The current link stops working and anyone watching through it is cut off. People who joined with it keep their access. You get a new link to share."
                    confirmLabel="Reset link"
                    danger
                    busy={busy}
                    onConfirm={() =>
                        void run(async () => {
                            const fresh = await resetGeneralLink(docId);
                            await copy(fresh.token);
                        }, 'Could not reset the link.')
                    }
                    onCancel={() => setConfirming(null)}
                />
            ) : null}
        </section>
    );
};
