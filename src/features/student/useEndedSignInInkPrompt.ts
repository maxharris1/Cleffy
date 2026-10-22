import { useCallback, useEffect, useRef, useState } from 'react';

import { heldDocIds } from '@/sync/inkRecovery';
import type { DocumentRow, MemberRole } from '@/types/database';

/** A score the prompt can name and export without asking the server: what the caller already has. */
export interface KnownScore {
    title: string;
    doc?: DocumentRow;
    role?: MemberRole | null;
}

/** The prompt's state: whose held ink, on which scores. */
export interface EndedSignInInk {
    userId: string;
    docIds: string[];
    accountDeleted: boolean;
    /** Titles (and rows) the caller has for some of the scores; the rest are read from the offline cache. */
    known: Readonly<Record<string, KnownScore>>;
    resolve: () => void;
}

/**
 * The step an ended sign-in takes before signing out (signOutEndedStudent):
 * when the account has ink this device could not store (inkRecovery), the
 * student is shown so and offered Export of each score it is on first —
 * the sign-out's own last try at writing it is bounded and may fail, and
 * what is still unwritten then goes with the sign-out. With none, it goes
 * straight on. A page that unmounts with the prompt up goes on too: the
 * sign-out must still happen.
 */
export const useEndedSignInInkPrompt = () => {
    const [prompt, setPrompt] = useState<EndedSignInInk | null>(null);
    const [signingOut, setSigningOut] = useState(false);
    const pending = useRef<EndedSignInInk | null>(null);

    /** Resolves once the student chooses to go on, or at once when nothing of theirs is held. */
    const askFirst = useCallback(
        (userId: string, accountDeleted: boolean, known: Readonly<Record<string, KnownScore>> = NONE_KNOWN) => {
            const docIds = heldDocIds(userId);
            if (docIds.length === 0) {
                return Promise.resolve();
            }
            return new Promise<void>((resolve) => {
                pending.current = { userId, docIds, accountDeleted, known, resolve };
                setPrompt(pending.current);
            });
        },
        [],
    );

    const proceed = useCallback(() => {
        setSigningOut(true);
        pending.current?.resolve();
    }, []);

    useEffect(() => () => pending.current?.resolve(), []);

    return { prompt, signingOut, askFirst, proceed };
};

const NONE_KNOWN: Readonly<Record<string, KnownScore>> = {};
