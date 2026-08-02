import { Link, useNavigate } from 'react-router';

import { AuthCredentialsForm } from '@/features/auth/AuthCredentialsForm';
import { RequireRegistered } from '@/features/auth/AuthGates';
import { updatePassword } from '@/features/auth/session';
import { BrandShell } from '@/ui/BrandShell';
import { linkClassName } from '@/ui/classNames';

/**
 * Recovery links land here with hash tokens. useSession hydrates the recovery
 * session; RequireRegistered waits for that before showing the form.
 */
export const UpdatePasswordPage = () => (
    <RequireRegistered fallback="/login">{() => <UpdatePasswordForm />}</RequireRegistered>
);

const UpdatePasswordForm = () => {
    const navigate = useNavigate();

    return (
        <BrandShell title="Set a new password" subtitle="Choose a password for your Cleffy account.">
            <AuthCredentialsForm
                password
                confirm
                passwordId="update-password"
                confirmId="update-confirm"
                passwordLabel="New password"
                submitLabel="Update password"
                busyLabel="Saving…"
                fallbackError="Could not update password."
                footer={
                    <p className="mt-6 text-center text-sm text-stone-600">
                        <Link to="/library" className={linkClassName}>
                            Skip to library
                        </Link>
                    </p>
                }
                onSubmit={async ({ password }) => {
                    await updatePassword(password);
                    navigate('/library', { replace: true });
                }}
            />
        </BrandShell>
    );
};
