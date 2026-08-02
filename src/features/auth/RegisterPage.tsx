import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { AuthCredentialsForm } from '@/features/auth/AuthCredentialsForm';
import { RequireGuest } from '@/features/auth/AuthGates';
import { signUpWithPassword } from '@/features/auth/session';
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
                    .
                </p>
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
                footer={
                    <p className="mt-6 text-center text-sm text-stone-600">
                        Already have an account?{' '}
                        <Link to="/login" className={linkClassName}>
                            Log in
                        </Link>
                    </p>
                }
                onSubmit={async ({ email: nextEmail, password }) => {
                    const result = await signUpWithPassword(nextEmail, password);
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
