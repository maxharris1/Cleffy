import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';

import { forgetLocalSession, requestAccountDeletion } from '@/features/account/accountDeletion';
import { LINK_GUEST_GATE } from '@/features/auth/ageCheck';
import { isRegisteredSession, signInAnonymouslyWithName, useSession } from '@/features/auth/session';
import { TurnstileField } from '@/features/auth/TurnstileField';
import { isTurnstileEnabled } from '@/features/auth/turnstile';
import { AgreementNote } from '@/features/legal/AgreementNote';
import { BusyCountdown } from '@/features/share/BusyCountdown';
import { requestShareSession, type DeadAnswer, type ShareSessionAnswer } from '@/features/share/linkSession';
import { peekShareLink, redeemShareLink } from '@/features/share/shareService';
import { deadLinkMessage, LINK_TOKEN, tokenFromHash } from '@/features/share/shareLinkText';
import type { ShareRole } from '@/types/database';
import { BrandShell } from '@/ui/BrandShell';
import { Button } from '@/ui/Button';
import { linkClassName } from '@/ui/classNames';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { TextField } from '@/ui/TextField';

const LinkViewerPage = lazy(() =>
    import('@/features/share/LinkViewerPage').then((m) => ({ default: m.LinkViewerPage })),
);

/** /s and /invite while Share v2 is off. */
export const LinkUnavailable = () => (
    <BrandShell title="This link isn't available.">
        <div className="text-center">
            <Link to="/" className={linkClassName}>
                Back to home
            </Link>
        </div>
    </BrandShell>
);

type Phase = { kind: 'checking' } | ShareSessionAnswer | { kind: 'join'; role: ShareRole };

const DeadLink = ({ answer, registered }: { answer: Pick<DeadAnswer, 'state' | 'expiredAt'>; registered: boolean }) => (
    <BrandShell title="This link can't open the score">
        <div className="text-center">
            <ErrorText>{deadLinkMessage(answer.state, answer.expiredAt)}</ErrorText>
            <Link to={registered ? '/library' : '/'} className={`mt-3 inline-block ${linkClassName}`}>
                {registered ? 'Go to the library' : 'Back to home'}
            </Link>
        </div>
    </BrandShell>
);

/**
 * /s#<token> and /join/<token> (Share v2). A signed-in visitor is redeemed as
 * a member, as before (D3); the owner lands on their own score. A signed-out
 * visitor is sent where share-session says: a view link opens the score with
 * nothing asked or kept, an editor link asks for an optional name and goes
 * straight in.
 */
export const ShareLinkPage = () => {
    const params = useParams<{ token?: string }>();
    const location = useLocation();
    const navigate = useNavigate();
    const { session, loading } = useSession();
    const [token] = useState(() => params.token ?? tokenFromHash(location.hash));
    const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
    const [joinError, setJoinError] = useState<string | null>(null);
    const [guestDiscarded, setGuestDiscarded] = useState(false);
    const redeemedRef = useRef(false);
    const createdGuestRef = useRef(false);
    const [round, setRound] = useState(0);

    // D14: /join/<token> keeps working, with the token moved out of the path.
    useEffect(() => {
        if (params.token && LINK_TOKEN.test(params.token)) {
            window.history.replaceState(window.history.state, '', `/s#${params.token}`);
        }
    }, [params.token]);

    const check = useCallback(async (linkToken: string): Promise<Phase> => {
        const answer = await requestShareSession(linkToken);
        if (answer.kind !== 'dead' || answer.state !== 'invalid') {
            return answer;
        }
        // Not a general link: an older (legacy) link may still be live.
        const peek = await peekShareLink(linkToken);
        return peek?.valid ? { kind: 'join', role: peek.role } : answer;
    }, []);

    useEffect(() => {
        if (loading || session || !token) {
            return;
        }
        let current = true;
        void check(token).then((next) => {
            if (current) {
                setPhase(next);
            }
        });
        return () => {
            current = false;
        };
    }, [loading, session, token, check, round]);

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
                    createdGuestRef.current = false;
                    try {
                        await requestAccountDeletion();
                        forgetLocalSession();
                        setGuestDiscarded(true);
                    } catch {
                        // Keep the session: it is a working, if pointless, guest.
                    }
                }
                if (!dead) {
                    redeemedRef.current = false;
                    setJoinError('Could not open this score. Check your connection and try again.');
                    return;
                }
                const answer = await requestShareSession(token);
                setPhase(answer.kind === 'dead' ? answer : { kind: 'dead', state: 'invalid', expiredAt: null });
            });
    }, [loading, session, token, navigate]);

    const retry = useCallback(() => {
        setPhase({ kind: 'checking' });
        setRound((r) => r + 1);
    }, []);
    const onViewerDead = useCallback((answer: DeadAnswer) => setPhase(answer), []);

    const registered = isRegisteredSession(session) && !guestDiscarded;

    if (!token) {
        return <DeadLink answer={{ state: 'invalid', expiredAt: null }} registered={registered} />;
    }
    if (phase.kind === 'dead') {
        return guestDiscarded ? (
            <BrandShell title="This link can't open the score">
                <div className="text-center">
                    <ErrorText>{deadLinkMessage(phase.state, phase.expiredAt)}</ErrorText>
                    {/* The deleted guest's session is still in memory; a full load drops it. */}
                    <a href="/" className={`mt-3 inline-block ${linkClassName}`}>
                        Back to home
                    </a>
                </div>
            </BrandShell>
        ) : (
            <DeadLink answer={phase} registered={registered} />
        );
    }
    if (loading || session) {
        return (
            <BrandShell title="Opening the score">
                {joinError ? (
                    <ErrorText className="text-center">{joinError}</ErrorText>
                ) : (
                    <LoadingText className="text-center">Joining…</LoadingText>
                )}
            </BrandShell>
        );
    }
    switch (phase.kind) {
        case 'checking':
            return (
                <BrandShell title="Opening the score">
                    <LoadingText className="text-center">Checking the link…</LoadingText>
                </BrandShell>
            );
        case 'busy':
            return (
                <BrandShell title="Opening the score">
                    <BusyCountdown retryAfterSec={phase.retryAfterSec} onRetry={retry} className="text-sm" />
                </BrandShell>
            );
        case 'failed':
            return (
                <BrandShell title="This link can't open the score">
                    <div className="text-center">
                        <ErrorText>{deadLinkMessage('unavailable')}</ErrorText>
                        <Button size="sm" variant="secondary" className="mt-3" onClick={retry}>
                            Try now
                        </Button>
                    </div>
                </BrandShell>
            );
        case 'viewer':
            return (
                <Suspense
                    fallback={
                        <BrandShell title="Opening the score">
                            <LoadingText className="text-center">Opening the score…</LoadingText>
                        </BrandShell>
                    }
                >
                    <LinkViewerPage token={token} first={phase} onDead={onViewerDead} />
                </Suspense>
            );
        case 'editor':
        case 'join':
            return (
                <JoinCard
                    token={token}
                    role={phase.kind === 'editor' ? 'editor' : phase.role}
                    onDead={setPhase}
                    onSignedIn={() => {
                        createdGuestRef.current = true;
                    }}
                />
            );
    }
};

