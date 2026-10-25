import { useState, type FormEvent, type ReactNode } from 'react';

import { mapAuthError } from '@/features/auth/authErrors';
import { TurnstileField } from '@/features/auth/TurnstileField';
import { isTurnstileEnabled } from '@/features/auth/turnstile';
import {
    PASSWORD_HINT,
    passwordProblem,
    passwordProblemMessage,
} from '../../../supabase/functions/_shared/passwordPolicy';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';
import { SwapLabel } from '@/ui/SwapLabel';
import { TextField } from '@/ui/TextField';

export interface AuthCredentials {
    email: string;
    password: string;
    /**
     * The Turnstile token to hand GoTrue, or null when this build has no site
     * key — which is every build until Max sets one, and is why every
     * `onSubmit` below may ignore it and keep working.
     */
    captchaToken?: string | null;
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
    /**
     * Name this form's Turnstile action to put the "I'm human" check on it —
     * `'signup'`, `'login'`, `'password-reset'`. Cloudflare's analytics split
     * by it, so a flood is attributable to a surface.
     *
     * Inert without `VITE_TURNSTILE_SITE_KEY`: nothing renders, nothing is
     * required, and `onSubmit` receives no token. Setting it is therefore safe
     * on a form whose server side does not require a token yet, which is how
     * this ships ahead of the keys.
     */
    captchaAction?: string;
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
    captchaAction,
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
    const [captchaToken, setCaptchaToken] = useState<string | null>(null);
    /**
     * Bumped after every failed submit, and used as the widget's React key.
     *
     * A Turnstile token is spent the moment the server redeems it, and GoTrue
     * redeems it before it decides whether the password was right — so after a
     * refused sign-in the token in hand is already dead, and retrying with it
     * would fail the captcha rather than the credential. Remounting the widget
     * is how the user gets a fresh challenge without being told to reload.
     */
    const [captchaRound, setCaptchaRound] = useState(0);
    const captchaRequired = Boolean(captchaAction) && isTurnstileEnabled();

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
        // Last, so a form with a typo in it is not first told off about the
        // robot check. Only ever reached on a build that renders the widget.
        if (captchaRequired && !captchaToken) {
            return 'Finish the “I’m human” check, then try again.';
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
            await onSubmit({ email: emailValue.trim(), password: passwordValue, captchaToken });
        } catch (err) {
            setError(describeError ? describeError(err) : mapAuthError(err, fallbackError));
            setBusy(false);
            if (captchaRequired) {
                // The token is spent whether or not the request succeeded.
                setCaptchaToken(null);
                setCaptchaRound((round) => round + 1);
            }
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
                {captchaAction ? (
                    <TurnstileField key={captchaRound} action={captchaAction} onToken={setCaptchaToken} />
                ) : null}
                <Button type="submit" disabled={busy} className="mt-4 w-full">
                    <SwapLabel labels={{ idle: submitLabel, busy: busyLabel }} active={busy ? 'busy' : 'idle'} />
                </Button>
                {error ? <ErrorText className="mt-2.5">{error}</ErrorText> : null}
            </form>
            {footer}
        </>
    );
};
