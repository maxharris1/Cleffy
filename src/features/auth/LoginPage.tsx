import { Link, useNavigate } from 'react-router';

import { AuthCredentialsForm } from '@/features/auth/AuthCredentialsForm';
import { RequireGuest } from '@/features/auth/AuthGates';
import { signInWithPassword } from '@/features/auth/session';
import { BrandShell, brandLinkClassName } from '@/ui/BrandShell';

export const LoginPage = () => (
    <RequireGuest>
        <LoginForm />
    </RequireGuest>
);

const LoginForm = () => {
    const navigate = useNavigate();

    return (
        <BrandShell title="Log in" subtitle="Upload and share scores with your account.">
            <AuthCredentialsForm
                email
                password
                emailId="login-email"
                passwordId="login-password"
                submitLabel="Log in"
                busyLabel="Signing in…"
                fallbackError="Could not sign in."
                afterPassword={
                    <div className="mt-2 text-right">
                        <Link to="/forgot-password" className={brandLinkClassName}>
                            Forgot password?
                        </Link>
                    </div>
                }
                footer={
                    <p className="mt-6 text-center text-sm text-stone-600">
                        No account yet?{' '}
                        <Link to="/register" className={brandLinkClassName}>
                            Create one
                        </Link>
                    </p>
                }
                onSubmit={async ({ email, password }) => {
                    await signInWithPassword(email, password);
                    navigate('/library', { replace: true });
                }}
            />
        </BrandShell>
    );
};