/**
 * An editor link's visitor (or an older link's): an optional name, then
 * straight in as a guest. No age screen: the server accepts the link-guest
 * gate for an anonymous user only (Max, 2026-11-13).
 */
export const JoinCard = ({
    token,
    role,
    onDead,
    onSignedIn,
}: {
    token: string;
    role: ShareRole;
    onDead: (answer: DeadAnswer) => void;
    onSignedIn: () => void;
}) => {
    const [name, setName] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [captchaToken, setCaptchaToken] = useState<string | null>(null);
    const [captchaRound, setCaptchaRound] = useState(0);
    const captchaRequired = isTurnstileEnabled();

    const join = async (withName: boolean) => {
        if (submitting) {
            return;
        }
        if (captchaRequired && !captchaToken) {
            setError('Finish the “I’m human” check, then continue.');
            return;
        }
        setError(null);
        setSubmitting(true);
        // Again, right before the guest is made: the link may have died meanwhile.
        const peek = await peekShareLink(token);
        if (peek && !peek.valid) {
            const answer = await requestShareSession(token);
            onDead(answer.kind === 'dead' ? answer : { kind: 'dead', state: 'invalid', expiredAt: null });
            return;
        }
        const trimmed = withName ? name.trim() : '';
        try {
            await signInAnonymouslyWithName(trimmed || undefined, captchaToken, LINK_GUEST_GATE);
            onSignedIn();
        } catch (err) {
            setSubmitting(false);
            setError(err instanceof Error ? err.message : 'Could not join.');
            if (captchaRequired) {
                setCaptchaToken(null);
                setCaptchaRound((r) => r + 1);
            }
        }
    };

    return (
        <BrandShell title={role === 'editor' ? 'Join to edit' : 'Join to view'}>
            {submitting ? (
                <LoadingText className="text-center">Joining…</LoadingText>
            ) : (
                <>
                    <TextField
                        id="name"
                        label="Your name (optional)"
                        value={name}
                        autoFocus
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                void join(true);
                            }
                        }}
                        placeholder="e.g. Sharon"
                    />
                    <p className="mt-1 text-xs text-stone-600">
                        Shown to others on this score. Leave it blank to stay anonymous.
                    </p>
                    <TurnstileField key={captchaRound} action="share-link-join" onToken={setCaptchaToken} />
                    {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}
                    <Button onClick={() => void join(true)} className="mt-4 w-full">
                        Continue
                    </Button>
                    <Button variant="ghost" onClick={() => void join(false)} className="mt-2 w-full">
                        Continue without a name
                    </Button>
                    <AgreementNote action="joining" className="mt-3" />
                </>
            )}
        </BrandShell>
    );
};
