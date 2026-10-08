/**
 * Structured error logging for Edge Functions, with optional forwarding to
 * Sentry.
 *
 * Supabase already keeps every console line a function writes, so the baseline
 * is one JSON object per failure on console.error: searchable by `fn` and
 * `code` in the logs explorer, instead of free text that differs per call site.
 * When the SENTRY_DSN secret is set, the same record is also posted to Sentry's
 * envelope endpoint with a plain fetch — no SDK, because the Deno SDK is a
 * large dependency to add to every cold start for one POST.
 *
 * NO imports, and env / fetch / console arrive injected, for the same reason as
 * stripeMode.ts: vitest loads this exact file. `_shared/errorReporting.ts` is
 * the Deno adapter that binds the real globals.
 *
 * What goes out is scrubbed the same way the browser's reports are
 * (src/lib/monitoring/scrub.ts): emails and tokens redacted from every string,
 * URL query strings dropped, and context keys that name content or credentials
 * removed. A failure while logging is swallowed — reporting an error must never
 * become the error.
 */

export type EnvLookup = (name: string) => string | undefined;

export interface ErrorContext {
    /** A stable, machine-readable label for the failure (`stripe_cancel_failed`). */
    code?: string;
    /** Extra fields: ids and counts, never content. Scrubbed regardless. */
    [key: string]: unknown;
}

export interface ErrorRecord {
    level: 'error';
    fn: string;
    code: string | null;
    errorName: string;
    message: string;
    stack: string | null;
    context: Record<string, unknown>;
    at: string;
}

const DROPPED_KEY =
    /^(payload|annotations?|strokes?|points|text|text_?body|html_?body|body|password|e-?mail|emails?|parent_?email|student_?email|authorization|cookies?|headers?|access_?token|refresh_?token|token|apikey|api_?key|secret|display_?name)$/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g;
