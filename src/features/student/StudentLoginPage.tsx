import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';

import { useSession, userTypeOf } from '@/features/auth/session';
import { loginWithCode } from '@/features/student/studentApi';
import { BrandLoading, BrandShell } from '@/ui/BrandShell';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';
import { fieldClassName, fieldLabelClassName, linkClassName } from '@/ui/classNames';

/**
 * The student front door: one field, one button, no account to make.
 *
 * Public by design — a student arriving here has no session, because this is
 * the page that gets them one. Everything a teacher's sign-in offers (register,
 * forgot password, providers) is absent on purpose: there is no email behind a
 * provisioned student, so every one of those choices would be a dead end for
 * the child holding the card.
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
    return <CodeEntry />;
};

/** Big, centred, monospaced: a code read off paper, one glyph at a time. */
const CODE_INPUT_CLASS = fieldClassName('md', 'mt-1.5 text-center font-mono text-xl uppercase tracking-wide');

const CodeEntry = () => {
    const navigate = useNavigate();
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (code.trim().length === 0) {
            setError('Type the code your teacher gave you.');
            return;
        }
        setError(null);
        setBusy(true);
        try {
            // Sent exactly as typed. The function normalizes case, dashes and
            // spaces itself, so trimming or reshaping it here could only ever
            // turn a code that would have worked into one that does not.
            await loginWithCode(code);
            navigate('/assignments', { replace: true });
        } catch (err) {
            setBusy(false);
            setError(err instanceof Error ? err.message : 'That code did not work');
        }
    };

    return (
        <BrandShell title="Your music" subtitle="Type the code your teacher gave you.">
            <form onSubmit={(e) => void submit(e)}>
                <label htmlFor="student-code" className={fieldLabelClassName}>
                    Your code
                </label>
                <input
                    id="student-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    disabled={busy}
                    autoFocus
                    // The code is not a password and lives on paper, not in a
                    // keychain: autofill has nothing useful to offer, and a
                    // suggestion strip over the field only gets in the way.
                    autoComplete="off"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="ABCD-EFGH-JKLM"
                    className={CODE_INPUT_CLASS}
                />
                <Button type="submit" disabled={busy} className="mt-4 w-full">
                    {busy ? 'Opening…' : 'Open my music'}
                </Button>
                {error ? <ErrorText className="mt-2.5">{error}</ErrorText> : null}
            </form>
            <p className="mt-6 text-center text-sm text-stone-600">
                <Link to="/login" className={linkClassName}>
                    I am a teacher
                </Link>
            </p>
        </BrandShell>
    );
};
