import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';

import { useSession, userTypeOf } from '@/features/auth/session';
import { TurnstileField } from '@/features/auth/TurnstileField';
import { isTurnstileEnabled } from '@/features/auth/turnstile';
import { LegalLinks } from '@/features/legal/LegalLinks';
import type { SignedOutByTeacherState } from '@/features/student/endedSignIn';
import { discardedChangesNotice, keptChangesNotice } from '@/features/student/keptChangesNotice';
import { loginStudent } from '@/features/student/studentApi';
import { BrandLoading, BrandShell } from '@/ui/BrandShell';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';
import { TextField } from '@/ui/TextField';
import { linkClassName } from '@/ui/classNames';

/**
 * The student front door: the credential they chose, not the card they were given.
 *
 * Public by design — a student arriving here has no session, because this is the
 * page that gets them one. One field takes either half of the roster: a username
 * claimed off a setup code, or the address a teacher invited them at. The page
 * never asks which they are, because a student does not know the word for it;
 * loginStudent reads the '@' and routes accordingly.
 *
 * Registration is still absent, and always will be: a student account exists
 * because a teacher provisioned it, so "create one" would lead nowhere.
 */
export const StudentLoginPage = () => {
    const { session, loading } = useSession();

    if (loading) {
        return <BrandLoading />;
    }
    // Already signed in as a student: there is nothing here left to type.
    if (userTypeOf(session) === 'student') {
        return <Navigate to="/assignments" replace />;
    }
    return <CredentialEntry />;
};

/**
 * Said when the app signed a student out because their teacher archived them
 * or reset their access (or the account is gone): without it the student lands
 * back here with no idea why.
 */
export const SIGNED_OUT_BY_TEACHER =
    'You were signed out because your teacher changed your access. Ask your teacher if you need a new setup code.';

/**
 * Said instead when the account itself is gone (deleted with the teacher's):
 * there is no access left to change, and no next sign-in to promise.
 */
export const ACCOUNT_DELETED =
    'You were signed out because this account was deleted. It cannot be used to sign in again; ask your teacher if you need a new one.';

const CredentialEntry = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const state = location.state as Partial<Record<keyof SignedOutByTeacherState, unknown>> | null;
    const signedOutByTeacher = state?.signedOutByTeacher === true;
    const accountDeleted = state?.accountDeleted === true;
    const keptChanges = typeof state?.keptChanges === 'number' ? state.keptChanges : 0;
    const discardedChanges = typeof state?.discardedChanges === 'number' ? state.discardedChanges : 0;
    const [identifier, setIdentifier] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /**
     * The Turnstile token this sign-in carries, or null on a build with no site
     * key — which is every build today, and why this page is unchanged until
     * Max sets one.
     *
     * It is here because BOTH halves of the roster sign in through a password
     * grant: an email-method student goes straight at GoTrue, and a username
     * student goes through student-login, which calls the same grant
     * server-side with whatever token the caller sent. GoTrue's captcha is
     * project-wide, so switching it on without this would refuse every student
     * at the sign-in box — the function has accepted a token since it was
     * written, and nothing was producing one.
     */
    const [captchaToken, setCaptchaToken] = useState<string | null>(null);
    const [captchaRound, setCaptchaRound] = useState(0);
    const captchaRequired = isTurnstileEnabled();

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (identifier.trim().length === 0 || password.length === 0) {
            setError('Type your username and password.');
            return;
        }
        // After the fields, so a child who left one empty is not first told off
        // about the robot check. Never reached on a build with no site key.
        if (captchaRequired && !captchaToken) {
            setError('Finish the “I’m human” check, then try again.');
            return;
        }
        setError(null);
        setBusy(true);
        try {
            // Sent exactly as typed. The server folds case and space itself, so
            // reshaping it here could only ever turn a sign-in that would have
            // worked into one that does not.
            await loginStudent(identifier, password, captchaToken);
            navigate('/assignments', { replace: true });
        } catch (err) {
            setBusy(false);
            setError(err instanceof Error ? err.message : 'That did not work');
            if (captchaRequired) {
                // The token is spent the moment it is redeemed, whatever became
                // of the credential beside it, so a retry needs a new challenge
                // rather than the dead proof in hand.
                setCaptchaToken(null);
                setCaptchaRound((round) => round + 1);
            }
        }
    };

    return (
        <BrandShell title="Your music" subtitle="Sign in with the username or email you use for Cleffy.">
            {/* Stays up through a failed sign-in: what became of the queued
                changes is still true, and still the thing to know. */}
            {signedOutByTeacher && accountDeleted ? (
                <p className="mb-4 text-sm text-amber-800" role="status">
                    {ACCOUNT_DELETED}
                    {discardedChanges > 0 ? ` ${discardedChangesNotice(discardedChanges)}` : null}
                </p>
            ) : signedOutByTeacher ? (
                <p className="mb-4 text-sm text-amber-800" role="status">
                    {SIGNED_OUT_BY_TEACHER}
                    {keptChanges > 0 ? ` ${keptChangesNotice(keptChanges)}` : null}
                </p>
            ) : null}
            <form onSubmit={(e) => void submit(e)}>
                <TextField
                    id="student-identifier"
                    label="Username or email"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    disabled={busy}
                    autoFocus
                    // Real credentials now, not a code off a card: a password
                    // manager that offers to fill and remember these is doing a
                    // student a favour, so nothing here waves it away.
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                />
                <TextField
                    id="student-password"
                    label="Password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                    autoComplete="current-password"
                    spaced
                />
                <TurnstileField key={captchaRound} action="student-login" onToken={setCaptchaToken} />
                <Button type="submit" disabled={busy} className="mt-4 w-full">
                    {busy ? 'Opening…' : 'Open my music'}
                </Button>
                {error ? <ErrorText className="mt-2.5">{error}</ErrorText> : null}
            </form>
            <p className="mt-6 text-center text-sm text-stone-600">
                <Link to="/student/claim" className={linkClassName}>
                    Have a setup code from your teacher?
                </Link>
            </p>
            <p className="mt-4 text-center text-sm text-stone-600 pointer-coarse:mt-6">
                <Link to="/forgot-password" className={linkClassName}>
                    Forgot your password?
                </Link>
            </p>
            {/* A username has no inbox behind it, so the reset email above cannot
                reach that half of the roster — their teacher is the reset. */}
            <p className="mt-1 text-center text-xs text-stone-500">
                Sign in with a username? Ask your teacher to reset your access.
            </p>
            <p className="mt-6 text-center text-sm text-stone-600">
                <Link to="/login" className={linkClassName}>
                    I am a teacher
                </Link>
            </p>
            <LegalLinks className="mt-6 justify-center" />
        </BrandShell>
    );
};
