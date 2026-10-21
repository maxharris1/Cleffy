import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

import type { AgeGate } from '@/features/auth/ageCheck';
import { perfMark } from '@/lib/perf';
import { safePresenceName } from '@/lib/presenceName';
import { getSupabase } from '@/lib/supabase';

export interface SessionState {
    session: Session | null;
    /** True until the initial getSession() resolves. */
    loading: boolean;
    /** Latest auth event from onAuthStateChange (null until the first event). */
    lastEvent: AuthChangeEvent | null;
}

const authCallbackUrl = (): string => `${window.location.origin}/auth/callback`;

/**
 * A Turnstile token for GoTrue, or nothing at all.
 *
 * Every auth call below takes one, because GoTrue's captcha is a PROJECT-WIDE
 * setting: the moment `[auth.captcha]` is enabled, /signup, /token (the
 * password grant), /recover, /resend AND /signup?anonymous all demand a token,
 * not just the endpoint somebody had in mind when they switched it on. A form
 * that did not send one would simply stop working, and the failure would read
 * as a server error rather than a missing check.
 *
 * `options` is omitted entirely when there is no token, so a build without
 * `VITE_TURNSTILE_SITE_KEY` sends byte-for-byte the request it sent before —
 * no `captchaToken: undefined` on the wire, and nothing for a project with
 * captcha disabled to object to. That is the whole inertness story on this
 * side; the widget's half is in `turnstile.ts`.
 *
 * The token is NOT verified here and cannot be: that is Cloudflare's judgement,
 * reached by GoTrue with the secret key, server-side. All the browser does is
 * carry it.
 */
const captchaOptions = (captchaToken?: string | null): { captchaToken: string } | Record<string, never> =>
    captchaToken ? { captchaToken } : {};

/**
 * Last session observed in this tab. `undefined` means nothing has resolved yet
 * (cold start); `null` means we know the user is signed out. Remounts of
 * useSession / auth gates read this synchronously so SPA navigations do not
 * flash BrandLoading while getSession() round-trips again.
 */
let knownSession: Session | null | undefined = undefined;

const rememberSession = (session: Session | null): void => {
    knownSession = session;
};

/** Reactive Supabase session. */
export const useSession = (): SessionState => {
    const [state, setState] = useState<SessionState>(() =>
        knownSession !== undefined
            ? { session: knownSession, loading: false, lastEvent: null }
            : { session: null, loading: true, lastEvent: null },
    );

    useEffect(() => {
        const supabase = getSupabase();
        let mounted = true;

        void supabase.auth.getSession().then(({ data }) => {
            if (knownSession === undefined) {
                perfMark('session-known');
            }
            rememberSession(data.session);
            if (mounted) {
                setState((prev) => ({ ...prev, session: data.session, loading: false }));
            }
        });
        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((event, session) => {
            rememberSession(session);
            if (mounted) {
                setState({ session, loading: false, lastEvent: event });
            }
        });
        return () => {
            mounted = false;
            subscription.unsubscribe();
        };
    }, []);

    return state;
};

/** True when the session belongs to a registered (non-anonymous) account. */
export const isRegisteredSession = (session: Session | null): session is Session => {
    return Boolean(session && !session.user.is_anonymous);
};

/**
 * Account type for provisioned students, else null.
 *
 * `app_metadata.user_type` is admin-set by student-provision (service role) and is not
 * writable by the user, so it is trustworthy client-side — but use it for ROUTING only,
 * i.e. deciding which chrome an account belongs in. RLS on managed_students, assignments
 * and practice_notes is the actual enforcement; this is never an authorization check.
 */
export const userTypeOf = (session: Session | null): 'student' | null => {
    const meta = session?.user.app_metadata as Record<string, unknown> | undefined;
    return meta?.['user_type'] === 'student' ? 'student' : null;
};

/**
 * Email/password registration.
 *
 * `captchaToken` is how sign-up gets a server-side-verified captcha without
 * being rebuilt behind an Edge Function: GoTrue checks the token against
 * Cloudflare with the secret key before it creates anything, so the
 * verification is no more skippable than it would be in a function of our own —
 * and GoTrue keeps ownership of the confirmation email, which is the thing a
 * hand-rolled sign-up would have had to replace.
 */
