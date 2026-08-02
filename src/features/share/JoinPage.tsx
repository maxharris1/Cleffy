import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { isRegisteredSession, signInAnonymouslyWithName, useSession } from '@/features/auth/session';
import { redeemShareLink } from '@/features/share/shareService';
import {
    BrandShell,
    BrandTextField,
    brandLinkClassName,
    brandPrimaryButtonClassName,
} from '@/ui/BrandShell';

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
                setError(
                    err instanceof Error && err.message === 'invalid_link'
                        ? 'This link is invalid, expired, or was revoked. Ask for a new one.'
                        : 'Could not join this score. Check your connection and try again.',
                );
            });
    }, [loading, session, token, navigate]);

    const joinAsGuest = async () => {
        const trimmed = name.trim();
        if (trimmed.length === 0) {
            setError('Enter your name so collaborators know who you are.');
            return;
        }
        setError(null);
        setSubmitting(true);
        try {
            await signInAnonymouslyWithName(trimmed);
        } catch (err) {
            setSubmitting(false);
            setError(err instanceof Error ? err.message : 'Could not join.');
        }
    };

    if (!token) {
        return null;
    }

    const busy = loading || submitting || (session !== null && error === null);
    const escapeTo = isRegisteredSession(session) ? '/library' : '/';
    const escapeLabel = isRegisteredSession(session) ? 'Go to the library' : 'Back to home';

    return (
        <BrandShell
            title="Join a shared score"
            subtitle={error || busy ? undefined : 'Enter your name so collaborators know who you are.'}
        >
            {error ? (
                <div className="text-center">
                    <p className="text-red-600">{error}</p>
                    <Link to={escapeTo} className={`mt-3 inline-block ${brandLinkClassName}`}>
                        {escapeLabel}
                    </Link>
                </div>
            ) : busy ? (
                <p className="animate-pulse text-center text-stone-500">Joining…</p>
            ) : (
                <>
                    <BrandTextField
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
                    <button
                        type="button"
                        onClick={() => void joinAsGuest()}
                        className={brandPrimaryButtonClassName}
                    >
                        Join
                    </button>
                    <p className="mt-3 text-xs text-stone-500">
                        No account needed — you can add an email later to keep your work across devices.
                    </p>
                </>
            )}
        </BrandShell>
    );
};
