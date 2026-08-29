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
