import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';

import { useSession, userTypeOf } from '@/features/auth/session';
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

const CredentialEntry = () => {
    const navigate = useNavigate();
    const [identifier, setIdentifier] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (identifier.trim().length === 0 || password.length === 0) {
            setError('Type your username and password.');
            return;
        }
        setError(null);
        setBusy(true);
        try {
            // Sent exactly as typed. The server folds case and space itself, so
            // reshaping it here could only ever turn a sign-in that would have
            // worked into one that does not.
            await loginStudent(identifier, password);
            navigate('/assignments', { replace: true });
        } catch (err) {
            setBusy(false);
            setError(err instanceof Error ? err.message : 'That did not work');
        }
    };

    return (
        <BrandShell title="Your music" subtitle="Sign in with the username or email you use for Cleffy.">
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
            <p className="mt-4 text-center text-sm text-stone-600">
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
        </BrandShell>
    );
};
