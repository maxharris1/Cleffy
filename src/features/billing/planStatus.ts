import type { Entitlements } from '@/types/database';

/**
 * What the current period's end date means for this plan: a renewal, or the
 * last day of it. Read from get_entitlements(), which carries Stripe's
 * cancel_at_period_end since 20261009120101 -- an older server, or entitlements
 * cached from one, lack the flag and read as renewing, as they always did.
 */
export type PlanPeriod =
    | { kind: 'renews'; endsAt: string }
    /** Cancelled at period end: the plan stops on `endsAt` unless resumed. */
    | { kind: 'ends'; endsAt: string; viaAcademy: boolean };

export const planPeriodOf = (entitlements: Entitlements | null | undefined): PlanPeriod | null => {
    if (!entitlements || !entitlements.current_period_end) {
        return null;
    }
    if (entitlements.tier === 'free' || entitlements.tier === 'student') {
        return null;
    }
    if (entitlements.cancel_at_period_end === true) {
        return {
            kind: 'ends',
            endsAt: entitlements.current_period_end,
            viaAcademy: entitlements.source === 'studio_member',
        };
    }
    return { kind: 'renews', endsAt: entitlements.current_period_end };
};

/**
 * The subscription this account pays for itself, if any -- the one the billing
 * portal manages. An Academy seat is the owner's subscription, not theirs.
 */
export interface OwnSubscription {
    /** current_period_end, when the server knows it. */
    endsAt: string | null;
    /** Cancelled at period end; resuming it is done in the billing portal. */
    cancelling: boolean;
}

export const ownSubscriptionOf = (entitlements: Entitlements | null | undefined): OwnSubscription | null => {
    if (!entitlements || entitlements.source !== 'subscription') {
        return null;
    }
    if (entitlements.tier === 'free' || entitlements.tier === 'student') {
        return null;
    }
    return { endsAt: entitlements.current_period_end, cancelling: entitlements.cancel_at_period_end === true };
};

/** A period end as the date the teacher reads; local time, the browser's format. */
export const formatPlanDate = (iso: string): string => new Date(iso).toLocaleDateString();
