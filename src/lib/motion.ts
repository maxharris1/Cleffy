/**
 * Whether the user asked the system for less motion. Read at the moment of
 * moving (not cached), so flipping the setting applies to the next scroll.
 * Script-driven motion (scrollIntoView, the follow glide) has no CSS media
 * query to lean on, so it asks here and jumps instead.
 */
export const prefersReducedMotion = (): boolean =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** scrollIntoView / scrollTo behavior that honours reduced motion. */
export const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth');
