import { limitAction, limitHeadline, type LimitReachedError } from '@/features/billing/limitErrors';
import { Button } from '@/ui/Button';

export interface LimitReachedNoticeProps {
    limit: LimitReachedError;
    /** Opens the pricing dialog. Omitted when there is nothing to upgrade to. */
    onUpgrade?: () => void;
    className?: string;
    /** amber: the inline status. panel: an outlined paper panel, as the library shows it. */
    surface?: 'amber' | 'panel';
}

const SURFACE_CLASSES = {
    amber: {
        box: 'rounded-xl border border-amber-300/70 bg-amber-50/70',
        headline: 'font-medium text-amber-900',
        action: 'text-amber-800',
    },
    panel: {
        box: 'rounded-[14px] border border-panel-line',
        headline: 'font-semibold text-ink',
        action: 'text-ink-muted',
    },
} as const;

/**
 * The limit-reached state for the metered features and the cloud-score cap.
 *
 * Amber rather than red, and role="status" rather than an alert: running out of
 * a free allowance is not an error the teacher made. It follows the same inline
 * treatment as the library's offline notice — the app has no toast system.
 */
export const LimitReachedNotice = ({
    limit,
    onUpgrade,
    className = '',
    surface = 'amber',
}: LimitReachedNoticeProps) => {
    const isFairUse = limit.code === 'fair_use_cap';
    const look = SURFACE_CLASSES[surface];

    return (
        <div role="status" className={`${look.box} px-4 py-3${className ? ` ${className}` : ''}`}>
            <p className={`text-sm ${look.headline}`}>{limitHeadline(limit)}</p>
            <p className={`mt-0.5 text-sm ${look.action}`}>{limitAction(limit)}</p>
            {onUpgrade && !isFairUse ? (
                <Button size="sm" className="mt-3" onClick={onUpgrade}>
                    See plans
                </Button>
            ) : null}
        </div>
    );
};
