import { routePatternOf } from '@/app/routePatterns';

/**
 * First-touch campaign attribution: the utm_ tags of the link a visitor first
 * arrived by, kept on this device for 30 days and sent with the sign-up
 * (signUpWithPassword -> user_metadata.attribution -> the
 * record_signup_attribution trigger, 20261112120000_web_events.sql).
 *
 * Only the five utm_ tags, and only values the server also accepts. The page
 * is kept as its route pattern (`/join/:token`), never the path or the rest
 * of the query. Nothing is stored for a visit with no valid tag.
 *
 * Storage is wrapped as in demoSession.ts: Safari in private mode and
 * browsers with site data disabled throw on localStorage. Then the tags live
 * in memory for this page load only.
 */

export const ATTRIBUTION_STORAGE_KEY = 'cleffy:attribution';

export const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;

export type UtmKey = (typeof UTM_KEYS)[number];

export type UtmTags = Partial<Record<UtmKey, string>>;

/** The same rule as the database's check constraints. */
export const UTM_VALUE = /^[A-Za-z0-9._-]{1,100}$/;

const LANDING_PATH = /^(\*|\/[A-Za-z0-9/:._-]*)$/;

export type Attribution = UtmTags & {
    landing_path?: string;
    first_seen_at: string;
};

let memory: Attribution | null = null;

/** The valid utm_ tags in a query string. */
export const parseUtm = (search: string): UtmTags => {
    const params = new URLSearchParams(search);
    const tags: UtmTags = {};
    for (const key of UTM_KEYS) {
        const value = params.get(key);
        if (value !== null && UTM_VALUE.test(value)) {
            tags[key] = value;
        }
    }
    return tags;
};

/** A stored or remembered value, re-checked field by field; null when it has no valid tag or time. */
const sanitize = (raw: unknown): Attribution | null => {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const record = raw as Record<string, unknown>;
    const firstSeen = record['first_seen_at'];
    if (typeof firstSeen !== 'string' || Number.isNaN(Date.parse(firstSeen))) {
        return null;
    }
    const tags: UtmTags = {};
    for (const key of UTM_KEYS) {
        const value = record[key];
        if (typeof value === 'string' && UTM_VALUE.test(value)) {
            tags[key] = value;
        }
    }
    if (Object.keys(tags).length === 0) {
        return null;
    }
    const landing = record['landing_path'];
    return {
        ...tags,
        ...(typeof landing === 'string' && landing.length <= 200 && LANDING_PATH.test(landing)
            ? { landing_path: landing }
            : {}),
        first_seen_at: firstSeen,
    };
};

const expired = (attribution: Attribution, now: number): boolean =>
    now - Date.parse(attribution.first_seen_at) > ATTRIBUTION_TTL_MS;

const readStored = (): Attribution | null => {
    try {
        const raw = window.localStorage.getItem(ATTRIBUTION_STORAGE_KEY);
        return raw === null ? null : sanitize(JSON.parse(raw));
    } catch {
        return null;
    }
};

const removeStored = (): void => {
    try {
        window.localStorage.removeItem(ATTRIBUTION_STORAGE_KEY);
    } catch {
        // Nothing to clear in a browser that refuses storage.
    }
};

/** The first-touch tags for a sign-up or an event, or null: none, or older than 30 days. */
export const readAttribution = (now = Date.now()): Attribution | null => {
    let stored = readStored();
    if (stored && expired(stored, now)) {
        removeStored();
        stored = null;
    }
    const current = stored ?? memory;
    if (!current || expired(current, now)) {
        return null;
    }
    return current;
};

/**
 * Called once, early in main.tsx: remember this visit's tags unless an
 * unexpired first touch is already kept.
 */
export const captureAttribution = (
    location: { pathname: string; search: string } = window.location,
    now = Date.now(),
): void => {
    if (readAttribution(now)) {
        return;
    }
    const tags = parseUtm(location.search);
    if (Object.keys(tags).length === 0) {
        return;
    }
    const attribution: Attribution = {
        ...tags,
        landing_path: routePatternOf(location.pathname),
        first_seen_at: new Date(now).toISOString(),
    };
    memory = attribution;
    try {
        window.localStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(attribution));
    } catch {
        // Private mode or site data blocked: kept for this page load only.
    }
};

export const resetAttributionForTests = (): void => {
    memory = null;
};
