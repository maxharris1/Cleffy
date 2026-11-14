import { createClient } from '@supabase/supabase-js';

import { requireSupabaseConfig, type TypedSupabaseClient } from '@/lib/supabase';
import type { Database } from '@/types/database';

export interface LinkDoc {
    id: string;
    title: string;
    page_count: number | null;
    content_rev: number;
}

export type DeadLinkState = 'revoked' | 'expired' | 'unavailable' | 'invalid';

export type ShareSessionAnswer =
    | { kind: 'viewer'; jwt: string; exp: number; doc: LinkDoc; pdfUrl: string; linkExpiresAt: string | null }
    | { kind: 'editor'; linkExpiresAt: string | null }
    | { kind: 'dead'; state: DeadLinkState; expiredAt: string | null }
    | { kind: 'busy'; retryAfterSec: number }
    | { kind: 'failed' };

export type ViewerAnswer = Extract<ShareSessionAnswer, { kind: 'viewer' }>;
export type DeadAnswer = Extract<ShareSessionAnswer, { kind: 'dead' }>;

const DEAD_STATES: readonly DeadLinkState[] = ['revoked', 'expired', 'unavailable', 'invalid'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isLinkDoc = (value: unknown): value is LinkDoc =>
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['title'] === 'string' &&
    (value['page_count'] === null || typeof value['page_count'] === 'number') &&
    typeof value['content_rev'] === 'number';

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** share-session's reply, as the link pages act on it. */
export const parseShareSessionAnswer = (status: number, body: unknown): ShareSessionAnswer => {
    if (status === 429) {
        const retry = isRecord(body) ? Number(body['retry_after']) : NaN;
        return { kind: 'busy', retryAfterSec: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 30 };
    }
    if (status === 404) {
        return { kind: 'dead', state: 'invalid', expiredAt: null };
    }
    if (status < 200 || status >= 300 || !isRecord(body)) {
        return { kind: 'failed' };
    }
    const state = body['state'];
    if (state === 'live' && body['role'] === 'editor') {
        return { kind: 'editor', linkExpiresAt: stringOrNull(body['link_expires_at']) };
    }
    if (state === 'live' && body['role'] === 'viewer') {
        const { session_jwt: jwt, exp, doc, pdf_url: pdfUrl } = body;
        if (typeof jwt === 'string' && typeof exp === 'number' && isLinkDoc(doc) && typeof pdfUrl === 'string') {
            return { kind: 'viewer', jwt, exp, doc, pdfUrl, linkExpiresAt: stringOrNull(body['link_expires_at']) };
        }
        return { kind: 'failed' };
    }
    if (typeof state === 'string' && (DEAD_STATES as readonly string[]).includes(state)) {
        return { kind: 'dead', state: state as DeadLinkState, expiredAt: stringOrNull(body['expired_at']) };
    }
    return { kind: 'failed' };
};

/**
 * Ask share-session what a general link opens. A plain fetch with only the
 * anon key: no auth client, so nothing about the visitor is stored.
 */
export const requestShareSession = async (token: string, renewJwt?: string): Promise<ShareSessionAnswer> => {
    try {
        const { url, anonKey } = requireSupabaseConfig();
        const res = await fetch(`${url}/functions/v1/share-session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', apikey: anonKey, authorization: `Bearer ${anonKey}` },
            body: JSON.stringify(renewJwt ? { token, renew: renewJwt } : { token }),
            cache: 'no-store',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
        });
        const body: unknown = await res.json().catch(() => null);
        return parseShareSessionAnswer(res.status, body);
    } catch {
        return { kind: 'failed' };
    }
};

/**
 * The signed PDF URL share-session returns, on this app's own Supabase URL.
 * The function signs it with its SUPABASE_URL, which on the local stack is
 * the in-Docker gateway (kong:8000) a browser cannot reach; the path and its
 * token are the same either way.
 */
export const pdfUrlOnProject = (pdfUrl: string): string => {
    const { url } = requireSupabaseConfig();
    const signed = new URL(pdfUrl);
    return `${url.replace(/\/$/, '')}${signed.pathname}${signed.search}`;
};

export const RENEW_FRACTION = 0.8;
export const RENEW_ON_VISIBLE_UNDER_SEC = 120;
const FAILED_RENEW_RETRY_MS = 15_000;

/** When to renew a token expiring at `exp`: at 80% of the life it has left. */
export const renewDelayMs = (exp: number, nowSec: number): number =>
    Math.max(0, Math.floor((exp - nowSec) * RENEW_FRACTION * 1000));

export interface LinkSessionEvents {
    onRenewed(jwt: string): void;
    onDead(answer: DeadAnswer): void;
    onBusy(retryAfterSec: number): void;
}

/**
 * A signed-out viewer's hold on a view link. Everything lives in this object:
 * the token, its expiry and a Supabase client that reads the token from here
 * and stores no session.
 */
export class LinkSession {
    readonly client: TypedSupabaseClient;
    private jwt: string | null;
    private exp: number;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private renewing = false;
    private disposed = false;
    private readonly onVisibility = () => {
        if (document.visibilityState === 'visible' && this.exp - nowSec() < RENEW_ON_VISIBLE_UNDER_SEC) {
            void this.renew();
        }
    };

    constructor(
        private readonly token: string,
        first: ViewerAnswer,
        private readonly on: LinkSessionEvents,
        makeClient: (accessToken: () => Promise<string>) => TypedSupabaseClient = createLinkClient,
    ) {
        this.jwt = first.jwt;
        this.exp = first.exp;
        this.client = makeClient(async () => this.jwt ?? '');
    }

    get accessToken(): string | null {
        return this.jwt;
    }

    start(): void {
        document.addEventListener('visibilitychange', this.onVisibility);
        this.schedule(renewDelayMs(this.exp, nowSec()));
    }

    dispose(): void {
        this.disposed = true;
        this.clearTimer();
        document.removeEventListener('visibilitychange', this.onVisibility);
        this.jwt = null;
    }

    async renew(): Promise<void> {
        if (this.disposed || this.renewing || !this.jwt) {
            return;
        }
        this.renewing = true;
        this.clearTimer();
        const answer = await requestShareSession(this.token, this.jwt);
        this.renewing = false;
        if (this.disposed) {
            return;
        }
        switch (answer.kind) {
            case 'viewer':
                this.jwt = answer.jwt;
                this.exp = answer.exp;
                this.on.onRenewed(answer.jwt);
                this.schedule(renewDelayMs(answer.exp, nowSec()));
                return;
            case 'dead':
                this.on.onDead(answer);
                return;
            case 'editor':
                this.on.onDead({ kind: 'dead', state: 'unavailable', expiredAt: null });
                return;
            case 'busy':
                this.on.onBusy(answer.retryAfterSec);
                this.schedule(answer.retryAfterSec * 1000);
                return;
            case 'failed':
                this.schedule(FAILED_RENEW_RETRY_MS);
                return;
        }
    }

    private schedule(ms: number): void {
        this.clearTimer();
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.renew();
        }, ms);
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** The link-only client: the viewer token from memory, no stored session, no refresh. */
export const createLinkClient = (accessToken: () => Promise<string>): TypedSupabaseClient => {
    const { url, anonKey } = requireSupabaseConfig();
    return createClient<Database>(url, anonKey, {
        accessToken,
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 40 } },
    });
};
