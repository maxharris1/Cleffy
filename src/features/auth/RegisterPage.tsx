import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import type { AgeGate } from '@/features/auth/ageCheck';
import { AgeScreen } from '@/features/auth/AgeScreen';
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
    /** The age screen's outcome; the form is not shown until there is one. */
    const [ageGate, setAgeGate] = useState<AgeGate | null>(null);

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

    if (!ageGate) {
        return <AgeScreen purpose="register" onPass={setAgeGate} footer={<SignInInstead />} />;
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
                        <SignInInstead />
                    </>
                }
                onSubmit={async ({ email: nextEmail, password, captchaToken }) => {
                    const result = await signUpWithPassword(nextEmail, password, captchaToken, ageGate);
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

const SignInInstead = () => (
    <p className="mt-6 text-center text-sm text-stone-600">
        Already have an account?{' '}
        <Link to="/login" className={linkClassName}>
            Log in
        </Link>
    </p>
);
