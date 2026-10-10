import { type CodeCheck, GUEST_EMAIL_MAX_ATTEMPTS, handleGuestEmailConfirm } from '../_shared/guestEmail.ts';
import { common, deletePending, emailTaken } from '../_shared/guestEmailWiring.ts';
import { passwordProblem, passwordProblemMessage } from '../_shared/passwordPolicy.ts';
import { serviceClient } from '../_shared/rateLimit.ts';

/**
 * A guest enters the code mailed by guest-email-start, with a password: attach
 * both to their anonymous account, which makes it a registered one with the
 * same id. The control flow is in _shared/guestEmail.ts; this file is only
 * what it runs against. JWT required (supabase/config.toml).
 */

const CODE_CHECKS: readonly CodeCheck[] = ['ok', 'mismatch', 'locked', 'expired', 'missing'];

Deno.serve((req) =>
    handleGuestEmailConfirm(req, {
        ...common,
        password: { passwordProblem, passwordProblemMessage },
        emailTaken,
        checkCode: async (userId, email, codeHash) => {
            const admin = serviceClient();
            if (!admin) {
                return null;
            }
            const { data, error } = await admin.rpc('check_guest_email_code', {
                p_user_id: userId,
                p_email: email,
                p_code_hash: codeHash,
                p_max_attempts: GUEST_EMAIL_MAX_ATTEMPTS,
            });
            if (error || !CODE_CHECKS.includes(data as CodeCheck)) {
                console.error(`check_guest_email_code failed: ${error?.message ?? 'unexpected answer'}`);
                return null;
            }
            return data as CodeCheck;
        },
        attach: async (userId, email, password) => {
            const admin = serviceClient();
            if (!admin) {
                return 'failed';
            }
            // email_confirm: the code just proved it. GoTrue then creates the
            // email identity and clears is_anonymous in the same transaction,
            // so the guest's id — and every membership and mark under it — is
            // now a registered account. The guard_guest_email trigger lets it
            // through because checkCode just stamped this address as proven.
            // Setting a password here also deletes every session the user has
            // (GoTrue's admin update logs the user out everywhere), the guest's
            // own included: the client signs in again with this password
            // (src/features/auth/guestUpgrade.ts), not a refresh, which can
            // only fail now.
            // A clash with an account registered since start is not reported
            // here as email_exists (admin update has no such check; it is a
            // unique-index "Database error"): the handler asks again.
            const { error } = await admin.auth.admin.updateUserById(userId, {
                email,
                password,
                email_confirm: true,
            });
            if (!error) {
                return 'ok';
            }
            const code = (error as { code?: unknown }).code;
            if (code === 'email_exists' || /already been registered/i.test(error.message)) {
                return 'email_taken';
            }
            if (code === 'weak_password') {
                return 'weak_password';
            }
            console.error(`could not attach the email for ${userId}: ${error.message}`);
            return 'failed';
        },
        deletePending,
    }),
);
