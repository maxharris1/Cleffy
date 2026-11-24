export type Status = 'OK' | 'FAIL' | 'INFO';
export interface Line {
    status: Status;
    check: string;
    detail: string;
}
export interface Hop {
    url: string;
    status: number;
    body: string;
}
export interface Visit {
    hops: Hop[];
    error: string | null;
}
export interface Limits {
    timeoutMs: number;
    maxRedirects: number;
    maxJsFiles: number;
}
export type Requirement = 'captcha' | 'sentry';
export interface Scan {
    scanned: number;
    capped: boolean;
    keyLength: number | null;
    ingestHost: string | null;
}
export const PAGES: string[];
export const UTM: Record<'utm_source' | 'utm_medium' | 'utm_campaign', string>;
export const LIMITS: Limits;
export function makeVisit(fetchImpl: typeof fetch, limits: Limits): (url: string) => Promise<Visit>;
export function checkPages(visitsByPath: Array<[string, Visit]>): Line;
export function checkUtmRedirect(requestUrl: string, visit: Visit): Line;
export function checkCanonical(visit: Visit): Line;
export function scanBundle(page: Hop, visit: (url: string) => Promise<Visit>, limits: Limits): Promise<Scan>;
export function checkCaptcha(scan: Scan | null, required: boolean): Line;
export function checkSentry(scan: Scan | null, required: boolean): Line;
export function runPreflight(options: {
    baseUrl: string;
    require?: Requirement[];
    fetchImpl?: typeof fetch;
    limits?: Limits;
}): Promise<{ lines: Line[]; exitCode: 0 | 1 }>;
export function parseArgs(argv: string[]): { baseUrl: string; require: Requirement[] };
