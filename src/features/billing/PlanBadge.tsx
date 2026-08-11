import { TIER_LABELS } from '@/features/billing/pricing';
import type { BillingTier } from '@/types/database';
import { Badge } from '@/ui/Badge';

export interface PlanBadgeProps {
    tier: BillingTier;
    className?: string;
}

/** Plan pill for the account cluster. Free is quiet; paid tiers are accented. */
export const PlanBadge = ({ tier, className = '' }: PlanBadgeProps) => (
    <Badge tone={tier === 'free' ? 'neutral' : 'accent'} className={className}>
        {TIER_LABELS[tier]}
    </Badge>
);