export const signUpWithPassword = async (
    email: string,
    password: string,
    captchaToken: string | null | undefined,
    ageGate: AgeGate,
): Promise<{ needsEmailConfirmation: boolean }> => {
    const { data, error } = await getSupabase().auth.signUp({
        email,
        password,
        // age_gate is what the before_user_created hook checks
        // (20261021120000_consent_age.sql): country and the age it requires,
        // never the birthday the age screen compared it with.
        options: { emailRedirectTo: authCallbackUrl(), data: { age_gate: ageGate }, ...captchaOptions(captchaToken) },
    });
    if (error) {
        throw error;
    }
    // When confirmations are enabled, session is null until the user clicks the email link.
    return { needsEmailConfirmation: !data.session };
};

/**
 * Send the sign-up confirmation email again, to an address that has just been
 * signed up from this page.
 *
 * It exists because the link is short-lived — production's `mailer_otp_exp` is
 * one hour — and without a resend the only route back from an expired link was
 * signing up again, which answers `user_already_exists`, which sends the user
 * to sign in, which fails with "email not confirmed": a loop with no exit.
 *
 * Says nothing about the address either way. GoTrue's /resend answers an
 * address with no pending confirmation differently from one that has one, so
 * the caller must report the same thing whatever comes back, exactly as the
 * forgot-password form does — see `confirmationResendProblem` in authErrors.ts,
 * which draws the line between the failures that are safe to name and the ones
 * that would turn this button into a way to test which addresses have accounts.
 */
export const resendSignUpConfirmation = async (email: string, captchaToken?: string | null): Promise<void> => {
    const { error } = await getSupabase().auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: authCallbackUrl(), ...captchaOptions(captchaToken) },
    });
    if (error) {
        throw error;
    }
};

/** Email/password sign-in. */
export const signInWithPassword = async (
    email: string,
    password: string,
    captchaToken?: string | null,
): Promise<void> => {
    const { error } = await getSupabase().auth.signInWithPassword({
        email,
        password,
        ...(captchaToken ? { options: captchaOptions(captchaToken) } : {}),
    });
    if (error) {
        throw error;
    }
};

