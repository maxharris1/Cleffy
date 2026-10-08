import type { Session } from '@supabase/supabase-js';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import {
    ACCOUNT_DELETED_PATH,
    AccountDeletionError,
    DELETE_ACCOUNT_CONFIRMATION,
    clearLocalAccountData,
    requestAccountDeletion,
} from '@/features/account/accountDeletion';
import { userTypeOf } from '@/features/auth/session';
import { LEGAL_ENTITY } from '@/features/legal/legalEntity';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { ErrorText } from '@/ui/ErrorText';
import { TextField } from '@/ui/TextField';
import { linkClassName } from '@/ui/classNames';

const SECTION = 'mt-8 border-t border-stone-300/50 pt-6';
const SECTION_HEADING = 'text-sm font-medium uppercase tracking-[0.08em] text-stone-600';

/** What deletion does, in the order delete-account does it. Kept in step with the privacy policy's #deleting. */
const CONSEQUENCES = [
    'Any subscription is cancelled immediately, and you will not be charged again.',
    'Every score you own is deleted — its file, markings, history and share links — for you and everyone you shared it with.',
    'Student accounts you created are deleted, with their assignments and your practice notes.',
    'If you own an Academy studio, it is closed and its teachers lose their seats.',
    'You are removed from scores others shared with you. Your markings on their scores stay, no longer attributed to you.',
    'Everything Cleffy keeps on this device is cleared, including changes that have not synced yet.',
] as const;

/** Full page load: nothing of the deleted account may survive in memory. */
const leaveForDeletedPage = () => window.location.replace(ACCOUNT_DELETED_PATH);

/**
 * Not every permanent account has a password: a share-link guest who upgrades
 * through UpgradeBanner only ever confirms an email. The reset flow sets a
 * first password just as well as it replaces a forgotten one.
 */
const ResetPasswordHint = () => (
    <p className="mt-2 text-xs text-stone-600">
        Never set a password, or forgotten it?{' '}
        <Link to="/forgot-password" className={linkClassName}>
            Reset it
        </Link>{' '}
        first, then come back here.
    </p>
);

interface DeleteAccountSectionProps {
    session: Session;
    /** Called once the account is deleted and local data cleared. Tests replace the navigation. */
    onDeleted?: () => void;
}

/**
 * The last section of the Account page: the way out, for good.
 *
 * Deliberately two steps — a plain button that only opens the dialog, then a
 * dialog that will not submit until the person has typed DELETE and their
 * password — because this is the one action in the product nobody can undo for
 * them. The password is re-checked by the server, not here.
 */
export const DeleteAccountSection = ({ session, onDeleted = leaveForDeletedPage }: DeleteAccountSectionProps) => {
    const [open, setOpen] = useState(false);
    const [typed, setTyped] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errorCode, setErrorCode] = useState<string | null>(null);

    // delete-account refuses a provisioned student: their teacher created, pays
    // for and controls the account. Say so instead of offering a button that fails.
    if (userTypeOf(session) === 'student') {
        return (
            <section className={SECTION}>
                <h2 className={SECTION_HEADING}>Delete account</h2>
                <p className="mt-2 text-sm text-stone-600">
                    Your teacher manages this account, so it can’t be deleted from here. Ask your teacher to remove it,
                    or write to{' '}
                    <a href={`mailto:${LEGAL_ENTITY.contactEmail}`} className={linkClassName}>
                        {LEGAL_ENTITY.contactEmail}
                    </a>
                    .
                </p>
            </section>
        );
    }

    const confirmed = typed.trim() === DELETE_ACCOUNT_CONFIRMATION && password.length > 0;

    const close = () => {
        if (busy) {
            return;
        }
        setOpen(false);
        setTyped('');
        setPassword('');
        setError(null);
        setErrorCode(null);
    };

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!confirmed || busy) {
            return;
        }
        setError(null);
        setErrorCode(null);
        setBusy(true);
        try {
            await requestAccountDeletion(password);
        } catch (err) {
            setError(
                err instanceof AccountDeletionError || err instanceof Error
                    ? err.message
                    : 'Account deletion did not finish. Please try again.',
            );
            setErrorCode(err instanceof AccountDeletionError ? err.code : null);
            setBusy(false);
            return;
        }
        // The account is gone; from here on nothing can fail the deletion itself.
        await clearLocalAccountData();
        onDeleted();
    };

    return (
        <section className={SECTION}>
            <h2 className={SECTION_HEADING}>Delete account</h2>
            <p className="mt-2 text-sm text-stone-600">
                Permanently delete your account, your scores and everything shared from them. This cannot be undone.
                Export or download anything you want to keep first.
            </p>
            <Button size="sm" variant="danger" className="mt-3" onClick={() => setOpen(true)}>
                Delete account…
            </Button>

            {open ? (
                <Dialog label="Delete your account?" onClose={close}>
                    <form onSubmit={(event) => void submit(event)}>
                        <p className="text-sm text-stone-600">This happens straight away and cannot be undone:</p>
                        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-stone-700 marker:text-stone-400">
                            {CONSEQUENCES.map((line) => (
                                <li key={line}>{line}</li>
                            ))}
                        </ul>

                        <div className="mt-5">
                            <TextField
                                id="delete-account-confirm"
                                label={`Type ${DELETE_ACCOUNT_CONFIRMATION} to confirm`}
                                value={typed}
                                autoComplete="off"
                                autoCapitalize="characters"
                                spellCheck={false}
                                disabled={busy}
                                onChange={(event) => setTyped(event.target.value)}
                            />
                            <TextField
                                id="delete-account-password"
                                label="Your password"
                                type="password"
                                autoComplete="current-password"
                                spaced
                                value={password}
                                disabled={busy}
                                onChange={(event) => setPassword(event.target.value)}
                            />
                            {errorCode === 'reauthentication_failed' ? null : <ResetPasswordHint />}
                        </div>

                        {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}
                        {/* Repeated beside the error, where someone who never had a password will be looking. */}
                        {errorCode === 'reauthentication_failed' ? <ResetPasswordHint /> : null}

                        <div className="mt-5 flex justify-end gap-2">
                            <Button type="button" variant="ghost" size="sm" onClick={close} disabled={busy}>
                                Keep my account
                            </Button>
                            <Button type="submit" variant="danger" size="sm" disabled={!confirmed || busy}>
                                {busy ? 'Deleting…' : 'Delete my account'}
                            </Button>
                        </div>
                    </form>
                </Dialog>
            ) : null}
        </section>
    );
};
