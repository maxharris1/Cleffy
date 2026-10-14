import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { AuthCredentialsForm } from '@/features/auth/AuthCredentialsForm';
import { RequireGuest } from '@/features/auth/AuthGates';
import { ResendConfirmation } from '@/features/auth/ResendConfirmation';
import { signUpWithPassword } from '@/features/auth/session';
import { AgreementNote } from '@/features/legal/AgreementNote';
import { BrandShell } from '@/ui/BrandShell';
import { linkClassName } from '@/ui/classNames';

export const RegisterPage = () => (
    <RequireGuest>
        <RegisterForm />
    </RequireGuest>
);

const RegisterForm = () => {
    const navigate = useNavigate();
    const [needsConfirm, setNeedsConfirm] = useState(false);
    const [email, setEmail] = useState('');

    if (needsConfirm) {
        return (
            <BrandShell title="Check your email" subtitle={`We sent a confirmation link to ${email}.`}>
                <p className="text-center text-sm text-stone-600">
                    After confirming, you can{' '}
                    <Link to="/login" className={linkClassName}>
                        log in
                    </Link>
                    . The link works once and expires after an hour.
                </p>
                {/* The way back from an expired link. Without it, the only
                    route was signing up again — which answers "that email
                    already exists, try signing in" — and then signing in,
                    which answers "email not confirmed". */}
                <ResendConfirmation email={email} className="mt-5" />
            </BrandShell>
        );
    }

    return (
        <BrandShell title="Create account" subtitle="Upload scores, annotate, and share with your class.">
            <AuthCredentialsForm
                email
                password
                confirm
                emailId="register-email"
                passwordId="register-password"
                confirmId="register-confirm"
                submitLabel="Create account"
                busyLabel="Creating…"
                fallbackError="Could not create account."
                captchaAction="signup"
                footer={
                    <>
                        <AgreementNote action="creating an account" className="mt-4 text-center" />
                        <p className="mt-6 text-center text-sm text-stone-600">
                            Already have an account?{' '}
                            <Link to="/login" className={linkClassName}>
                                Log in
                            </Link>
                        </p>
                    </>
                }
                onSubmit={async ({ email: nextEmail, password, captchaToken }) => {
                    const result = await signUpWithPassword(nextEmail, password, captchaToken);
                    if (result.needsEmailConfirmation) {
                        setEmail(nextEmail);
                        setNeedsConfirm(true);
                        return;
                    }
                    navigate('/library', { replace: true });
                }}
            />
        </BrandShell>
    );
};
