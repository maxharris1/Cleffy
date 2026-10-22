/**
 * What the app shell needs to know of held ink (inkRecovery) without loading
 * the sync stack: whether a signed-out account's unsaved ink is waiting in
 * this tab (the shell then loads SignedOutInkNotice), and who signs in here
 * (inkRecovery then gives that ink back to its account, or lets it go once
 * another account signs in). No imports, so the shell pays nothing for it.
 */

let signedOutInk = false;
const signedOutListeners = new Set<() => void>();
const signInListeners = new Set<(userId: string) => void>();

/** True while this tab holds unsaved ink of an account that signed out. */
export const hasSignedOutInk = (): boolean => signedOutInk;

export const subscribeSignedOutInk = (listener: () => void): (() => void) => {
    signedOutListeners.add(listener);
    return () => signedOutListeners.delete(listener);
};

/** inkRecovery: whether it holds a signed-out account's ink now. */
export const setSignedOutInk = (value: boolean): void => {
    if (value === signedOutInk) {
        return;
    }
    signedOutInk = value;
    signedOutListeners.forEach((listener) => listener());
};

/** inkRecovery: told of every account signed in in this tab. */
export const onAccountSignedIn = (listener: (userId: string) => void): (() => void) => {
    signInListeners.add(listener);
    return () => signInListeners.delete(listener);
};

/** session.ts: an account is signed in in this tab (a session was seen). */
export const noteAccountSignedIn = (userId: string): void => {
    signInListeners.forEach((listener) => listener(userId));
};
