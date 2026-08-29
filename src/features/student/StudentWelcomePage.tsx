import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { AuthCredentialsForm } from '@/features/auth/AuthCredentialsForm';
import { updatePassword, useSession, userTypeOf } from '@/features/auth/session';
import { getSupabase } from '@/lib/supabase';
import { BrandLoading, BrandShell } from '@/ui/BrandShell';
import { linkClassName } from '@/ui/classNames';

import { STUDENT_PASSWORD_MIN } from '../../../supabase/functions/_shared/studentCodes';

/** Whether the account we are signed in as still has a password to choose. */
type InviteState = 'checking' | 'unclaimed' | 'spent';

/**
 * The second half of the gate: not just *a* student, but one who has not set a
 * password yet.
 *
 * `user_type` alone answers "could an invite link have produced this session",
 * and on a shared device it answers yes for the wrong pupil. Family iPad, two
 * children of the same teacher: the elder has claimed and is signed in, so their
 * session is the stored one and it refreshes for weeks. The younger opens their
 * link a day late, auth-js fails the exchange and deliberately leaves that
 * session alone, and every `user_type` check on the page passes — against the
 * elder's account. `claimed_at` is the field that separates them, because it is
 * exactly "this account has already chosen a password".
 *
 * A read failure is a dead link, not a form: this is the gate, and its failure
 * costs a reload where guessing costs somebody their account. Both columns are
 * granted to `authenticated` and `managed_students_select` has a
 * `student_user_id = auth.uid()` branch, so a student can always read their own
 * row; archived is excluded for the same reason student-claim excludes it, that
 * archiving is a real revocation.
 */
const useUnclaimedInvite = (session: Session | null, loading: boolean): InviteState => {
    const [state, setState] = useState<InviteState>('checking');
    // The id, not the session: auth-js hands useSession a fresh session object on
    // USER_UPDATED, which is precisely what saving the password below causes. Re-
    // running on that would re-read the row we have just claimed and pull the
    // form out from under the student mid-submit.
    const studentUserId = session && userTypeOf(session) === 'student' ? session.user.id : null;

    useEffect(() => {
        if (loading || !studentUserId) {
            return;
        }
        let mounted = true;
        void (async () => {
            const { data, error } = await getSupabase()
                .from('managed_students')
                .select('claimed_at')
                .eq('student_user_id', studentUserId)
                .is('archived_at', null)
                .maybeSingle();
            if (mounted) {
                setState(!error && data && data.claimed_at === null ? 'unclaimed' : 'spent');
            }
        })();
        return () => {
            mounted = false;
        };
    }, [loading, studentUserId]);

    return state;
};

/**
 * Where an invited student's email link lands.
 *
 * The link carries tokens in the fragment and supabase-js exchanges them on its
 * own (detectSessionInUrl is on by default) — the same mechanism the recovery
 * link relies on — so by the time useSession stops loading, either there is a
 * session or the link was already dead. What that session BELONGS to is the
 * separate question the two clauses below answer.
 *
 * NOT wrapped in RequireRegistered, unlike UpdatePasswordPage: that gate bounces
 * a student straight to /assignments, which is where this page sends them itself
 * — but only AFTER they have a password, and skipping past that is how an
 * invited account ends up with a credential nobody knows.
 */
export const StudentWelcomePage = () => {
    const { session, loading } = useSession();
    const invite = useUnclaimedInvite(session, loading);

    if (loading) {
        return <BrandLoading />;
    }
    // Not "is anybody signed in" but "could an invite link have produced this
    // account". A dead link does not clear the session this browser already
    // held — auth-js keeps it on purpose, so a spent magic link cannot sign
    // somebody out — and the form below writes its password onto whatever
    // session is current. Without this clause a teacher signed in on the family
    // iPad has their own password silently replaced by the child typing into a
    // link that never hydrated. app_metadata is admin-set by student-provision
    // before the invitation goes out, so a genuine invitee always carries the
    // flag and nobody can forge one.
    //
    // Ahead of the roster read, so the two answers that need no network do not
    // wait on one.
    if (!session || userTypeOf(session) !== 'student') {
        return <DeadLink />;
    }
    // ...and the student's own row decides WHICH student, since the clause above
    // is satisfied by any of them. See useUnclaimedInvite.
    if (invite === 'checking') {
        return <BrandLoading />;
    }
    if (invite === 'spent') {
        return <DeadLink />;
    }
    const meta = session.user.user_metadata as Record<string, unknown> | undefined;
    const name = typeof meta?.['display_name'] === 'string' ? (meta['display_name'] as string) : null;
    return <ChoosePassword name={name} />;
};

/**
 * One message for every way this can fail.
 *
 * Expired, already spent, an error fragment, or simply opened without a link at
 * all: they differ to the auth server and not at all to the child holding the
 * phone, because the remedy is the same in every case and it is their teacher.
 * Naming the cause would only offer them a distinction they cannot act on.
 */
const DeadLink = () => (
    <BrandShell
        title="This link no longer works"
        subtitle="That link has expired or was already used — ask your teacher to send a new one."
    >
        <p className="text-center text-sm text-stone-600">
            <Link to="/student" className={linkClassName}>
                Go to sign in
            </Link>
        </p>
    </BrandShell>
);

const ChoosePassword = ({ name }: { name: string | null }) => {
    const navigate = useNavigate();

    return (
        <BrandShell
            title="Choose your password"
            subtitle={
                name
                    ? `Hi ${name} — pick a password for your Cleffy account.`
                    : 'Pick a password for your Cleffy account.'
            }
        >
            <AuthCredentialsForm
                password
                confirm
                passwordId="welcome-password"
                confirmId="welcome-confirm"
                minPasswordLength={STUDENT_PASSWORD_MIN}
                submitLabel="Save password"
                busyLabel="Saving…"
                fallbackError="Could not save your password."
                onSubmit={async ({ password }) => {
                    await updatePassword(password);
                    // Best effort on purpose. This flips the roster row from
                    // Invited to Active and nothing else — the password above is
                    // already saved and the account already works, so a student
                    // stopped here would be stopped over a badge on a page they
                    // cannot see. The row heals the next time anything claims it.
                    try {
                        await getSupabase().rpc('mark_student_claimed');
                    } catch {
                        // Ignored: see above.
                    }
                    navigate('/assignments', { replace: true });
                }}
            />
        </BrandShell>
    );
};
