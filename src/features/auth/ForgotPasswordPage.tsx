import { useState } from 'react';
import { Link } from 'react-router';

import { AuthCredentialsForm } from '@/features/auth/AuthCredentialsForm';
import { passwordResetProblem } from '@/features/auth/authErrors';
import { requestPasswordReset } from '@/features/auth/session';
import { BrandShell } from '@/ui/BrandShell';
import { linkClassName } from '@/ui/classNames';

/** Thrown to the form for the few failures it may report (see passwordResetProblem). */
class ResetProblem extends Error {}

/**
 * Password reset request. Whatever happens to an address — an account was
 * mailed, there is no account, or the account's mail could not go out — the
 * page says the same neutral thing, so it cannot be used to find out who has
 * an account. Only answers that are the same for every address (a malformed
 * address, rate limiting, no connection) are reported as errors.
 */
export const ForgotPasswordPage = () => {
    const [sentTo, setSentTo] = useState<string | null>(null);

    if (sentTo) {
        return (
            <BrandShell
                title="Check your email"
                subtitle={`If an account exists for ${sentTo}, we’ve sent it a link to reset the password.`}
            >
                <p className="text-center text-sm text-stone-600">
                    Nothing after a few minutes? Check your spam folder, or try again.
                </p>
                <p className="mt-4 text-center text-sm text-stone-600">
                    <Link to="/login" className={linkClassName}>
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
                describeError={(err) =>
                    err instanceof ResetProblem ? err.message : 'Could not send the reset link. Please try again.'
                }
                footer={
                    <p className="mt-6 text-center text-sm text-stone-600">
                        <Link to="/login" className={linkClassName}>
                            Back to log in
                        </Link>
                    </p>
                }
                onSubmit={async ({ email }) => {
                    try {
                        await requestPasswordReset(email);
                    } catch (err) {
                        const problem = passwordResetProblem(err);
                        if (problem) {
                            throw new ResetProblem(problem);
                        }
                        // Anything else could depend on whether the account
                        // exists: answer it like the success it must look like.
                    }
                    setSentTo(email);
                }}
            />
        </BrandShell>
    );
};
