import { useState, type FormEvent, type ReactNode } from 'react';

import { BrandTextField, brandPrimaryButtonClassName } from '@/ui/BrandShell';

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
    minPasswordLength?: number;
    /** Optional slot under the password field (e.g. forgot-password link). */
    afterPassword?: ReactNode;
    footer?: ReactNode;
    fallbackError?: string;
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
    minPasswordLength = 6,
    afterPassword,
    footer,
    fallbackError = 'Something went wrong.',
    onSubmit,
}: AuthCredentialsFormProps) => {
    const [emailValue, setEmailValue] = useState('');
    const [passwordValue, setPasswordValue] = useState('');
    const [confirmValue, setConfirmValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
        if ((confirm || (password && !email)) && passwordValue.length < minPasswordLength) {
            return `Password must be at least ${minPasswordLength} characters.`;
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
            setError(err instanceof Error ? err.message : fallbackError);
            setBusy(false);
        }
    };

    return (
        <>
            <form onSubmit={(e) => void handleSubmit(e)}>
                {email ? (
                    <BrandTextField
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
                    <BrandTextField
                        id={passwordId}
                        label={passwordLabel}
                        type="password"
                        autoComplete={confirm || !email ? 'new-password' : 'current-password'}
                        value={passwordValue}
                        onChange={(e) => setPasswordValue(e.target.value)}
                        spaced={email}
                    />
                ) : null}
                {afterPassword}
                {confirm ? (
                    <BrandTextField
                        id={confirmId}
                        label="Confirm password"
                        type="password"
                        autoComplete="new-password"
                        value={confirmValue}
                        onChange={(e) => setConfirmValue(e.target.value)}
                        spaced
                    />
                ) : null}
                <button type="submit" disabled={busy} className={brandPrimaryButtonClassName}>
                    {busy ? busyLabel : submitLabel}
                </button>
                {error ? <p className="mt-2.5 text-sm text-red-600">{error}</p> : null}
            </form>
            {footer}
        </>
    );
};
