import { generateGuestEmailCode, handleGuestEmailStart } from '../_shared/guestEmail.ts';
import { common, deletePending, emailTaken, sendEmail } from '../_shared/guestEmailWiring.ts';
import { mailLimit } from '../_shared/mailBudget.ts';
import { refundRateLimit, serviceClient } from '../_shared/rateLimit.ts';
import { resendIdempotencyKey } from '../_shared/resendDelivery.ts';
import { verifyTurnstileRequest } from '../_shared/turnstileVerify.ts';

/**
 * A guest asks to attach an email address: mail a one-time code to it. The
 * control flow, limits and refusals are in _shared/guestEmail.ts; this file is
 * only what it runs against. JWT required (supabase/config.toml): the caller
 * is the anonymous guest whose account the address would join.
 *
 * Two of the things it runs against are declared elsewhere on purpose, because
 * neither belongs to this flow: the Turnstile verdict (_shared/turnstile.ts),
 * and how much of the project's mail budget guest codes may spend
 * (_shared/mailBudget.ts, which holds a reserve back for password resets and
 * sign-up confirmations). Both are read HERE rather than in the handler because
 * the handler takes no runtime imports.
 */

const env = (name: string): string | undefined => Deno.env.get(name);

Deno.serve((req) =>
    handleGuestEmailStart(req, {
        ...common,
        verifyCaptcha: verifyTurnstileRequest,
        mailBudget: {
            hour: mailLimit('guestEmailCode', 'hour', env),
            day: mailLimit('guestEmailCode', 'day', env),
        },
        emailTaken,
        savePending: async ({ userId, email, codeHash, expiresAt }) => {
            const admin = serviceClient();
            if (!admin) {
                return false;
            }
            // A fresh code replaces any earlier one, tries and proof and all.
            const { error } = await admin.from('guest_email_verifications').upsert(
                {
                    user_id: userId,
                    email,
                    code_hash: codeHash,
                    attempts: 0,
                    expires_at: expiresAt,
                    verified_email: null,
                    verified_at: null,
                },
                { onConflict: 'user_id' },
            );
            if (error) {
                console.error(`could not store the guest email code for ${userId}: ${error.message}`);
                return false;
            }
            return true;
        },
        deletePending,
        sendEmail,
        idempotencyKey: resendIdempotencyKey,
        refundRateLimit,
        generateCode: generateGuestEmailCode,
        now: () => Date.now(),
    }),
);
