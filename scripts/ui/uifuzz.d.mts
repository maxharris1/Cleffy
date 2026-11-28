import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';

export const BASE: string;
export const API: string;
export const SHOTS: string;
export interface ViewportOptions {
    viewport: { width: number; height: number };
    isMobile?: boolean;
    hasTouch?: boolean;
    deviceScaleFactor?: number;
}
export type ViewportName =
    | 'desktop-1440'
    | 'laptop-1280'
    | 'ipad-landscape'
    | 'ipad-portrait'
    | 'ipad-mini-portrait'
    | 'iphone-14'
    | 'iphone-se'
    | 'android-small'
    | 'iphone-landscape';
export interface DesktopViewport {
    viewport: { width: number; height: number };
}
export interface TouchViewport extends DesktopViewport {
    isMobile: boolean;
    hasTouch: boolean;
    deviceScaleFactor: number;
}
export const VIEWPORTS: Record<'desktop-1440' | 'laptop-1280', DesktopViewport> &
    Record<
        | 'ipad-landscape'
        | 'ipad-portrait'
        | 'ipad-mini-portrait'
        | 'iphone-14'
        | 'iphone-se'
        | 'android-small'
        | 'iphone-landscape',
        TouchViewport
    >;
export const ACCOUNTS: Record<'teacher' | 'student', { email: string; password: string }>;
export const STUB_USER: {
    id: string;
    aud: string;
    role: string;
    email: string;
    created_at: string;
    app_metadata: { provider: string };
    user_metadata: { display_name: string };
};
export const STUB_ENTITLEMENTS: {
    tier: string;
    status: string;
    source: string;
    current_period_end: string;
    cancel_at_period_end: boolean;
    limits: {
        cloud_scores: number;
        omr_runs: number;
        vision_reads: number;
        smart_imports: number;
        pdf_exports: number;
        students: number;
    };
};
export interface StubReply {
    status: number;
    body: unknown;
}
export function reply(status: number, body: unknown): StubReply;
export type StubHandler = unknown;
export function stubApi(page: unknown, handlers?: Record<string, StubHandler>): Promise<void>;
export function open(
    viewportName: string,
    opts?: BrowserContextOptions,
): Promise<{ browser: Browser; context: BrowserContext; page: Page; consoleErrors: string[] }>;
export function close(): Promise<void>;
export function login(page: Page, role?: 'teacher' | 'student'): Promise<void>;
export function shot(page: Page, name: string): Promise<string>;
export interface AuditFinding {
    kind: string;
    [field: string]: unknown;
}
export function audit(page: Page): Promise<AuditFinding[]>;
