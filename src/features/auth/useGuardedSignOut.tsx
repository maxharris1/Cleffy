import { useState, type ReactNode } from 'react';

import { syncBeforeSignOut } from '@/features/auth/session';
import { ConfirmDialog } from '@/ui/ConfirmDialog';

export interface GuardedSignOut {
    /** Sync first; sign out straight away when nothing is left, else ask. */
    requestSignOut: () => Promise<void>;
    /** True while the pre-sign-out upload runs (show "Saving changes…"). */
    checking: boolean;
    /** The "unsynced changes" confirmation — render it somewhere in the page. */
    dialog: ReactNode;
}

/**
 * Sign-out that will not silently throw away marks.
 *
 * Sign-out clears this account's annotations from the device. Changes made
 * offline (or refused by a flaky connection) that never reached the server
 * would go with them, so this uploads what it can first and, when anything is
 * still pending, asks before `doSignOut` runs. Cancel keeps the user signed
 * in with the changes queued; they upload on the next connection.
 */
export const useGuardedSignOut = (doSignOut: () => Promise<void>): GuardedSignOut => {
    const [checking, setChecking] = useState(false);
    const [unsynced, setUnsynced] = useState<number | null>(null);

    const requestSignOut = async () => {
        if (checking) {
            return;
        }
        setChecking(true);
        let remaining: number;
        try {
            remaining = await syncBeforeSignOut();
        } finally {
            setChecking(false);
        }
        if (remaining > 0) {
            setUnsynced(remaining);
            return;
        }
        await doSignOut();
    };

    const dialog =
        unsynced !== null ? (
            <ConfirmDialog
                title="Sign out with unsynced changes?"
                body={`You have ${unsynced === 1 ? '1 unsynced change' : `${unsynced} unsynced changes`} to your scores that could not be saved to your account. Signing out now deletes ${unsynced === 1 ? 'it' : 'them'} from this device for good. Stay signed in and reconnect to save ${unsynced === 1 ? 'it' : 'them'}.`}
                confirmLabel="Sign out anyway"
                cancelLabel="Stay signed in"
                danger
                onConfirm={() => {
                    setUnsynced(null);
                    void doSignOut();
                }}
                onCancel={() => setUnsynced(null)}
            />
        ) : null;

    return { requestSignOut, checking, dialog };
};