/** Send password-reset email (link lands on /update-password with recovery session). */
export const requestPasswordReset = async (email: string, captchaToken?: string | null): Promise<void> => {
    const { error } = await getSupabase().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/update-password`,
        ...captchaOptions(captchaToken),
    });
    if (error) {
        throw error;
    }
};

/** Set a new password after PASSWORD_RECOVERY. */
export const updatePassword = async (password: string): Promise<void> => {
    const { error } = await getSupabase().auth.updateUser({ password });
    if (error) {
        throw error;
    }
};

/**
 * Student join flow: anonymous session carrying a display name for presence.
 *
 * Takes a token like the rest: an anonymous sign-in is a POST to the same
 * captcha-protected signup endpoint, so enabling GoTrue's captcha makes the
 * share-link join page need one too — the one flow where an unsolved challenge
 * would stop a child getting into the score their teacher just shared.
 */
export const signInAnonymouslyWithName = async (
    displayName: string,
    captchaToken: string | null | undefined,
    ageGate: AgeGate,
): Promise<void> => {
    const supabase = getSupabase();
    // A guest is a new auth user like any other, so the hook checks its
    // age_gate too.
    const { error } = await supabase.auth.signInAnonymously({
        options: { data: { display_name: displayName, age_gate: ageGate }, ...captchaOptions(captchaToken) },
    });
    if (error) {
        throw error;
    }
};

/** How long sign-out waits for the outbox to upload before asking. */
const SIGN_OUT_SYNC_TIMEOUT_MS = 8000;

/** How long sign-out waits for pending lesson-history snapshots. */
const SIGN_OUT_SNAPSHOT_TIMEOUT_MS = 3000;

export interface SignOutSyncResult {
    /** Annotation changes still not on the server; signing out deletes them. */
    pending: number;
    /** Marks whose change the server refused for good while uploading. */
    refused: number;
    /**
     * How many of `pending` another account queued on this device (a session
     * that ended without signing out): never uploaded under this account,
     * deleted all the same by sign-out.
     */
    foreign?: number;
}

/**
 * Upload what this device still owes the server, then report how many
 * annotation changes are STILL unsynced, and how many the server refused
 * outright on the way. Sign-out clears the unsynced ones from the device, so
 * either count being non-zero must be put to the user before signOut().
 * Never throws. Reports nothing pending only when the outbox cannot be read
 * at all — and then sign-out cannot clear it either.
 */
export const syncBeforeSignOut = async (timeoutMs = SIGN_OUT_SYNC_TIMEOUT_MS): Promise<SignOutSyncResult> => {
    const [
        { getDb },
        { drainCloudOutboxes, foreignCloudOpCount, pendingCloudOpCount },
        { createSupabaseAnnotationsApi },
        snapshots,
    ] = await Promise.all([
        import('@/sync/db'),
        import('@/sync/signOutSync'),
        import('@/sync/syncEngine'),
        import('@/features/viewer/history/snapshotService'),
    ]);
    const db = getDb();
    let pending: number;
    let refused = 0;
    let foreign = 0;
    let userId: string | null = null;
    try {
        pending = await pendingCloudOpCount(db);
    } catch {
        return { pending: 0, refused: 0 };
    }
    try {
        const supabase = getSupabase();
        const { data } = await supabase.auth.getSession();
        userId = data.session?.user.id ?? null;
        if (!userId) {
            return { pending, refused };
        }
        if (pending > 0) {
            ({ pending, refused, foreign } = await drainCloudOutboxes({
                db,
                api: createSupabaseAnnotationsApi(supabase),
                getUserId: () => userId,
                timeoutMs,
            }));
        }
        // Day snapshots are history, not marks — best effort, never a reason to
        // ask, and not worth a wait at all when none are waiting.
        if ((await snapshots.countPendingSnapshots(db)) > 0) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                snapshots.retryPendingSnapshots(db).catch(() => undefined),
                new Promise((resolve) => {
                    timer = setTimeout(resolve, Math.min(timeoutMs, SIGN_OUT_SNAPSHOT_TIMEOUT_MS));
                }),
            ]);
            clearTimeout(timer);
        }
    } catch (err) {
        console.warn('Could not sync before sign-out', err);
        pending = await pendingCloudOpCount(db).catch(() => pending);
        // The drain never got to say which of them are another account's.
        const known = userId;
        if (known && pending > 0) {
            foreign = await foreignCloudOpCount(db, known).catch(() => foreign);
        }
    }
    return { pending, refused, foreign: Math.min(foreign, pending) };
};

export const signOut = async (): Promise<void> => {
    // Bump the library mutation epoch on BOTH sides of the auth round-trip.
    // The first bump outranks any response already in flight (including the
    // window after callers delete the entitlements row, just ahead of us).
    // The second outranks a request DISPATCHED during the round-trip — e.g.
    // LibraryPage refetching the response the first bump outranked — which
    // still left with a live JWT and would otherwise re-persist this
    // account's rows after the clears below swept them.
    const [{ noteLibraryMutation }, { stopSnapshotWrites }, { stopAllBackgroundDrains }] = await Promise.all([
        import('@/features/library/libraryCache'),
        import('@/features/viewer/history/snapshotService'),
        import('@/sync/backgroundDrain'),
    ]);
    noteLibraryMutation();
    // A snapshot upload still in flight from syncBeforeSignOut (it is raced
    // against a timer, not awaited) must not write this account's day
    // snapshot back into Dexie after the clear below.
    stopSnapshotWrites();
    // Nor may a background outbox drain write a synced row back after it.
    stopAllBackgroundDrains();
    // Local scope: THIS device signs out, and the account's sessions elsewhere
    // are left alone.
    //
    // supabase-js defaults to `global`, which revokes every refresh token the
    // user has — so a teacher signing out of the studio iPad at the end of a
    // lesson was also signing out their laptop and their phone, with nothing
    // in the UI that asked for that or said it had happened. There is no "sign
    // out everywhere" affordance anywhere in the app, so the global behaviour
    // was reachable only by accident, and the only thing it protected against
    // (a session you no longer trust on a device you no longer have) is better
    // served by an explicit control than by every ordinary sign-out.
    //
    // This also makes the two sign-out paths agree: signOutEndedSignIn() has
    // always passed `{ scope: 'local' }`, and what the privacy policy says
    // happens on sign-out ("removes from that device…", legalContent.ts
    // §device-storage) is now what the code does.
    await getSupabase().auth.signOut({ scope: 'local' });
    noteLibraryMutation();
    rememberSession(null);
    await clearAccountCachesFromDevice();
};

/**
 * Sign out after the server ended this sign-in under the device: a roster
 * student whose teacher archived them or reset their access. Their token
 * still parses but reaches nothing, and every refresh is refused.
 *
 * Unlike signOut(), the account's queued changes and annotation mirror stay:
 * there is nothing to upload them with now (syncBeforeSignOut would only meet
 * the same refusal), and nothing about the teacher's action makes them wrong.
 * A reset student is still a member under the same account, and a restored
 * one too, so they upload when that account signs in here again. Every op is
 * stamped with the account first (stampOwnCloudOps), so no other account on
 * the device sends or draws them meanwhile (opOwnerFor), and its own sign-out
 * warns before it clears them. The cached scores, lists and PDFs go, as on
 * any sign-out.
 *
 * Local scope: the server has already ended the sessions, and a global
 * sign-out would only say so again. Resolves to how many queued changes were
 * kept (0 when the outbox cannot be read).
 */
export const signOutKeepingChanges = async (): Promise<number> => {
    const [{ getDb }, { stampOwnCloudOps }] = await Promise.all([import('@/sync/db'), import('@/sync/signOutSync')]);
    // Before the PDFs (and with them the legacy ownership test) are cleared.
    return signOutEndedSignIn(async (userId) => ({
        count: userId ? await stampOwnCloudOps(getDb(), userId).catch(() => 0) : 0,
        keepCloudAnnotations: true,
    }));
};

/**
 * Sign out a roster student whose account no longer exists: it was deleted
 * with their teacher's (student-provision has no per-student delete). Like
 * signOutKeepingChanges, the server has already ended the sign-in, so this is
 * local only; unlike it, nothing this account queued can ever upload (no
 * sign-in will reach it again), so its changes are discarded rather than
 * promised. Another account's kept changes on the device stay for that
 * account's next sign-in. Resolves to how many queued changes were discarded.
 */
export const signOutDeletedAccount = async (): Promise<number> => {
    const [{ getDb }, { dropOwnCloudOps, pendingCloudOpCount }] = await Promise.all([
        import('@/sync/db'),
        import('@/sync/signOutSync'),
    ]);
    return signOutEndedSignIn(async (userId) => {
        const db = getDb();
        const discarded = userId ? await dropOwnCloudOps(db, userId).catch(() => 0) : 0;
        // Unreadable reads as "something is waiting": keeping marks nobody
        // will draw costs a little storage, clearing them could lose them.
        const othersWaiting = await pendingCloudOpCount(db).catch(() => 1);
        return { count: discarded, keepCloudAnnotations: othersWaiting > 0 };
    });
};

/**
 * What signOutKeepingChanges and signOutDeletedAccount share: stop every
 * writer, settle the outbox (`settle`, before the PDFs and with them the
 * legacy ownership test are cleared), sign out locally, and clear the
 * account's caches. Resolves to `settle`'s count.
 */
const signOutEndedSignIn = async (
    settle: (userId: string | null) => Promise<{ count: number; keepCloudAnnotations: boolean }>,
): Promise<number> => {
    const [{ noteLibraryMutation }, { stopSnapshotWrites }, { stopAllBackgroundDrains }] = await Promise.all([
        import('@/features/library/libraryCache'),
        import('@/features/viewer/history/snapshotService'),
        import('@/sync/backgroundDrain'),
    ]);
    // As signOut(): nothing may write this account's rows back after the clear.
    noteLibraryMutation();
    stopSnapshotWrites();
    stopAllBackgroundDrains();
    const supabase = getSupabase();
    const { data } = await supabase.auth.getSession();
    const { count, keepCloudAnnotations } = await settle(data.session?.user.id ?? null);
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) {
        // The logout request itself failed (supabase-js then keeps the
        // session): the stored copy is what signs this browser in, so it goes.
        const { forgetStoredSessions } = await import('@/features/auth/authStorage');
        forgetStoredSessions();
    }
    noteLibraryMutation();
    rememberSession(null);
    await clearAccountCachesFromDevice({ keepCloudAnnotations });
    return count;
};

/**
 * What sign-out removes from this browser: the signed-out account's cached
 * scores, lists and cloud-score marks. Device-only (`local-…`) scores and the
 * app's preferences are not the account's and stay. Also the tail of deleting
 * a guest profile (accountDeletion.ts), which ends the same way.
 * `keepCloudAnnotations` keeps the marks, their outbox, watermarks and day
 * snapshots (signOutKeepingChanges).
 */
export const clearAccountCachesFromDevice = async ({ keepCloudAnnotations = false } = {}): Promise<void> => {
    // Drop cached ScoreData so a later account on this browser can't replay it.
    const { getDb } = await import('@/sync/db');
    const { clearCloudAnnotationData } = await import('@/sync/signOutSync');
    const { cancelBackgroundPdfCache } = await import('@/sync/pdfCache');
    // A score download that outlived its viewer must not cache the PDF after the clear.
    cancelBackgroundPdfCache();
    const db = getDb();
    await Promise.all([
        db.scoreCache.clear().catch(() => undefined),
        db.libraryList.clear().catch(() => undefined),
        db.rosterCache.clear().catch(() => undefined),
        db.assignmentsCache.clear().catch(() => undefined),
        db.pdfCache.clear().catch(() => undefined),
        db.pdfMeta.clear().catch(() => undefined),
        db.thumbnails.clear().catch(() => undefined),
        db.entitlements.clear().catch(() => undefined),
        // Cloud-score marks, their outbox, watermarks and day snapshots: the
        // next account on this browser must neither see nor push them.
        // Callers ask first (syncBeforeSignOut) when any are unsynced.
        keepCloudAnnotations
            ? Promise.resolve()
            : clearCloudAnnotationData(db).catch((err: unknown) =>
                  console.warn('Could not clear annotation data', err),
              ),
    ]);
};

/**
 * The name this account announces in a score's presence bar: its display name,
 * else "Guest" / "Collaborator" — never its email (src/lib/presenceName.ts).
 */
export const presenceNameOf = (session: Session | null): string =>
    safePresenceName(storedDisplayNameOf(session), Boolean(session?.user.is_anonymous));

/**
 * This account's own label (top bar, account page): metadata name, else email,
 * else Guest. Only ever shown to the account itself — presence uses
 * presenceNameOf instead.
 */
export const displayNameOf = (session: Session | null): string => {
    const meta = session?.user.user_metadata as Record<string, unknown> | undefined;
    const name = typeof meta?.['display_name'] === 'string' ? (meta['display_name'] as string) : null;
    return name ?? session?.user.email ?? 'Guest';
};

/**
 * The stored display name with no fallback — '' when the account never set one.
 *
 * displayNameOf() substitutes the email, which is right for the account's own
 * label and wrong for a form field: seeding the input with an address the user never typed
 * would turn "leave it blank" into "save my email as my name".
 */
export const storedDisplayNameOf = (session: Session | null): string => {
    const meta = session?.user.user_metadata as Record<string, unknown> | undefined;
    return typeof meta?.['display_name'] === 'string' ? (meta['display_name'] as string) : '';
};

/**
 * Set the name that appears on this account.
 *
 * Supabase notifies every onAuthStateChange subscriber with USER_UPDATED and the
 * refreshed session, so useSession — and through it the top bar's avatar and
 * label — pick this up without a reload.
 */
export const updateDisplayName = async (displayName: string): Promise<void> => {
    const { error } = await getSupabase().auth.updateUser({ data: { display_name: displayName.trim() } });
    if (error) {
        throw error;
    }
};
