import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';

export const BASE: string;
export const API: string;
export const SHOTS: string;
export const VIEWPORTS: Record<string, BrowserContextOptions>;
export const ACCOUNTS: Record<'teacher' | 'student', { email: string; password: string }>;
export const STUB_USER: { id: string; email: string; [field: string]: unknown };
export const STUB_ENTITLEMENTS: { tier: string; [field: string]: unknown };
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
