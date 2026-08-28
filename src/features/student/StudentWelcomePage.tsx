import { Link, useNavigate } from 'react-router';

import { AuthCredentialsForm } from '@/features/auth/AuthCredentialsForm';
import { updatePassword, useSession } from '@/features/auth/session';
import { getSupabase } from '@/lib/supabase';
import { BrandLoading, BrandShell } from '@/ui/BrandShell';
import { linkClassName } from '@/ui/classNames';

import { STUDENT_PASSWORD_MIN } from '../../../supabase/functions/_shared/studentCodes';

/**
 * Where an invited student's email link lands.
 *
 * The link carries tokens in the fragment and supabase-js exchanges them on its
 * own (detectSessionInUrl is on by default) — the same mechanism the recovery
 * link relies on — so by the time useSession stops loading, either there is a
 * session or the link was already dead.
 *
 * NOT wrapped in RequireRegistered, unlike UpdatePasswordPage: that gate bounces
 * a student straight to /assignments, which is where this page sends them itself
 * — but only AFTER they have a password, and skipping past that is how an
 * invited account ends up with a credential nobody knows.
 */
export const StudentWelcomePage = () => {
    const { session, loading } = useSession();

    if (loading) {
        return <BrandLoading />;
    }
    if (!session) {
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
