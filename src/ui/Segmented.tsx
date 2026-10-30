import type { ReactNode } from 'react';

export interface SegmentedOption<V extends string> {
    value: V;
    /** Accessible name, and the tooltip when the segment shows an icon. */
    label: string;
    /** Shown instead of the label's text. */
    icon?: ReactNode;
}

export interface SegmentedProps<V extends string> {
    /** Names the group. */
    label: string;
    value: V;
    options: readonly SegmentedOption<V>[];
    onChange: (value: V) => void;
    className?: string;
}

/**
 * A small set of equal segments, one chosen: toggle buttons (aria-pressed) in
 * a group, over one indicator that slides to the chosen segment.
 *
 * The slide says where the choice went — from grid to list, not a second
 * highlight blinking on. It is a transform (the indicator is one segment
 * wide and moves by whole widths), 180ms on the ease-out curve, and a CSS
 * transition, so a quick second change retargets mid-way. Under reduced
 * motion it jumps.
 */
export const Segmented = <V extends string>({ label, value, options, onChange, className = '' }: SegmentedProps<V>) => {
    const index = Math.max(
        0,
        options.findIndex((option) => option.value === value),
    );
    return (
        <div
            role="group"
            aria-label={label}
            className={`relative grid h-8 shrink-0 auto-cols-fr grid-flow-col items-center rounded-lg border border-stone-200 p-0.5${
                className ? ` ${className}` : ''
            }`}
        >
            <span
                aria-hidden="true"
                data-segmented-indicator=""
                className="absolute inset-y-0.5 left-0.5 rounded-md bg-accent-soft transition-transform duration-(--duration-ui) ease-out motion-reduce:transition-none"
                style={{
                    width: `calc((100% - 0.25rem) / ${options.length})`,
                    transform: `translateX(${index * 100}%)`,
                }}
            />
            {options.map((option) => {
                const selected = option.value === value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={selected}
                        aria-label={option.icon ? option.label : undefined}
                        title={option.icon ? option.label : undefined}
                        onClick={() => onChange(option.value)}
                        className={`relative flex h-full items-center justify-center rounded-md px-2 transition-colors pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2.5 ${
                            selected ? 'text-accent' : 'text-stone-500 hover:text-stone-800'
                        }`}
                    >
                        {option.icon ?? option.label}
                    </button>
                );
            })}
        </div>
    );
};
