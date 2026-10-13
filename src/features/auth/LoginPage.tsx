import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { AuthCredentialsForm } from '@/features/auth/AuthCredentialsForm';
import { isEmailNotConfirmed } from '@/features/auth/authErrors';
import { parseAuthNext } from '@/features/auth/authRedirect';
import { RequireGuest } from '@/features/auth/AuthGates';
import { ResendConfirmation } from '@/features/auth/ResendConfirmation';
import { signInWithPassword } from '@/features/auth/session';
import { LegalLinks } from '@/features/legal/LegalLinks';
import { BrandShell } from '@/ui/BrandShell';
import { linkClassName } from '@/ui/classNames';

export const LoginPage = () => (
    <RequireGuest>
        <LoginForm />
    </RequireGuest>
);

const LoginForm = () => {
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const next = parseAuthNext(params.get('next'));
    /**
     * The address GoTrue answered `email_not_confirmed` for, so the one failure
     * a resend can actually fix offers one.
     *
     * Only set from that specific refusal, which GoTrue reaches after checking
     * the password — so the button appears for somebody who already holds the
     * credential, and never as an answer to a guessed address. (The copy for
     * that error, in authErrors.ts, promises the button is here.)
     */
    const [unconfirmed, setUnconfirmed] = useState<string | null>(null);

    return (
        <BrandShell title="Log in" subtitle="Upload and share scores with your account.">
            <AuthCredentialsForm
                email
                password
                emailId="login-email"
                passwordId="login-password"
                submitLabel="Log in"
                busyLabel="Signing in…"
                fallbackError="Could not sign in."
                captchaAction="login"
                afterPassword={
                    <div className="mt-2 text-right">
                        <Link to="/forgot-password" className={linkClassName}>
                            Forgot password?
                        </Link>
                    </div>
                }
                footer={
                    <>
                        {/* Keyed on the address: the component is single-use
                            (one send, then a permanent "Sent" screen), so
                            reusing the instance for a SECOND unconfirmed
                            address would show that screen for an address
                            nothing was ever sent to. */}
                        {unconfirmed ? (
                            <ResendConfirmation key={unconfirmed} email={unconfirmed} className="mt-4" />
                        ) : null}
                        <p className="mt-6 text-center text-sm text-stone-600">
                            No account yet?{' '}
                            <Link to="/register" className={linkClassName}>
                                Create one
                            </Link>
                        </p>
                        <LegalLinks className="mt-6 justify-center" />
                    </>
                }
                onSubmit={async ({ email, password, captchaToken }) => {
                    try {
                        await signInWithPassword(email, password, captchaToken);
                    } catch (err) {
                        // Rethrown so the form shows the mapped message as
                        // usual; all this adds is the resend underneath it.
                        setUnconfirmed(isEmailNotConfirmed(err) ? email : null);
                        throw err;
                    }
                    navigate(next, { replace: true });
                }}
            />
        </BrandShell>
    );
};
