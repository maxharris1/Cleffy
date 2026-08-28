import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';

import { useSession, userTypeOf } from '@/features/auth/session';
import { StudentAuthError, claimStudentAccount } from '@/features/student/studentApi';
import { BrandLoading, BrandShell } from '@/ui/BrandShell';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';
import { TextField } from '@/ui/TextField';
import { fieldClassName, fieldLabelClassName, linkClassName } from '@/ui/classNames';

// Imported across the app/server boundary on purpose: studentCodes.ts is written
// dependency-free precisely so Deno, vitest and this browser bundle can all load
// the one copy of these rules. A page whose job is to pre-empt a 422 has to be
// checking the rule the function will actually apply, and a second copy here
// would be a rule that drifts silently the first time the server's is edited.
import {
    STUDENT_PASSWORD_MIN,
    USERNAME_MAX,
    USERNAME_MIN,
    isPlausibleLoginCode,
    isValidUsername,
    normalizeLoginCode,
    normalizeUsername,
} from '../../../supabase/functions/_shared/studentCodes';

/**
 * Where a printed setup code is spent, once.
 *
 * Public like the sign-in page, and for the same reason: the student has no
 * session yet — this is one of the two pages that can hand them one.
 *
 * Two visual steps, ONE server call. Splitting the code away from the credential
 * keeps a child looking at a single thing at a time, but checking the code
 * separately would mean asking the server whether it exists before the student
 * has committed to anything, which is exactly the oracle student-claim is built
 * not to be. So step one is shape only, and the code travels with the username
 * and password in the single request that either claims the account or does not.
 */
export const StudentClaimPage = () => {
    const { session, loading } = useSession();

    if (loading) {
        return <BrandLoading />;
    }
    // Already signed in as a student: their code has been spent already.
    if (userTypeOf(session) === 'student') {
        return <Navigate to="/assignments" replace />;
    }
    return <ClaimFlow />;
};

/** Big, centred, monospaced: a code read off paper, one glyph at a time. */
const CODE_INPUT_CLASS = fieldClassName('md', 'mt-1.5 text-center font-mono text-xl uppercase tracking-wide');

const USERNAME_HINT = `${USERNAME_MIN}-${USERNAME_MAX} lowercase letters, numbers and underscores`;

