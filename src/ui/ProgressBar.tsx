export interface ProgressBarProps {
    /** 0–100. Ignored when indeterminate. */
    value?: number;
    label: string;
    /** No known total (e.g. server-side IMSLP fetch) — animated sweep, no aria-valuenow. */
    indeterminate?: boolean;
    className?: string;
}

/** Progress bar (upload/download). Determinate width is dynamic, so it's inline style. */
export const ProgressBar = ({ value = 0, label, indeterminate = false, className = '' }: ProgressBarProps) => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    return (
        <div
            role="progressbar"
            aria-label={label}
            // An indeterminate progressbar omits aria-valuenow by spec.
            aria-valuenow={indeterminate ? undefined : clamped}
            aria-valuemin={0}
            aria-valuemax={100}
            className={`h-1.5 w-full overflow-hidden rounded-full bg-stone-200${className ? ` ${className}` : ''}`}
        >
            {indeterminate ? (
                <div className="progress-indeterminate h-full w-1/3 rounded-full bg-accent" />
            ) : (
                <div
                    className="h-full rounded-full bg-accent transition-[width] duration-200"
                    style={{ width: `${clamped}%` }}
                />
            )}
        </div>
    );
};