const BEARER = /\b(Bearer)\s+[^\s"',]+/gi;
/** Stripe and Supabase secret key shapes, in case one is ever interpolated into a message. */
const SECRET_KEY = /\b(sk|rk|whsec|sb_secret)_[A-Za-z0-9_]{6,}/g;
const URL_TAIL = /(\bhttps?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi;

export const redact = (value: string): string =>
    value
        .replace(URL_TAIL, '$1?[redacted]')
        .replace(JWT, '[token]')
        .replace(BEARER, '$1 [token]')
        .replace(SECRET_KEY, '[secret]')
        .replace(EMAIL, '[email]');

const scrub = (value: unknown, depth = 0): unknown => {
    if (typeof value === 'string') {
        return redact(value);
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (depth >= 6) {
        return '[truncated]';
    }
    if (Array.isArray(value)) {
        return value.map((entry) => scrub(entry, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (!DROPPED_KEY.test(key)) {
            out[key] = scrub(entry, depth + 1);
        }
    }
    return out;
};

/** JSON where possible; a cyclic or BigInt-bearing value must not throw here. */
const stringify = (value: unknown): string => {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
};

const describeError = (err: unknown): { name: string; message: string; stack: string | null } => {
    if (err instanceof Error) {
        return { name: err.name, message: err.message, stack: err.stack ?? null };
    }
    if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
        // supabase-js and Stripe both reject with plain objects carrying a message.
        const code = 'code' in err && typeof err.code === 'string' ? err.code : 'Error';
        return { name: code, message: err.message, stack: null };
    }
    return { name: 'NonError', message: typeof err === 'string' ? err : stringify(err), stack: null };
};

export const buildErrorRecord = (
    fn: string,
    err: unknown,
    context: ErrorContext = {},
    now = new Date(),
): ErrorRecord => {
    const { code, ...rest } = context;
    const described = describeError(err);
    return {
        level: 'error',
        fn,
        code: typeof code === 'string' ? code : null,
        errorName: described.name,
        message: redact(described.message),
        stack: described.stack ? redact(described.stack) : null,
        context: scrub(rest) as Record<string, unknown>,
        at: now.toISOString(),
    };
};

export interface SentryTarget {
    dsn: string;
    envelopeUrl: string;
    publicKey: string;
}

/**
 * `https://<key>@<host>[/<path>]/<projectId>` → the envelope endpoint. Anything
 * else is null: a malformed secret turns forwarding off rather than throwing.
 */
export const parseSentryDsn = (dsn: string | undefined): SentryTarget | null => {
    const trimmed = dsn?.trim();
    if (!trimmed) {
        return null;
    }
    try {
        const url = new URL(trimmed);
        const segments = url.pathname.split('/').filter(Boolean);
        const projectId = segments.pop();
        if (!url.username || !projectId || !/^\d+$/.test(projectId) || !/^https?:$/.test(url.protocol)) {
            return null;
        }
        const prefix = segments.length > 0 ? `/${segments.join('/')}` : '';
        return {
            dsn: trimmed,
            publicKey: url.username,
            envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
        };
    } catch {
        return null;
    }
};

/** Which Supabase project this is, by ref, so dev noise never lands in production's view. */
const PROJECT_ENVIRONMENTS: Record<string, string> = {
    jibgwgosihadbjgxdsfe: 'production',
    qdbnlrgylelelvwbkvnm: 'development',
};

export const edgeEnvironment = (env: EnvLookup): string => {
    const explicit = env('SENTRY_ENVIRONMENT')?.trim();
    if (explicit) {
        return explicit;
    }
    const url = env('SUPABASE_URL') ?? '';
    const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url)?.[1]?.toLowerCase();
    return (ref && PROJECT_ENVIRONMENTS[ref]) || 'local';
};

const hex32 = (): string => {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** A Sentry envelope: header line, item header line, event payload line. */
export const sentryEnvelope = (
    record: ErrorRecord,
    target: SentryTarget,
    environment: string,
    release: string | undefined,
    eventId: string = hex32(),
): string => {
    const event = {
        event_id: eventId,
        timestamp: Date.parse(record.at) / 1000,
        platform: 'javascript',
        level: 'error',
        logger: 'edge-function',
        environment,
        ...(release ? { release } : {}),
        server_name: record.fn,
        tags: { function: record.fn, ...(record.code ? { code: record.code } : {}) },
        exception: { values: [{ type: record.errorName, value: record.message }] },
        extra: { ...record.context, ...(record.stack ? { stack: record.stack } : {}) },
    };
    return [
        JSON.stringify({ event_id: eventId, sent_at: record.at, dsn: target.dsn }),
        JSON.stringify({ type: 'event' }),
        JSON.stringify(event),
    ].join('\n');
};

export interface ErrorLoggerDeps {
    env: EnvLookup;
    fetch?: typeof fetch;
    log?: (line: string) => void;
    /** How long a Sentry POST may take before it is abandoned. */
    timeoutMs?: number;
}

export type ErrorLogger = (fn: string, err: unknown, context?: ErrorContext) => Promise<void>;

/**
 * Returns a logger whose promise always resolves: the console line is written
 * synchronously, and the Sentry POST (when configured) settles or times out.
 * Callers that are about to return a response hand the promise to
 * EdgeRuntime.waitUntil rather than awaiting it — see errorReporting.ts.
 */
export const createErrorLogger = ({
    env,
    fetch: fetchImpl,
    log = (line) => console.error(line),
    timeoutMs = 2_000,
}: ErrorLoggerDeps): ErrorLogger => {
    return async (fn, err, context) => {
        let record: ErrorRecord;
        try {
            record = buildErrorRecord(fn, err, context);
            log(JSON.stringify(record));
        } catch {
            return;
        }

        const target = parseSentryDsn(env('SENTRY_DSN'));
        if (!target || !fetchImpl) {
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            await fetchImpl(target.envelopeUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-sentry-envelope',
                    'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${target.publicKey}, sentry_client=cleffy-edge/1.0`,
                },
                body: sentryEnvelope(record, target, edgeEnvironment(env), env('SENTRY_RELEASE')?.trim() || undefined),
                signal: controller.signal,
            });
        } catch {
            // Sentry unreachable: the console line above is the record.
        } finally {
            clearTimeout(timer);
        }
    };
};
