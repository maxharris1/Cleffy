import { limitAction, limitHeadline, type LimitReachedError } from '@/features/billing/limitErrors';
import { Button } from '@/ui/Button';

export interface LimitReachedNoticeProps {
    limit: LimitReachedError;
    /** Opens the pricing dialog. Omitted when there is nothing to upgrade to. */
    onUpgrade?: () => void;
    className?: string;
}

/**
 * The limit-reached state for the metered features and the cloud-score cap.
 *
 * Amber rather than red, and role="status" rather than an alert: running out of
 * a free allowance is not an error the teacher made. It follows the same inline
 * treatment as the library's offline notice — the app has no toast system.
 */
export const LimitReachedNotice = ({ limit, onUpgrade, className = '' }: LimitReachedNoticeProps) => {
    const isFairUse = limit.code === 'fair_use_cap';

    return (
        <div
            role="status"
            className={`rounded-xl border border-amber-300/70 bg-amber-50/70 px-4 py-3${className ? ` ${className}` : ''}`}
        >
            <p className="text-sm font-medium text-amber-900">{limitHeadline(limit)}</p>
            <p className="mt-0.5 text-sm text-amber-800">{limitAction(limit)}</p>
            {onUpgrade && !isFairUse ? (
                <Button size="sm" className="mt-3" onClick={onUpgrade}>
                    See plans
                </Button>
            ) : null}
        </div>
    );
};
