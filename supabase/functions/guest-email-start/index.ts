import { generateGuestEmailCode, handleGuestEmailStart } from '../_shared/guestEmail.ts';
import { common, deletePending, emailTaken, sendEmail } from '../_shared/guestEmailWiring.ts';
import { serviceClient } from '../_shared/rateLimit.ts';

/**
 * A guest asks to attach an email address: mail a one-time code to it. The
 * control flow, limits and refusals are in _shared/guestEmail.ts; this file is
 * only what it runs against. JWT required (supabase/config.toml): the caller
 * is the anonymous guest whose account the address would join.
 */

Deno.serve((req) =>
    handleGuestEmailStart(req, {
        ...common,
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
        generateCode: generateGuestEmailCode,
        now: () => Date.now(),
    }),
);
