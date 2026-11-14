import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import type { AgeGate } from '@/features/auth/ageCheck';
import { AgeScreen } from '@/features/auth/AgeScreen';
import { AuthCredentialsForm } from '@/features/auth/AuthCredentialsForm';
import { isRegisteredSession, signInWithPassword, signOut, useSession } from '@/features/auth/session';
import {
    acceptInvite,
    deadInviteMessage,
    peekInvite,
    type AcceptResult,
    type InvitePeek,
} from '@/features/share/inviteApi';
import { tokenFromHash } from '@/features/share/shareLinkText';
import { BrandShell } from '@/ui/BrandShell';
import { Button } from '@/ui/Button';
import { linkClassName } from '@/ui/classNames';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { TextField } from '@/ui/TextField';

type Step =
    | { kind: 'loading' }
    | { kind: 'dead'; state: string }
    | { kind: 'failed' }
    | { kind: 'ready' }
    | { kind: 'mismatch' }
    | { kind: 'signIn' }
    | { kind: 'age' }
    | { kind: 'refused' }
    | { kind: 'password'; ageGate: AgeGate };

/**
 * /invite#<token> (Share v2, D5): someone invited by email. An account
 * holder accepts in one tap (or signs in first); someone new passes the age
 * screen and chooses a password, and the account is made on accept. A
 * refusal at the age screen sends nothing, so no account is made.
 */
export const InvitePage = () => {
    const location = useLocation();
    const navigate = useNavigate();
    const { session, loading } = useSession();
    const [token] = useState(() => tokenFromHash(location.hash));
    const [invite, setInvite] = useState<InvitePeek | null>(null);
    const [step, setStep] = useState<Step>({ kind: 'loading' });
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!token) {
            return;
        }
        let current = true;
        void peekInvite(token).then((peek) => {
            if (!current) {
                return;
            }
            if (peek.kind === 'pending') {
                setInvite(peek.invite);
                setStep({ kind: 'ready' });
            } else {
                setStep(peek.kind === 'dead' ? peek : { kind: 'failed' });
            }
        });
        return () => {
            current = false;
        };
    }, [token]);

    const registered = isRegisteredSession(session);
    const accessToken = registered ? (session?.access_token ?? null) : null;

    const finish = useCallback(
        (result: AcceptResult): boolean => {
            switch (result.kind) {
                case 'ok':
                    navigate(`/doc/${result.documentId}`, { replace: true });
                    return true;
                case 'email_mismatch':
                    setStep({ kind: 'mismatch' });
                    return true;
                case 'sign_in_required':
                    setStep({ kind: 'signIn' });
                    return true;
                case 'below_consent_age':
                    setStep({ kind: 'refused' });
                    return true;
                case 'dead':
                    setStep(result);
                    return true;
                case 'age_check_missing':
                    setStep({ kind: 'age' });
                    return true;
                case 'weak_password':
                case 'failed':
                    setError(result.message);
                    return false;
            }
        },
        [navigate],
    );

    const accept = async () => {
        if (!token || busy) {
            return;
        }
        setBusy(true);
        setError(null);
        finish(await acceptInvite(token, accessToken));
        setBusy(false);
    };

    if (!token) {
        return <DeadInvite state="invalid" />;
    }
    if (step.kind === 'dead') {
        return <DeadInvite state={step.state} />;
    }
    if (step.kind === 'failed') {
        return (
            <BrandShell title="Invite">
                <ErrorText className="text-center">Could not open this invite. Try again in a moment.</ErrorText>
            </BrandShell>
        );
    }
    if (step.kind === 'loading' || loading || !invite) {
        return (
            <BrandShell title="Invite">
                <LoadingText className="text-center">Opening the invite…</LoadingText>
            </BrandShell>
        );
    }
    if (step.kind === 'age') {
        return (
            <AgeScreen
                purpose="join"
                onPass={(ageGate) => {
                    setError(null);
                    setStep({ kind: 'password', ageGate });
                }}
            />
        );
    }

    const headline = `${invite.inviterName ?? 'Someone'} invited you to ${invite.title ?? 'a score'} as ${
        invite.role === 'editor' ? 'an editor' : 'a viewer'
    }`;

    if (step.kind === 'refused') {
        return (
            <BrandShell title={headline}>
                <p className="text-center text-sm text-stone-700">
                    Sorry, you can't make an account here. Nothing was saved.
                </p>
            </BrandShell>
        );
    }
    if (step.kind === 'mismatch') {
        return (
            <BrandShell title={headline}>
                <div className="text-center">
                    <p className="text-sm text-stone-700">
                        This invite is for {invite.emailMasked}. Sign out to accept it.
                    </p>
                    <Button
                        className="mt-4"
                        onClick={() => {
                            void signOut().then(() => setStep({ kind: 'ready' }));
                        }}
                    >
                        Sign out
                    </Button>
                </div>
            </BrandShell>
        );
    }
    if (step.kind === 'signIn') {
        return (
            <BrandShell
                title={headline}
                subtitle={`You already have an account. Sign in as ${invite.emailMasked} to accept.`}
            >
                <AuthCredentialsForm
                    email
                    password
                    captchaAction="login"
                    submitLabel="Sign in and accept"
                    busyLabel="Signing in…"
                    onSubmit={async ({ email, password, captchaToken }) => {
                        await signInWithPassword(email, password, captchaToken);
                        setStep({ kind: 'ready' });
                    }}
                />
            </BrandShell>
        );
    }
    if (step.kind === 'password') {
        return (
            <BrandShell title="Choose a password" subtitle={headline}>
                <TextField
                    id="invite-email"
                    label="Email"
                    value={invite.emailMasked}
                    readOnly
                    disabled
                    onChange={() => undefined}
                />
                <div className="mt-4">
                    <AuthCredentialsForm
                        password
                        confirm
                        captchaAction="signup"
                        submitLabel="Create account and open"
                        busyLabel="Creating your account…"
                        describeError={(err) => (err instanceof Error ? err.message : 'Something went wrong.')}
                        onSubmit={async ({ password }) => {
                            const result = await acceptInvite(token, null, { password, ageGate: step.ageGate });
                            if (result.kind === 'ok' && result.email) {
                                await signInWithPassword(result.email, password);
                            }
                            if (!finish(result)) {
                                throw new Error(
                                    result.kind === 'weak_password' || result.kind === 'failed'
                                        ? result.message
                                        : 'Something went wrong.',
                                );
                            }
                        }}
                    />
                </div>
            </BrandShell>
        );
    }

    return (
        <BrandShell title={headline}>
            <Button className="w-full" disabled={busy} onClick={() => void accept()}>
                {registered ? (busy ? 'Accepting…' : 'Accept and open') : busy ? 'Checking…' : 'Continue'}
            </Button>
            {error ? <ErrorText className="mt-3 text-center">{error}</ErrorText> : null}
        </BrandShell>
    );
};

const DeadInvite = ({ state }: { state: string }) => (
    <BrandShell title="This invite can't be used">
        <div className="text-center">
            <ErrorText>{deadInviteMessage(state)}</ErrorText>
            <Link to="/" className={`mt-3 inline-block ${linkClassName}`}>
                Back to home
            </Link>
        </div>
    </BrandShell>
);
