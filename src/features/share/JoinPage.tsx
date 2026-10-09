import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { forgetLocalSession, requestAccountDeletion } from '@/features/account/accountDeletion';
import { isRegisteredSession, signInAnonymouslyWithName, useSession } from '@/features/auth/session';
import { AgreementNote } from '@/features/legal/AgreementNote';
import { peekShareLink, redeemShareLink } from '@/features/share/shareService';
import { BrandShell } from '@/ui/BrandShell';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { TextField } from '@/ui/TextField';
import { linkClassName } from '@/ui/classNames';

const DEAD_LINK = 'This link is invalid, expired, or was revoked. Ask for a new one.';

/** The link's state as far as this page knows, before anyone has joined. */
type LinkCheck = 'checking' | 'live' | 'dead' | 'unknown';

/**
 * Share-link landing. If a session already exists (teacher clicking their own
 * link, returning student) we redeem with it — NEVER clobber it with a fresh
 * anonymous identity (plan §auth). Otherwise: check the link → quick name
 * prompt → anonymous sign-in → redeem → viewer.
 *
 * The check comes first because signing in is what creates a guest account:
 * asking a name and signing in before finding out the link was dead left an
 * anonymous auth user behind for every failed join. peek_share_link answers
 * without a session, so a dead link is reported before anyone is created, and
 * again just before sign-in (the link may have been revoked while the guest
 * was typing). A link that dies in the last moment between that check and the
 * redeem is still refused by redeem_share_link; the guest this page created
 * for it is then deleted again rather than left behind.
 */
export const JoinPage = () => {
    const { token } = useParams<{ token: string }>();
    const { session, loading } = useSession();
    const navigate = useNavigate();
    const [name, setName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linkCheck, setLinkCheck] = useState<LinkCheck>('checking');
    /** True once a deleted guest's session is still in memory: leave by a full page load. */
    const [guestDiscarded, setGuestDiscarded] = useState(false);
    const redeemedRef = useRef(false);
    /** Set when THIS page signed a guest in, so a failed redeem may delete what it made. */
    const createdGuestRef = useRef(false);

    // Only a visitor without a session gets checked: one with a session is
    // redeemed straight away and creates nobody, so there is nothing to save.
    const needsCheck = !loading && !session && Boolean(token);
    useEffect(() => {
        if (!needsCheck || !token) {
            return;
        }
        let current = true;
        void peekShareLink(token).then((peek) => {
            if (current) {
                setLinkCheck(peek === null ? 'unknown' : peek.valid ? 'live' : 'dead');
            }
        });
        return () => {
            current = false;
        };
    }, [needsCheck, token]);

    useEffect(() => {
        if (loading || !token || !session || redeemedRef.current) {
            return;
        }
        redeemedRef.current = true;
        redeemShareLink(token)
            .then(({ documentId }) => navigate(`/doc/${documentId}`, { replace: true }))
            .catch(async (err: unknown) => {
                const dead = err instanceof Error && err.message === 'invalid_link';
                if (dead && createdGuestRef.current) {
                    // The link died between the check and the redeem, and the
                    // guest signed in a moment ago has no reason to exist.
                    // Best effort: a failure leaves what the race always left.
                    createdGuestRef.current = false;
                    try {
                        await requestAccountDeletion();
                        forgetLocalSession();
                        setGuestDiscarded(true);
                    } catch {
                        // Keep the session: it is a working, if pointless, guest.
                    }
                }
                redeemedRef.current = false;
                setSubmitting(false);
                setError(dead ? DEAD_LINK : 'Could not join this score. Check your connection and try again.');
            });
    }, [loading, session, token, navigate]);

    const joinAsGuest = async () => {
        const trimmed = name.trim();
        if (trimmed.length === 0) {
            setError('Enter your name so collaborators know who you are.');
            return;
        }
        if (!token || submitting) {
            return;
        }
        setError(null);
        setSubmitting(true);
        // Again, right before the account is made: the link may have been
        // revoked or run out while the name was being typed.
        const peek = await peekShareLink(token);
        if (peek && !peek.valid) {
            setLinkCheck('dead');
            setSubmitting(false);
            return;
        }
        try {
            await signInAnonymouslyWithName(trimmed);
            createdGuestRef.current = true;
        } catch (err) {
            setSubmitting(false);
            setError(err instanceof Error ? err.message : 'Could not join.');
        }
    };

    if (!token) {
        return null;
    }

    const shownError = error ?? (!session && linkCheck === 'dead' ? DEAD_LINK : null);
    const checking = !session && linkCheck === 'checking';
    const busy = loading || submitting || checking || (session !== null && shownError === null);
    const registered = isRegisteredSession(session) && !guestDiscarded;
    const escapeTo = registered ? '/library' : '/';
    const escapeLabel = registered ? 'Go to the library' : 'Back to home';

    return (
        <BrandShell
            title="Join a shared score"
            subtitle={shownError || busy ? undefined : 'Enter your name so collaborators know who you are.'}
        >
            {shownError ? (
                <div className="text-center">
                    <ErrorText>{shownError}</ErrorText>
                    {guestDiscarded ? (
                        // The deleted guest's session is still in this tab's
                        // memory; a full load starts the next page without it.
                        <a href={escapeTo} className={`mt-3 inline-block ${linkClassName}`}>
                            {escapeLabel}
                        </a>
                    ) : (
                        <Link to={escapeTo} className={`mt-3 inline-block ${linkClassName}`}>
                            {escapeLabel}
                        </Link>
                    )}
                </div>
            ) : busy ? (
                <LoadingText className="text-center">{checking ? 'Checking the link…' : 'Joining…'}</LoadingText>
            ) : (
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
                    <p className="mt-3 text-xs text-stone-600">
                        No account needed — you can add an email later to keep your work across devices.
                    </p>
                    <AgreementNote action="joining" className="mt-2" />
                </>
            )}
        </BrandShell>
    );
};
