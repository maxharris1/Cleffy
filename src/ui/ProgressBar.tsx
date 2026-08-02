export interface ProgressBarProps {
    /** 0–100. */
    value: number;
    label: string;
    className?: string;
}

/** Determinate progress bar (upload/download). Width is dynamic, so it's inline style. */
export const ProgressBar = ({ value, label, className = '' }: ProgressBarProps) => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    return (
        <div
            role="progressbar"
            aria-label={label}
            aria-valuenow={clamped}
            aria-valuemin={0}
            aria-valuemax={100}
            className={`h-1.5 w-full overflow-hidden rounded-full bg-stone-200${className ? ` ${className}` : ''}`}
        >
            <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${clamped}%` }}
            />
        </div>
    );
};
