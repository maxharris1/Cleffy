/**
 * Cloudflare Turnstile, browser side: whether it is switched on, and loading
 * its script when it is.
 *
 * `VITE_TURNSTILE_SITE_KEY` is the whole switch. Unset — which is every build
 * until Max sets it — and this module reports "off", `TurnstileField` renders
 * nothing, no token is produced, no script is fetched, and every auth call goes
 * out exactly as it did before: the branch is inert by construction rather than
 * by a flag somebody has to remember to check. The server half is the same
 * shape (`TURNSTILE_SECRET_KEY`, see supabase/functions/_shared/turnstile.ts).
 *
 * The two keys are a pair and must be switched on TOGETHER. The site key alone
 * means the browser solves a challenge nobody verifies (decorative, but
 * harmless); the secret key alone means `guest-email-start` demands a token no
 * browser can mint, and the guest upgrade stops working. GoTrue's own captcha
 * is the sharper version of the same trap — it is a project-wide setting, so
 * turning it on requires a site key in the build FIRST or sign-up, sign-in,
 * password reset and anonymous join all begin refusing at once.
 *
 * Dev and CI use Cloudflare's published test keys (always-passes
 * `1x00000000000000000000AA`, always-fails `2x00000000000000000000AB`), because
 * a real site key is bound to real hostnames and would fail every challenge on
 * localhost or a preview URL. `.env.example` carries them.
 */

/** The configured site key, or null when Turnstile is switched off for this build. */
export const turnstileSiteKey = (): string | null => {
    const key = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
    const trimmed = key?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
};

/** True when this build renders widgets and sends tokens. */
export const isTurnstileEnabled = (): boolean => turnstileSiteKey() !== null;

export interface TurnstileRenderOptions {
    sitekey: string;
    callback: (token: string) => void;
    'error-callback'?: () => void;
    'expired-callback'?: () => void;
    theme?: 'light' | 'dark' | 'auto';
    size?: 'normal' | 'flexible' | 'compact';
    action?: string;
}

/** The slice of `window.turnstile` we use. */
export interface TurnstileApi {
    render: (container: HTMLElement, options: TurnstileRenderOptions) => string | undefined;
    remove: (widgetId: string) => void;
    reset: (widgetId: string) => void;
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_ID = 'cf-turnstile-script';

type TurnstileWindow = typeof window & { turnstile?: TurnstileApi };

/** One load per page, shared by however many widgets mount. */
let pending: Promise<TurnstileApi | null> | null = null;

/**
 * The Turnstile API, loading Cloudflare's script on first use — never at
 * startup, and never at all when the site key is unset.
 *
 * Resolves null rather than rejecting when the script cannot load (offline, an
 * ad blocker, Cloudflare down). Null is a decision the caller has to make
 * anyway and it is better made explicitly: a challenge that cannot be fetched
 * must not leave a sign-up form permanently unsubmittable with no explanation,
 * so `TurnstileField` says so in words instead. The server still refuses a
 * request with no token when verification is configured, which is the half of
 * this that is load-bearing — the browser is not where the gate lives.
 */
export const loadTurnstile = (): Promise<TurnstileApi | null> => {
    if (!isTurnstileEnabled()) {
        return Promise.resolve(null);
    }
    const scope = window as TurnstileWindow;
    if (scope.turnstile) {
        return Promise.resolve(scope.turnstile);
    }
    pending ??= new Promise<TurnstileApi | null>((resolve) => {
        const settle = () => resolve((window as TurnstileWindow).turnstile ?? null);
        const existing = document.getElementById(SCRIPT_ID);
        if (existing) {
            existing.addEventListener('load', settle, { once: true });
            existing.addEventListener('error', () => resolve(null), { once: true });
            return;
        }
        const script = document.createElement('script');
        script.id = SCRIPT_ID;
        script.src = SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        script.addEventListener('load', settle, { once: true });
        script.addEventListener('error', () => resolve(null), { once: true });
        document.head.appendChild(script);
    });
    return pending;
};

/** Tests only: forget the in-flight load so each case starts from nothing. */
export const resetTurnstileLoaderForTests = (): void => {
    pending = null;
};
