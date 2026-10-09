import { useState, type FormEvent, type ReactNode } from 'react';

import { mapAuthError } from '@/features/auth/authErrors';
import {
    PASSWORD_HINT,
    passwordProblem,
    passwordProblemMessage,
} from '../../../supabase/functions/_shared/passwordPolicy';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';
import { TextField } from '@/ui/TextField';

export interface AuthCredentials {
    email: string;
    password: string;
}

interface AuthCredentialsFormProps {
    email?: boolean;
    password?: boolean;
    confirm?: boolean;
    emailId?: string;
    passwordId?: string;
    confirmId?: string;
    passwordLabel?: string;
    submitLabel: string;
    busyLabel: string;
    /** Optional slot under the password field (e.g. forgot-password link). */
    afterPassword?: ReactNode;
    footer?: ReactNode;
    fallbackError?: string;
    /** Turns a failed submit into the message shown; defaults to mapAuthError with fallbackError. */
    describeError?: (err: unknown) => string;
    onSubmit: (credentials: AuthCredentials) => Promise<void>;
}

/** Single credentials form — owns validation, busy, and error chrome. */
export const AuthCredentialsForm = ({
    email = false,
    password = false,
    confirm = false,
    emailId = 'auth-email',
    passwordId = 'auth-password',
    confirmId = 'auth-confirm',
    passwordLabel = 'Password',
    submitLabel,
    busyLabel,
    afterPassword,
    footer,
    fallbackError = 'Something went wrong.',
    describeError,
    onSubmit,
}: AuthCredentialsFormProps) => {
    const [emailValue, setEmailValue] = useState('');
    const [passwordValue, setPasswordValue] = useState('');
    const [confirmValue, setConfirmValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // A password is being CHOSEN (sign-up, recovery, welcome) rather than typed
    // to sign in. Only then does the policy apply: an account made under the
    // old 6-character minimum must still be able to log in.
    const choosingPassword = confirm || (password && !email);

    const validationError = (): string | null => {
        if (email && !emailValue.includes('@')) {
            if (password && !confirm && passwordValue.length === 0) {
                return 'Enter your email and password.';
            }
            return 'Enter a valid email address.';
        }
        if (email && password && !confirm && passwordValue.length === 0) {
            return 'Enter your email and password.';
        }
        if (choosingPassword) {
            const problem = passwordProblem(passwordValue);
            if (problem) {
                return passwordProblemMessage(problem);
            }
        }
        if (confirm && passwordValue !== confirmValue) {
            return 'Passwords do not match.';
        }
        return null;
    };

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        const invalid = validationError();
        if (invalid) {
            setError(invalid);
            return;
        }
        setError(null);
        setBusy(true);
        try {
            await onSubmit({ email: emailValue.trim(), password: passwordValue });
        } catch (err) {
            setError(describeError ? describeError(err) : mapAuthError(err, fallbackError));
            setBusy(false);
        }
    };

    return (
        <>
            <form onSubmit={(e) => void handleSubmit(e)}>
                {email ? (
                    <TextField
                        id={emailId}
                        label="Email"
                        type="email"
                        autoComplete="email"
                        value={emailValue}
                        onChange={(e) => setEmailValue(e.target.value)}
                        placeholder="you@school.edu"
                    />
                ) : null}
                {password || confirm ? (
                    <TextField
                        id={passwordId}
                        label={passwordLabel}
                        type="password"
                        autoComplete={choosingPassword ? 'new-password' : 'current-password'}
                        value={passwordValue}
                        onChange={(e) => setPasswordValue(e.target.value)}
                        spaced={email}
                    />
                ) : null}
                {choosingPassword ? <p className="mt-1.5 text-xs text-stone-500">{PASSWORD_HINT}</p> : null}
                {afterPassword}
                {confirm ? (
                    <TextField
                        id={confirmId}
                        label="Confirm password"
                        type="password"
                        autoComplete="new-password"
                        value={confirmValue}
                        onChange={(e) => setConfirmValue(e.target.value)}
                        spaced
                    />
                ) : null}
                <Button type="submit" disabled={busy} className="mt-4 w-full">
                    {busy ? busyLabel : submitLabel}
                </Button>
                {error ? <ErrorText className="mt-2.5">{error}</ErrorText> : null}
            </form>
            {footer}
        </>
    );
};
