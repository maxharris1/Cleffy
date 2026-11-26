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
    /** Key height: sm 32px, md 40px (icon keys go square). */
    size?: SegmentedSize;
    className?: string;
}

export type SegmentedSize = 'sm' | 'md';

/** The trough is the key height plus its 3px padding, top and bottom. */
const SIZE_CLASSES: Record<SegmentedSize, { trough: string; textKey: string; iconKey: string }> = {
    sm: { trough: 'h-[38px]', textKey: 'px-[11px] text-[13px]', iconKey: 'min-w-8' },
    md: { trough: 'h-[46px]', textKey: 'px-[15px] text-sm', iconKey: 'min-w-10' },
};

/**
 * A small set of equal segments, one chosen: toggle buttons (aria-pressed) in
 * a trough, over one white key that slides to the chosen segment.
 *
 * The slide says where the choice went — from grid to list, not a second
 * highlight blinking on. It is a transform (the indicator is one segment
 * wide and moves by whole widths), 180ms on the ease-out curve, and a CSS
 * transition, so a quick second change retargets mid-way. Under reduced
 * motion it jumps.
 */
export const Segmented = <V extends string>({
    label,
    value,
    options,
    onChange,
    size = 'sm',
    className = '',
}: SegmentedProps<V>) => {
    const index = Math.max(
        0,
        options.findIndex((option) => option.value === value),
    );
    return (
        <div
            role="group"
            aria-label={label}
            className={`relative grid ${SIZE_CLASSES[size].trough} shrink-0 auto-cols-fr grid-flow-col items-center rounded-[11px] bg-trough p-[3px]${
                className ? ` ${className}` : ''
            }`}
        >
            <span
                aria-hidden="true"
                data-segmented-indicator=""
                className="absolute inset-y-[3px] left-[3px] rounded-lg bg-white shadow-[0_1px_2px_rgba(28,25,23,0.22),0_0_0_1px_rgba(28,25,23,0.05)] transition-transform duration-(--duration-ui) ease-out motion-reduce:transition-none"
                style={{
                    width: `calc((100% - 6px) / ${options.length})`,
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
                        className={`relative flex h-full items-center justify-center rounded-lg transition-colors pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2.5 ${
                            option.icon ? SIZE_CLASSES[size].iconKey : SIZE_CLASSES[size].textKey
                        } ${selected ? 'font-semibold text-ink' : 'font-medium text-ink-muted hover:text-ink'}`}
                    >
                        {option.icon ?? option.label}
                    </button>
                );
            })}
        </div>
    );
};
