import type { ReactNode } from 'react';

export interface SwapLabelProps<K extends string> {
    /** Every label the control can show, by key. All of them are rendered. */
    labels: Record<K, ReactNode>;
    /** The one showing now. */
    active: K;
    /**
     * Announce a change (aria-live="polite"): a busy label's "Saving…", a
     * "Copied!". Off for a status that changes all lesson (the sync label).
     */
    live?: boolean;
    /** The incoming label also grows from 0.96 (the Copy → Copied! swap). */
    scale?: boolean;
    /** Where a shorter label sits in the widest one's width. */
    align?: 'center' | 'start';
    className?: string;
}

/**
 * A label that changes in place without changing size: "Export" to
 * "Exporting…", "Copy" to "Copied!".
 *
 * Every variant sits in one grid cell, so the control is always as wide as the
 * widest and the buttons beside it never shift. The inactive ones are
 * aria-hidden, which also keeps them out of the control's accessible name.
 * The swap is a CSS transition (index.css, .swap-label): the outgoing label
 * fades and blurs out while the incoming one fades and sharpens in, 150ms on
 * the ease-out curve, and a second swap mid-way retargets instead of
 * restarting. Under reduced motion it is the fade alone.
 */
export const SwapLabel = <K extends string>({
    labels,
    active,
    live = true,
    scale = false,
    align = 'center',
    className = '',
}: SwapLabelProps<K>) => (
    <span
        className={`swap-label${align === 'start' ? ' justify-items-start' : ' justify-items-center'}${
            className ? ` ${className}` : ''
        }`}
        aria-live={live ? 'polite' : undefined}
        data-scale={scale || undefined}
    >
        {(Object.keys(labels) as K[]).map((key) => (
            <span
                key={key}
                className="whitespace-nowrap"
                aria-hidden={key === active ? undefined : true}
                data-swap-active={key === active || undefined}
            >
                {labels[key]}
            </span>
        ))}
    </span>
);
