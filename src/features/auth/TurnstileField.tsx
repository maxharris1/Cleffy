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
    /** What the token is for, so Cloudflare's analytics separate the surfaces. */
    action: string;
    className?: string;
}

/**
 * The "I'm human" check, as a form field.
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
export const TurnstileField = ({ onToken, action, className = '' }: TurnstileFieldProps) => {
    const siteKey = turnstileSiteKey();
    const hostRef = useRef<HTMLDivElement | null>(null);
    const [unavailable, setUnavailable] = useState(false);
    // The callbacks outlive each render; a ref keeps the widget from being torn
    // down and rebuilt — a fresh challenge for the user — every time the
    // parent re-renders with a new inline `onToken`. Kept current in an effect
    // rather than assigned during render, which React warns about.
    const onTokenRef = useRef(onToken);
    useEffect(() => {
        onTokenRef.current = onToken;
    }, [onToken]);

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
                return;
            }
            api = loaded;
            try {
                widgetId = loaded.render(hostRef.current, {
                    sitekey: siteKey,
                    action,
                    size: 'flexible',
                    callback: (token) => onTokenRef.current(token),
                    // Both withdraw the token rather than keeping the last
                    // good one: a token Cloudflare has disowned is one the
                    // server will refuse, and sending it anyway turns a
                    // re-solvable "try the check again" into a puzzling
                    // failure on a form that looks complete.
                    'error-callback': () => onTokenRef.current(null),
                    'expired-callback': () => onTokenRef.current(null),
                });
            } catch {
                setUnavailable(true);
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

    return (
        <div className={className ? `mt-4 ${className}` : 'mt-4'}>
            <div ref={hostRef} data-testid="turnstile-field" />
            {unavailable ? (
                <ErrorText className="mt-2">
                    The “I’m human” check couldn’t load. Check your connection, then reload this page.
                </ErrorText>
            ) : null}
        </div>
    );
};
