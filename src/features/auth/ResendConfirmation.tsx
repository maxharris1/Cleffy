import { useState } from 'react';

import { confirmationResendProblem } from '@/features/auth/authErrors';
import { resendSignUpConfirmation } from '@/features/auth/session';
import { TurnstileField } from '@/features/auth/TurnstileField';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';

/**
 * "Send the confirmation email again", for an address this page already knows.
 *
 * Why it exists: production's confirmation link lives for one hour
 * (`mailer_otp_exp = 3600`). Read the mail later than that and the link is
 * dead, and before this button the only way back was signing up again — which
 * answers "an account with this email already exists. Try signing in." —
 * which then fails with "email not confirmed". A closed loop with no exit, on
 * the first thing a new user does.
 *
 * Three things keep a send button from being an abuse path of its own:
 *
 *  * ONE send per mount. The button is gone after it is used, the way the
 *    forgot-password form is gone after one submit. A user who needs another
 *    reloads, and GoTrue's own per-address `max_frequency` and
 *    `rate_limit_email_sent` stand behind that — but a button that can be
 *    clicked forty times while someone waits is a mail bill, and this is
 *    exactly the send budget `_shared/mailBudget.ts` reserves for auth mail.
 *  * The SAME answer whatever happens, apart from the failures that are alike
 *    for every address (see `confirmationResendProblem`). GoTrue refuses an
 *    address with nothing pending and accepts one with a confirmation
 *    outstanding, so reporting the difference would make this a test for which
 *    addresses have unconfirmed accounts.
 *  * A Turnstile token when Turnstile is configured, because /resend is one of
 *    the project-wide captcha-protected GoTrue endpoints. Renders nothing and
 *    changes nothing while the site key is unset.
 */
export const ResendConfirmation = ({ email, className = '' }: { email: string; className?: string }) => {
    const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
    const [problem, setProblem] = useState<string | null>(null);
    const [captchaToken, setCaptchaToken] = useState<string | null>(null);

    if (state === 'sent') {
        return (
            <p role="status" className={`text-sm text-stone-600${className ? ` ${className}` : ''}`}>
                Sent. Open the newest email we’ve sent you — check your spam folder if it isn’t there.
            </p>
        );
    }

    const send = async () => {
        setState('sending');
        setProblem(null);
        try {
            await resendSignUpConfirmation(email, captchaToken);
        } catch (err) {
            const named = confirmationResendProblem(err);
            if (named) {
                setProblem(named);
                setState('idle');
                return;
            }
            // Anything else could depend on what is true of this address:
            // answer it like the success it has to look like.
        }
        setState('sent');
    };

    return (
        <div className={className}>
            <TurnstileField action="resend-confirmation" onToken={setCaptchaToken} />
            <Button variant="ghost" disabled={state === 'sending'} onClick={() => void send()} className="w-full">
                {state === 'sending' ? 'Sending…' : 'Send the email again'}
            </Button>
            {problem ? <ErrorText className="mt-2">{problem}</ErrorText> : null}
        </div>
    );
};
