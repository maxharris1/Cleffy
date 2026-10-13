import { useState } from 'react';

import { confirmationResendProblem } from '@/features/auth/authErrors';
import { resendSignUpConfirmation } from '@/features/auth/session';
import { TurnstileField } from '@/features/auth/TurnstileField';
import { isTurnstileEnabled } from '@/features/auth/turnstile';
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
 *
 * "Sent" is a promise, so the two ways it could be made falsely are closed
 * here. The button does not send at all without a token on a build that renders
 * the widget — a null token is a refusal with no mail behind it, and `sent` is
 * the one state this component cannot leave. And a captcha refusal from GoTrue
 * is reported rather than swallowed (confirmationResendProblem names it): it
 * sends no mail, it is alike for every address, and the fix is the fresh
 * challenge this puts up with it.
 */
export const ResendConfirmation = ({ email, className = '' }: { email: string; className?: string }) => {
    const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
    const [problem, setProblem] = useState<string | null>(null);
    const [captchaToken, setCaptchaToken] = useState<string | null>(null);
    /** Bumped to remount the widget: a token is spent once it is redeemed. */
    const [captchaRound, setCaptchaRound] = useState(0);
    const captchaRequired = isTurnstileEnabled();

    if (state === 'sent') {
        return (
            <p role="status" className={`text-sm text-stone-600${className ? ` ${className}` : ''}`}>
                Sent. Open the newest email we’ve sent you — check your spam folder if it isn’t there.
            </p>
        );
    }

    const send = async () => {
        // Nothing is sent without a solved challenge: GoTrue would refuse the
        // request outright, and the `sent` screen below would then be a lie
        // with no way back from it.
        if (captchaRequired && !captchaToken) {
            setProblem('Finish the “I’m human” check, then try again.');
            return;
        }
        setState('sending');
        setProblem(null);
        try {
            await resendSignUpConfirmation(email, captchaToken);
        } catch (err) {
            const named = confirmationResendProblem(err);
            if (named) {
                setProblem(named);
                setState('idle');
                if (captchaRequired) {
                    // Whatever GoTrue made of the rest of the request, the token
                    // is spent; a retry needs a new challenge.
                    setCaptchaToken(null);
                    setCaptchaRound((round) => round + 1);
                }
                return;
            }
            // Anything else could depend on what is true of this address:
            // answer it like the success it has to look like.
        }
        setState('sent');
    };

    return (
        <div className={className}>
            <TurnstileField key={captchaRound} action="resend-confirmation" onToken={setCaptchaToken} />
            <Button variant="ghost" disabled={state === 'sending'} onClick={() => void send()} className="w-full">
                {state === 'sending' ? 'Sending…' : 'Send the email again'}
            </Button>
            {problem ? <ErrorText className="mt-2">{problem}</ErrorText> : null}
        </div>
    );
};
