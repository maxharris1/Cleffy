import { useEffect, useRef, useState } from 'react';

import { loadTurnstile, turnstileSiteKey } from '@/features/auth/turnstile';
import { ErrorText } from '@/ui/ErrorText';

export interface TurnstileFieldProps {
    /**
     * Called with a fresh token, and with null whenever the one we had stops
     * being usable — it expired, or the challenge errored. The holder of the
     * token must treat null as "there is nothing to send".
     */
    onToken: (token: string | null) => void;
    /**
     * Called when there is something on screen for the user to do: Cloudflare
     * put up a challenge, the challenge errored, or the script never loaded.
     */
    onNeedsUser?: () => void;
    /** What the token is for, so Cloudflare's analytics separate the surfaces. */
    action: string;
    className?: string;
}

/**
 * The "I'm human" check, as a form field.
 *
 * Interaction-only: most visitors never see it, and it takes up no space until
 * Cloudflare decides to show a challenge. `useTurnstileToken` holds the token
 * it hands up and lets a submit wait for it.
 *
 * Renders NOTHING when `VITE_TURNSTILE_SITE_KEY` is unset, which is every build
 * until Max sets it — see `turnstile.ts` for why the switch is the key's
 * presence rather than a flag. So every form that mounts this keeps its current
 * layout and behaviour exactly, and every existing test of those forms stays
 * valid.
 *
 * Turnstile tokens are SINGLE USE and short-lived (a few minutes), which is
 * what shapes the lifecycle here: the widget is mounted alongside the form
 * rather than solved up front, `expired-callback` withdraws the token so a form
 * left open does not submit a stale one, and a caller whose submit failed
 * remounts this component (a changed React `key`) to get a new challenge
 * instead of replaying a spent token.
 *
 * A challenge that cannot load at all says so, rather than leaving a submit
 * button that silently never works. That is a message, not a gate: whether a
 * request without a token is admitted is decided on the server
 * (`_shared/turnstile.ts`), and nothing the browser does or fails to do changes
 * that.
 */
export const TurnstileField = ({ onToken, onNeedsUser, action, className = '' }: TurnstileFieldProps) => {
    const siteKey = turnstileSiteKey();
    const hostRef = useRef<HTMLDivElement | null>(null);
    const [unavailable, setUnavailable] = useState(false);
    const [shown, setShown] = useState(false);
    // The callbacks outlive each render; a ref keeps the widget from being torn
    // down and rebuilt — a fresh challenge for the user — every time the
    // parent re-renders with a new inline `onToken`. Kept current in an effect
    // rather than assigned during render, which React warns about.
    const onTokenRef = useRef(onToken);
    const onNeedsUserRef = useRef(onNeedsUser);
    useEffect(() => {
        onTokenRef.current = onToken;
        onNeedsUserRef.current = onNeedsUser;
    }, [onToken, onNeedsUser]);

    useEffect(() => {
        if (!siteKey) {
            return;
        }
        let mounted = true;
        let widgetId: string | undefined;
        let api: Awaited<ReturnType<typeof loadTurnstile>> = null;

        void loadTurnstile().then((loaded) => {
            if (!mounted || !hostRef.current) {
                return;
            }
            if (!loaded) {
                setUnavailable(true);
                onNeedsUserRef.current?.();
                return;
            }
            api = loaded;
            try {
                widgetId = loaded.render(hostRef.current, {
                    sitekey: siteKey,
                    action,
                    size: 'flexible',
                    appearance: 'interaction-only',
                    callback: (token) => onTokenRef.current(token),
                    'before-interactive-callback': () => {
                        setShown(true);
                        onNeedsUserRef.current?.();
                    },
                    // Both withdraw the token rather than keeping the last
                    // good one: a token Cloudflare has disowned is one the
                    // server will refuse, and sending it anyway turns a
                    // re-solvable "try the check again" into a puzzling
                    // failure on a form that looks complete.
                    'error-callback': () => {
                        onTokenRef.current(null);
                        setShown(true);
                        onNeedsUserRef.current?.();
                    },
                    'expired-callback': () => onTokenRef.current(null),
                });
            } catch {
                setUnavailable(true);
                onNeedsUserRef.current?.();
            }
        });

        return () => {
            mounted = false;
            if (api && widgetId !== undefined) {
                try {
                    api.remove(widgetId);
                } catch {
                    // Already gone with the container; nothing to clean up.
                }
            }
        };
    }, [siteKey, action]);

    if (!siteKey) {
        return null;
    }

    // Hidden, the widget is out of the flow: no margin, and no flex gap in the
    // forms that lay it out in a row. Cloudflare keeps its own frame invisible
    // until it has a challenge to show.
    const placement = shown || unavailable ? `mt-4 ${className}` : 'absolute';

    return (
        <div className={placement.trim()}>
            <div ref={hostRef} data-testid="turnstile-field" />
            {unavailable ? (
                <ErrorText className="mt-2">
                    The “I’m human” check couldn’t load. Check your connection, then reload this page.
                </ErrorText>
            ) : null}
        </div>
    );
};
