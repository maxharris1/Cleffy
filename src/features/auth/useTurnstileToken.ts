import { useCallback, useRef, useState } from 'react';

import { isTurnstileEnabled } from '@/features/auth/turnstile';

/**
 * How long a submit waits for a background token before giving up. Managed
 * mode usually answers in a second or two; this is the slow-network ceiling.
 */
export const TURNSTILE_WAIT_MS = 10_000;

/** Shown when Cloudflare has put a challenge in front of the user, or could not load one. */
export const TURNSTILE_NEEDS_USER = 'Finish the “I’m human” check, then try again.';

/** Shown when no challenge appeared but no token came back in time either. */
export const TURNSTILE_SLOW = 'Still checking you’re human. Try again in a moment.';

const wake = (waiters: { current: Array<() => void> }) => {
    const pending = waiters.current;
    waiters.current = [];
    for (const waiter of pending) {
        waiter();
    }
};

export type TurnstileWait = { ok: true; token: string | null } | { ok: false; message: string };

/**
 * The token half of a form's Turnstile check, shared by every form that mounts
 * a `TurnstileField`.
 *
 * The widget is interaction-only, so for most visitors it never shows and the
 * token arrives in the background. A submit that beats it there waits for it
 * (`waitForToken`) instead of telling the user to finish a check they cannot
 * see. It stops waiting at once when Cloudflare shows a challenge or fails,
 * because then there is something on screen for the user to do.
 *
 * Without `VITE_TURNSTILE_SITE_KEY` `waitForToken` resolves `{ ok: true, token: null }`
 * immediately, which keeps every form exactly as it was.
 */
export const useTurnstileToken = () => {
    const required = isTurnstileEnabled();
    /** The widget's React key: bumped by `renew` for a fresh challenge. */
    const [round, setRound] = useState(0);
    const tokenRef = useRef<string | null>(null);
    const needsUserRef = useRef(false);
    const waitersRef = useRef<Array<() => void>>([]);

    const onToken = useCallback((token: string | null) => {
        tokenRef.current = token;
        if (token) {
            needsUserRef.current = false;
            wake(waitersRef);
        }
    }, []);

    const onNeedsUser = useCallback(() => {
        needsUserRef.current = true;
        wake(waitersRef);
    }, []);

    /** Forget a spent token and remount the widget. */
    const renew = useCallback(() => {
        tokenRef.current = null;
        needsUserRef.current = false;
        setRound((n) => n + 1);
    }, []);

    const waitForToken = useCallback(
        (timeoutMs: number = TURNSTILE_WAIT_MS): Promise<TurnstileWait> => {
            const outcome = (): TurnstileWait =>
                tokenRef.current
                    ? { ok: true, token: tokenRef.current }
                    : { ok: false, message: needsUserRef.current ? TURNSTILE_NEEDS_USER : TURNSTILE_SLOW };
            if (!required) {
                return Promise.resolve({ ok: true, token: null });
            }
            if (tokenRef.current || needsUserRef.current) {
                return Promise.resolve(outcome());
            }
            return new Promise((resolve) => {
                const finish = () => {
                    clearTimeout(timer);
                    waitersRef.current = waitersRef.current.filter((waiter) => waiter !== finish);
                    resolve(outcome());
                };
                const timer = setTimeout(finish, timeoutMs);
                waitersRef.current.push(finish);
            });
        },
        [required],
    );

    return { required, round, onToken, onNeedsUser, renew, waitForToken };
};
