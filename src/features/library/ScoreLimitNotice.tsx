import { LimitReachedNotice } from '@/features/billing/LimitReachedNotice';
import { NO_CLOUD_SCORES_MESSAGE, type LimitReachedError } from '@/features/billing/limitErrors';

export interface ScoreLimitNoticeProps {
    /** The shell's `limitNotice`: a refusal, or the cap the account is already at. */
    limit: LimitReachedError | null | undefined;
    /** The shell's `quotaUpgradeHint`: false for a plan with no cloud scores to upgrade. */
    upgradeHint: boolean;
    onUpgrade: () => void;
    className?: string;
    /** amber everywhere but the library, which shows the outlined panel. */
    surface?: 'amber' | 'panel';
}

const PLAIN_SURFACE = {
    amber: 'rounded-xl border border-amber-300/70 bg-amber-50/70 text-amber-900',
    panel: 'rounded-[14px] border border-panel-line text-ink',
} as const;

/**
 * Why adding a score is off, for the library and the IMSLP pages alike: the
 * plan notice with its way to the plans, or -- for an account that has no cloud
 * scores to buy -- the plain sentence, on the same surface.
 */
export const ScoreLimitNotice = ({
    limit,
    upgradeHint,
    onUpgrade,
    className = '',
    surface = 'amber',
}: ScoreLimitNoticeProps) => {
    if (!limit) {
        return null;
    }
    if (!upgradeHint) {
        return (
            <p
                role="status"
                className={`${PLAIN_SURFACE[surface]} px-4 py-3 text-sm${className ? ` ${className}` : ''}`}
            >
                {NO_CLOUD_SCORES_MESSAGE}
            </p>
        );
    }
    return <LimitReachedNotice limit={limit} onUpgrade={onUpgrade} className={className} surface={surface} />;
};
