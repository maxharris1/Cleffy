import { useState, type ReactNode } from 'react';

import { syncBeforeSignOut, type SignOutSyncResult } from '@/features/auth/session';
import { ConfirmDialog } from '@/ui/ConfirmDialog';

export interface GuardedSignOut {
    /** Sync first; sign out straight away when nothing is left, else ask. */
    requestSignOut: () => Promise<void>;
    /** True while the pre-sign-out upload runs (show "Saving changes…"). */
    checking: boolean;
    /** The "unsynced changes" confirmation — render it somewhere in the page. */
    dialog: ReactNode;
}

const changes = (n: number) => (n === 1 ? '1 change' : `${n} changes`);

/** Dialog copy for what the pre-sign-out upload left behind. */
const describe = ({ pending, refused }: SignOutSyncResult): { title: string; body: string } => {
    const refusedLine =
        refused > 0
            ? `${changes(refused)} to your marks ${refused === 1 ? 'was' : 'were'} refused by the server and could not be saved — you may no longer have permission to edit ${refused === 1 ? 'that score' : 'those scores'}. ${refused === 1 ? 'It has' : 'They have'} been undone.`
            : '';
    if (pending === 0) {
        return { title: 'Some changes could not be saved', body: refusedLine };
    }
    const them = pending === 1 ? 'it' : 'them';
    const pendingLine = `You have ${pending === 1 ? '1 unsynced change' : `${pending} unsynced changes`} to your scores that could not be saved to your account. Signing out now deletes ${them} from this device for good. Stay signed in and reconnect to save ${them}.`;
    return {
        title: 'Sign out with unsynced changes?',
        body: refusedLine ? `${pendingLine} ${refusedLine}` : pendingLine,
    };
};

/**
 * Sign-out that will not silently throw away marks.
 *
 * Sign-out clears this account's annotations from the device. Changes made
 * offline (or refused by a flaky connection) that never reached the server
 * would go with them, so this uploads what it can first and, when anything is
 * still pending, asks before `doSignOut` runs. Cancel keeps the user signed
 * in with the changes queued; they upload on the next connection.
 *
 * A change the server refused outright during that upload is already gone
 * (the mark was rolled back), so there is nothing to keep by staying — but
 * the user is still told before the device copy goes, never left to find out
 * at the next lesson.
 */
export const useGuardedSignOut = (doSignOut: () => Promise<void>): GuardedSignOut => {
    const [checking, setChecking] = useState(false);
    const [outcome, setOutcome] = useState<SignOutSyncResult | null>(null);

    const requestSignOut = async () => {
        if (checking) {
            return;
        }
        setChecking(true);
        let result: SignOutSyncResult;
        try {
            result = await syncBeforeSignOut();
        } finally {
            setChecking(false);
        }
        if (result.pending > 0 || result.refused > 0) {
            setOutcome(result);
            return;
        }
        await doSignOut();
    };

    let dialog: ReactNode = null;
    if (outcome) {
        const { title, body } = describe(outcome);
        const losesWork = outcome.pending > 0;
        dialog = (
            <ConfirmDialog
                title={title}
                body={body}
                confirmLabel={losesWork ? 'Sign out anyway' : 'Sign out'}
                cancelLabel="Stay signed in"
                danger={losesWork}
                onConfirm={() => {
                    setOutcome(null);
                    void doSignOut();
                }}
                onCancel={() => setOutcome(null)}
            />
        );
    }

    return { requestSignOut, checking, dialog };
};
