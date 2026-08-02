import { useState } from 'react';
import { Link } from 'react-router';

import { AuthCredentialsForm } from '@/features/auth/AuthCredentialsForm';
import { requestPasswordReset } from '@/features/auth/session';
import { BrandShell, brandLinkClassName } from '@/ui/BrandShell';

export const ForgotPasswordPage = () => {
    const [sentTo, setSentTo] = useState<string | null>(null);

    if (sentTo) {
        return (
            <BrandShell title="Check your email" subtitle={`We sent a password reset link to ${sentTo}.`}>
                <p className="text-center text-sm text-stone-600">
                    <Link to="/login" className={brandLinkClassName}>
                        Back to log in
                    </Link>
                </p>
            </BrandShell>
        );
    }

    return (
        <BrandShell title="Forgot password" subtitle="Enter your email and we'll send a reset link.">
            <AuthCredentialsForm
                email
                emailId="forgot-email"
                submitLabel="Send reset link"
                busyLabel="Sending…"
                fallbackError="Could not send reset email."
                footer={
                    <p className="mt-6 text-center text-sm text-stone-600">
                        <Link to="/login" className={brandLinkClassName}>
                            Back to log in
                        </Link>
                    </p>
                }
                onSubmit={async ({ email }) => {
                    await requestPasswordReset(email);
                    setSentTo(email);
                }}
            />
        </BrandShell>
    );
};