const ClaimFlow = () => {
    const navigate = useNavigate();
    const [step, setStep] = useState<1 | 2>(1);
    const [code, setCode] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [usernameError, setUsernameError] = useState<string | null>(null);
    const [strandedMessage, setStrandedMessage] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const usernameRef = useRef<HTMLInputElement | null>(null);

    // Focus follows the complaint, but only once the field is enabled again —
    // the input is still disabled in the render that carries the failure.
    useEffect(() => {
        if (usernameError) {
            usernameRef.current?.focus();
        }
    }, [usernameError]);

    const normalizedUsername = normalizeUsername(username);

    const next = () => {
        if (!isPlausibleLoginCode(normalizeLoginCode(code))) {
            setError('That doesn’t look like a complete code');
            return;
        }
        setError(null);
        setStep(2);
    };

    const claim = async () => {
        if (!isValidUsername(normalizedUsername)) {
            setUsernameError(`Pick a username of ${USERNAME_HINT}.`);
            return;
        }
        if (password.length < STUDENT_PASSWORD_MIN) {
            setError(`Password must be at least ${STUDENT_PASSWORD_MIN} characters.`);
            return;
        }
        if (password !== confirm) {
            setError('Passwords do not match.');
            return;
        }
        setError(null);
        setUsernameError(null);
        setBusy(true);
        try {
            // The code goes as typed — the function folds case and dashes itself.
            // The username goes normalized, because that spelling is the one the
            // student was just shown, and it is what they will type to sign in.
            await claimStudentAccount({ code, username: normalizedUsername, password });
            navigate('/assignments', { replace: true });
        } catch (err) {
            setBusy(false);
            if (err instanceof StudentAuthError) {
                // The code is the only thing step one owns, so a refusal of it
                // sends them back there with what they typed still in the field.
                if (err.code === 'invalid_code') {
                    setStep(1);
                    setError(err.message);
                    return;
                }
                if (err.code === 'username_taken' || err.code === 'invalid_username') {
                    setUsernameError(err.message);
                    return;
                }
                // The account IS claimed — the code is spent and the credential
                // is real, only the automatic sign-in fell over. Anything that
                // looks like "try again" would be a lie, so this stops and points
                // at the door their new password already opens.
                if (err.code === 'claimed_sign_in_failed') {
                    setStrandedMessage(err.message);
                    return;
                }
            }
            setError(err instanceof Error ? err.message : 'That did not work');
        }
    };

    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (step === 1) {
            next();
            return;
        }
        void claim();
    };

    if (strandedMessage) {
        return (
            <BrandShell title="Your account is ready" subtitle={strandedMessage}>
                <p className="text-center text-sm text-stone-600">
                    <Link to="/student" className={linkClassName}>
                        Go to sign in
                    </Link>
                </p>
            </BrandShell>
        );
    }

    return (
        <BrandShell
            title="Set up your account"
            subtitle={
                step === 1
                    ? 'Type the setup code your teacher gave you.'
                    : 'Choose the username and password you will use from now on.'
            }
        >
            <form onSubmit={submit}>
                {step === 1 ? (
                    <>
                        <label htmlFor="claim-code" className={fieldLabelClassName}>
                            Setup code
                        </label>
                        <input
                            id="claim-code"
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            autoFocus
                            // The code lives on paper, not in a keychain: autofill
                            // has nothing useful to offer, and a suggestion strip
                            // over the field only gets in the way.
                            autoComplete="off"
                            autoCapitalize="characters"
                            autoCorrect="off"
                            spellCheck={false}
                            placeholder="ABCD-EFGH-JKLM"
                            className={CODE_INPUT_CLASS}
                        />
                        <Button type="submit" className="mt-4 w-full">
                            Next
                        </Button>
                    </>
                ) : (
                    <>
                        <label htmlFor="claim-username" className={fieldLabelClassName}>
                            Username
                        </label>
                        <input
                            id="claim-username"
                            ref={usernameRef}
                            value={username}
                            onChange={(e) => {
                                setUsername(e.target.value);
                                setUsernameError(null);
                            }}
                            disabled={busy}
                            autoFocus
                            autoComplete="username"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            placeholder="ada_lovelace"
                            className={fieldClassName('md', 'mt-1.5')}
                        />
                        <p className="mt-1.5 text-xs text-stone-500">{USERNAME_HINT}</p>
                        {/* Shown only when the two differ, so a student who typed
                            capitals learns what they will actually sign in with. */}
                        {normalizedUsername && normalizedUsername !== username ? (
                            <p className="mt-1 text-xs text-stone-600">
                                You will sign in as <span className="font-medium">{normalizedUsername}</span>
                            </p>
                        ) : null}
                        {usernameError ? <ErrorText className="mt-1.5">{usernameError}</ErrorText> : null}
                        <TextField
                            id="claim-password"
                            label="Password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            disabled={busy}
                            autoComplete="new-password"
                            spaced
                        />
                        <TextField
                            id="claim-confirm"
                            label="Confirm password"
                            type="password"
                            value={confirm}
                            onChange={(e) => setConfirm(e.target.value)}
                            disabled={busy}
                            autoComplete="new-password"
                            spaced
                        />
                        <Button type="submit" disabled={busy} className="mt-4 w-full">
                            {busy ? 'Setting up…' : 'Create my account'}
                        </Button>
                    </>
                )}
                {error ? <ErrorText className="mt-2.5">{error}</ErrorText> : null}
            </form>
            <p className="mt-6 text-center text-sm text-stone-600">
                {step === 2 ? (
                    <button type="button" onClick={() => setStep(1)} className={`cursor-pointer ${linkClassName}`}>
                        Back to the code
                    </button>
                ) : (
                    <Link to="/student" className={linkClassName}>
                        I already have a username
                    </Link>
                )}
            </p>
        </BrandShell>
    );
};
