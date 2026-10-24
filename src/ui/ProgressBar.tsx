export interface ProgressBarProps {
    /** 0–100. Ignored when indeterminate. */
    value?: number;
    label: string;
    /** No known total (e.g. server-side IMSLP fetch) — animated sweep, no aria-valuenow. */
    indeterminate?: boolean;
    /**
     * The work is over: the bar fades out (150ms, opacity only, so reduced
     * motion keeps it) before its owner takes it down, rather than vanishing.
     */
    done?: boolean;
    className?: string;
}

/**
 * Progress bar (upload/download). The fill is a full-width bar slid left by
 * the remaining fraction (inline transform): a transform animates on the
 * compositor, a width would relayout the bar every frame. The track's
 * overflow-hidden and rounding clip it. Under reduced motion the fill jumps to
 * each value: a bar that slides there is decoration, the number is the point.
 * A finished bar fades out (`done`) instead of blinking away.
 */
export const ProgressBar = ({
    value = 0,
    label,
    indeterminate = false,
    done = false,
    className = '',
}: ProgressBarProps) => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    return (
        <div
            role="progressbar"
            aria-label={label}
            // An indeterminate progressbar omits aria-valuenow by spec.
            aria-valuenow={indeterminate ? undefined : clamped}
            aria-valuemin={0}
            aria-valuemax={100}
            data-done={done || undefined}
            className={`h-1.5 w-full overflow-hidden rounded-full bg-stone-200 transition-opacity duration-(--duration-exit) ease-out data-done:opacity-0${
                className ? ` ${className}` : ''
            }`}
        >
            {indeterminate ? (
                <div className="progress-indeterminate h-full w-1/3 rounded-full bg-accent" />
            ) : (
                <div
                    className="h-full w-full rounded-full bg-accent transition-transform duration-200 ease-out motion-reduce:transition-none"
                    style={{ transform: `translateX(${clamped - 100}%)` }}
                />
            )}
        </div>
    );
};
