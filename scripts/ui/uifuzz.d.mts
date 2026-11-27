export const API: string;
export const STUB_ENTITLEMENTS: { tier: string; [field: string]: unknown };
export interface StubReply {
    status: number;
    body: unknown;
}
export function reply(status: number, body: unknown): StubReply;
export type StubHandler = unknown;
export function stubApi(page: unknown, handlers?: Record<string, StubHandler>): Promise<void>;
