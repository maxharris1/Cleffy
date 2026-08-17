import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { isRegisteredSession, signInAnonymouslyWithName, useSession } from '@/features/auth/session';
import { redeemShareLink } from '@/features/share/shareService';
import { BrandShell } from '@/ui/BrandShell';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { TextField } from '@/ui/TextField';
import { linkClassName } from '@/ui/classNames';

const JOIN_ERROR_COPY = {
    invalid_link: 'This link is invalid, expired, or was revoked. Ask for a new one.',
    join_failed: 'Could not join this score. Check your connection and try again.',
    name_required: 'Enter your name so collaborators know who you are.',
    guest_failed: 'Could not start a guest session. Try again.',
} as const;

const mapJoinError = (err: unknown): string => {
    if (err instanceof Error && err.message === 'invalid_link') {
        return JOIN_ERROR_COPY.invalid_link;
    }
    return JOIN_ERROR_COPY.join_failed;
};

/**
 * Share-link landing. If a session already exists (teacher clicking their own
 * link, returning student) we redeem with it — NEVER clobber it with a fresh
 * anonymous identity (plan §auth). Otherwise: quick name prompt → anonymous
 * sign-in → redeem → viewer.
 */
export const JoinPage = () => {
    const { token } = useParams<{ token: string }>();
    const { session, loading } = useSession();
    const navigate = useNavigate();
    const [name, setName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [retryNonce, setRetryNonce] = useState(0);
    const redeemedRef = useRef(false);

    useEffect(() => {
        if (loading || !token || !session || redeemedRef.current) {
            return;
        }
        redeemedRef.current = true;
        redeemShareLink(token)
            .then(({ documentId }) => navigate(`/doc/${documentId}`, { replace: true }))
            .catch((err: unknown) => {
                redeemedRef.current = false;
                setSubmitting(false);
                setError(mapJoinError(err));
            });
    }, [loading, session, token, navigate, retryNonce]);

    const joinAsGuest = async () => {
        const trimmed = name.trim();
        if (trimmed.length === 0) {
            setError(JOIN_ERROR_COPY.name_required);
            return;
        }
        setError(null);
        setSubmitting(true);
        try {
            await signInAnonymouslyWithName(trimmed);
        } catch {
            setSubmitting(false);
            setError(JOIN_ERROR_COPY.guest_failed);
        }
    };

    const retryRedeem = () => {
        setError(null);
        redeemedRef.current = false;
        setRetryNonce((n) => n + 1);
    };

    if (!token) {
        return null;
    }

    const redeeming = Boolean(session) && error === null && !submitting;
    const busy = loading || submitting || redeeming;
    const escapeTo = isRegisteredSession(session) ? '/library' : '/';
    const escapeLabel = isRegisteredSession(session) ? 'Go to the library' : 'Back to home';
    const showGuestForm = !session;

    return (
        <BrandShell title="Join a shared score" subtitle={error || busy ? undefined : JOIN_ERROR_COPY.name_required}>
            {error ? <ErrorText className="mb-4 text-center">{error}</ErrorText> : null}
            {busy && !error ? (
                <LoadingText className="text-center">Joining…</LoadingText>
            ) : showGuestForm ? (
                <>
                    <TextField
                        id="name"
                        label="Your name"
                        value={name}
                        autoFocus
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                void joinAsGuest();
                            }
                        }}
                        placeholder="e.g. Sharon"
                    />
                    <Button onClick={() => void joinAsGuest()} className="mt-4 w-full">
                        Join
                    </Button>
                    <p className="mt-3 text-xs text-ink-muted">
                        No account needed — you can add an email later to keep your work across devices.
                    </p>
                </>
            ) : (
                <Button onClick={retryRedeem} className="w-full">
                    Try again
                </Button>
            )}
            <Link to={escapeTo} className={`mt-3 inline-block ${linkClassName}`}>
                {escapeLabel}
            </Link>
        </BrandShell>
    );
};
