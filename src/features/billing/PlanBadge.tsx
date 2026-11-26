import { PLAN_LABELS } from '@/features/billing/pricing';
import type { EffectiveTier } from '@/types/database';
import { Badge } from '@/ui/Badge';

export interface PlanBadgeProps {
    tier: EffectiveTier;
    className?: string;
}

/**
 * Plan pill for the account cluster. Free is quiet; paid tiers are accented.
 *
 * 'student' is labelled defensively rather than left to render `undefined`: a
 * provisioned student never sees this chrome, and if one ever did, the honest
 * answer is what they are, not a plan they cannot buy.
 */
export const PlanBadge = ({ tier, className = '' }: PlanBadgeProps) => (
    <Badge tone={tier === 'free' || tier === 'student' ? 'neutral' : 'accent'} className={className}>
        {PLAN_LABELS[tier]}
    </Badge>
);
