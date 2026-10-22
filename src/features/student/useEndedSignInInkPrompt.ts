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
    /** true: the student chose to sign out; false: the page went away first. */
    resolve: (proceed: boolean) => void;
}

/**
 * The step an ended sign-in takes before signing out (signOutEndedStudent):
 * when the account has ink this device could not store (inkRecovery), the
 * student is shown so and offered Export of each score it is on first —
 * the sign-out's own last try at writing it is bounded and may fail, and
 * what is still unwritten then stays in this tab, signed out, for Export or
 * Discard (SignedOutInkNotice). With none, it goes straight on. It never
 * goes on by itself — no time limit (decision 62), and not when the page
 * unmounts with the prompt up: askFirst then resolves false, the caller
 * does not sign out, the ink stays held, and the next page to find the
 * sign-in ended asks again.
 */
export const useEndedSignInInkPrompt = () => {
    const [prompt, setPrompt] = useState<EndedSignInInk | null>(null);
    const [signingOut, setSigningOut] = useState(false);
    const pending = useRef<EndedSignInInk | null>(null);

    /**
     * Resolves true once the student chooses to go on, or at once when
     * nothing of theirs is held; false when the page unmounts first.
     */
    const askFirst = useCallback(
        (
            userId: string,
            accountDeleted: boolean,
            known: Readonly<Record<string, KnownScore>> = NONE_KNOWN,
        ): Promise<boolean> => {
            const docIds = heldDocIds(userId);
            if (docIds.length === 0) {
                return Promise.resolve(true);
            }
            return new Promise<boolean>((resolve) => {
                pending.current = { userId, docIds, accountDeleted, known, resolve };
                setPrompt(pending.current);
            });
        },
        [],
    );

    const proceed = useCallback(() => {
        setSigningOut(true);
        pending.current?.resolve(true);
    }, []);

    // Never on to the sign-out by itself: an unmount only lets the caller go.
    useEffect(() => () => pending.current?.resolve(false), []);

    return { prompt, signingOut, askFirst, proceed };
};

const NONE_KNOWN: Readonly<Record<string, KnownScore>> = {};
