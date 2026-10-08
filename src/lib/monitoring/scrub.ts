/**
 * PII scrubbing for error reports, applied to every event before it leaves the
 * browser (Sentry's `beforeSend` / `beforeBreadcrumb`).
 *
 * Error monitoring is only worth having if turning it on cannot leak what our
 * customers trust us with. The two things that must never reach a third party
 * are named in the privacy policy: the contents of a score's markings, and who
 * our users are beyond an opaque account id. Both arrive in error events by
 * accident rather than design — an exception message that interpolates an
 * email, a breadcrumb URL carrying a signed-storage token, a console line that
 * logged an annotation payload — so the rules here are blunt on purpose:
 *
 *  * Keys that name content or credentials are dropped wholesale, not
 *    redacted, wherever they appear (payload, text, body, headers, cookies…).
 *  * Every surviving string has emails and bearer/JWT tokens replaced, and
 *    every URL loses its query string and fragment — signed storage URLs,
 *    PostgREST filters and the auth callback's `#access_token=` all live there.
 *  * Console breadcrumbs are dropped entirely: they carry arbitrary arguments,
 *    and the app logs malformed realtime payloads (annotation bodies) there.
 *  * The user is reduced to their account id.
 *
 * No imports, and plain structural types rather than Sentry's, so this file is
 * cheap to unit-test and adds nothing to the bundle when monitoring is off.
 */

export type Scrubbable = Record<string, unknown>;

/** Keys whose VALUE is content or a credential — dropped, never inspected. */
const DROPPED_KEY =
    /^(payload|annotations?|strokes?|points|text|text_?body|html_?body|body|password|passwd|e-?mail|emails?|parent_?email|student_?email|authorization|cookies?|headers?|access_?token|refresh_?token|token|apikey|api_?key|secret|query_?string|display_?name)$/i;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** JWTs (Supabase access tokens) and anything presented as a bearer credential. */
const JWT = /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g;
const BEARER = /\b(Bearer)\s+[^\s"',]+/gi;
/** Any absolute URL with a query string or fragment: keep origin + path only. */
const URL_TAIL = /(\b(?:https?|wss?):\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi;
/**
 * A share link's token is the credential itself (routes.tsx: /join/:token), and
 * it sits in the PATH, so stripping query strings alone would still ship it.
 */
const JOIN_TOKEN = /(\/join\/)[^\s/?#"'<>]+/gi;

const MAX_DEPTH = 8;

/** Redact emails, tokens and URL query strings/fragments from one string. */
export const redactString = (value: string): string =>
    value
        .replace(URL_TAIL, '$1?[redacted]')
        .replace(JOIN_TOKEN, '$1[token]')
        .replace(JWT, '[token]')
        .replace(BEARER, '$1 [token]')
        .replace(EMAIL, '[email]');

/**
 * Deep copy with sensitive keys dropped and every string redacted. Arrays and
 * plain objects are walked; anything deeper than MAX_DEPTH is cut rather than
 * trusted, which also makes a cyclic structure terminate.
 */
export const scrubValue = (value: unknown, depth = 0): unknown => {
    if (typeof value === 'string') {
        return redactString(value);
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (depth >= MAX_DEPTH) {
        return '[truncated]';
    }
    if (Array.isArray(value)) {
        return value.map((entry) => scrubValue(entry, depth + 1));
    }
    const out: Scrubbable = {};
    for (const [key, entry] of Object.entries(value as Scrubbable)) {
        if (DROPPED_KEY.test(key)) {
            continue;
        }
        out[key] = scrubValue(entry, depth + 1);
    }
    return out;
};

/** Breadcrumb `data` fields worth keeping — the rest is dropped, not scrubbed. */
const BREADCRUMB_DATA_KEYS = ['url', 'method', 'status_code', 'from', 'to', 'reason'] as const;

/** The breadcrumb fields that hold a location, absolute or app-relative. */
const LOCATION_KEYS: ReadonlySet<string> = new Set(['url', 'from', 'to']);

/**
 * A navigation breadcrumb's from/to are app-relative ("/auth/callback?code=…",
 * "/login?next=/join/…"), which URL_TAIL — absolute URLs only — never sees. A
 * location keeps its path and loses everything after `?` or `#` outright.
 */
export const redactLocation = (value: string): string => {
    const cut = value.search(/[?#]/);
    const path = cut === -1 ? value : value.slice(0, cut);
    return redactString(path);
};

/**
 * One breadcrumb, or null to drop it. Console breadcrumbs always go: their
 * arguments are whatever a `console.*` call happened to pass, including
 * annotation payloads from the realtime parser's warnings.
 */
export const scrubBreadcrumb = <T extends Scrubbable>(crumb: T): T | null => {
    if (crumb['category'] === 'console') {
        return null;
    }
    const next: Scrubbable = { ...crumb };
    if (typeof next['message'] === 'string') {
        next['message'] = redactString(next['message']);
    }
    const data = crumb['data'];
    if (data && typeof data === 'object') {
        const kept: Scrubbable = {};
        for (const key of BREADCRUMB_DATA_KEYS) {
            const entry = (data as Scrubbable)[key];
            if (entry === undefined) {
                continue;
            }
            kept[key] = typeof entry === 'string' && LOCATION_KEYS.has(key) ? redactLocation(entry) : scrubValue(entry);
        }
        next['data'] = kept;
    }
    return next as T;
};

/**
 * The whole event. Exceptions keep their type, stack and (redacted) message —
 * the parts that make a report useful — and lose everything else that could
 * carry content: request bodies, headers, cookies, extra context keys that
 * name content, and any user field but the id.
 */
export const scrubEvent = <T extends Scrubbable>(event: T): T => {
    const next = scrubValue(event) as Scrubbable;

    const user = event['user'];
    const userId = user && typeof user === 'object' ? (user as Scrubbable)['id'] : undefined;
    if (typeof userId === 'string' || typeof userId === 'number') {
        next['user'] = { id: String(userId) };
    } else {
        delete next['user'];
    }

    // scrubValue already dropped headers/cookies/body/query_string by key; the
    // request object is otherwise reduced to its redacted URL and method.
    const request = next['request'];
    if (request && typeof request === 'object') {
        const { url, method } = request as Scrubbable;
        next['request'] = { ...(url !== undefined ? { url } : {}), ...(method !== undefined ? { method } : {}) };
    }

    // Breadcrumbs went through scrubValue too, but the console rule needs the
    // category, so they are re-derived from the originals.
    const crumbs = event['breadcrumbs'];
    if (Array.isArray(crumbs)) {
        next['breadcrumbs'] = crumbs
            .map((crumb) => (crumb && typeof crumb === 'object' ? scrubBreadcrumb(crumb as Scrubbable) : null))
            .filter((crumb): crumb is Scrubbable => crumb !== null);
    }

    return next as T;
};

/**
 * Which deployment this page is, from its hostname. The same bundle serves
 * cleffy.io and dev.cleffy.io (see lib/supabase.ts), so the build cannot know;
 * the host can.
 */
export const environmentForHost = (hostname: string): string => {
    const host = hostname.toLowerCase();
    if (host === 'cleffy.io' || host === 'www.cleffy.io') {
        return 'production';
    }
    if (host === 'dev.cleffy.io') {
        return 'development';
    }
    if (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '[::1]' ||
        host.endsWith('.local') ||
        /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host)
    ) {
        return 'local';
    }
    return 'preview';
};
