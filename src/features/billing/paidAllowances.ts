/**
 * The monthly AI page reads every paid tier carries — a fair-use ceiling, not
 * unlimited (tier_limits() in SQL; drift-guarded by
 * tests/billing/limitsInSync.test.ts). The pricing cards and the upgrade
 * prompt both quote it, so neither can promise more than the server allows.
 *
 * Its own dependency-free module so the marketing bundle that renders the
 * pricing cards does not pull in the Supabase client to read one number.
 */
export const PAID_VISION_READS = 500;
