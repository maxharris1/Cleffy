/**
 * Pure helpers for the inbound support-mail handler.
 *
 * NO imports, for the reason `stripeEvents.ts` and `entitlements.ts` give: Deno
 * loads this with the `.ts` extension and vitest without it, so the decisions
 * worth testing live here rather than in `resend-inbound/index.ts`, which cannot
 * be loaded under vitest at all — it imports `.ts` paths and calls `Deno.serve`
 * at module scope.
 */

/** `Name <addr@host>` or a bare address -> the address, lower-cased. */
export const bareAddress = (value: string): string => {
    const angled = value.match(/<([^>]+)>/);
    return (angled?.[1] ?? value).trim().toLowerCase();
};

/**
 * A forwarder that answers its own forwards is the classic way to melt a
 * mailbox. We send FROM an address the catch-all also receives at, so a bounce
 * or an auto-reply aimed at the From can land straight back here. Refusing to
 * forward anything claiming to come from our own forwarding address costs one
 * comparison and removes the whole class of failure.
 */
export const isOwnForward = (from: string, forwardFromValue: string): boolean =>
    bareAddress(from) === bareAddress(forwardFromValue);

/** The three inboxes, most sensitive first: that is also the order a tag is picked in. */
export type InboxTag = 'privacy' | 'legal' | 'support';

const INBOX_ORDER: readonly InboxTag[] = ['privacy', 'legal', 'support'];

/**
 * Which of our addresses a message was for, as a tag for the forwarded
 * subject: `[privacy]`, `[legal]` or `[support]`.
 *
 * One mailbox receives all three (a catch-all on the domain), so the tag is how
 * a privacy request — a deletion or access request with a statutory clock on
 * it — stands out from routine support at a glance. `received_for` is the
 * address that actually accepted the message and is read first; `to` is the
 * fallback when Resend omits it. A message to more than one inbox takes the
 * most sensitive, and anything else (billing@, a typo the catch-all caught) is
 * support.
 */
export const inboxTagFor = (receivedFor: readonly string[] = [], to: readonly string[] = []): InboxTag => {
    const localParts = new Set(
        [...receivedFor, ...to].map((address) => bareAddress(address).split('@')[0] ?? '').filter(Boolean),
    );
    return INBOX_ORDER.find((tag) => localParts.has(tag)) ?? 'support';
};

/** The forwarded subject: the tag, then the sender's subject. */
export const forwardedSubject = (tag: InboxTag, subject: string | null | undefined): string =>
    `[${tag}] ${subject?.trim() || '(no subject)'}`;
