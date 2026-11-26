/**
 * Class-string builders for the design system. They live apart from the
 * component files so those stay fast-refresh clean, and so button-shaped
 * non-buttons (router <Link>s, file-input <label>s) can share the exact look.
 */

/** The ink* variants sit on the dark ink surfaces (top bar, viewer chrome). */
export type ButtonVariant =
    'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerGhost' | 'inkPrimary' | 'inkOutline' | 'inkGhost';
export type ButtonSize = 'md' | 'sm';

/*
 * Pressed buttons give a little (scale .97 over --duration-press): feedback
 * the hand feels before the result arrives. Disabled ones do not move.
 */
const BUTTON_BASE =
    'inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap border-[1.5px] font-semibold transition-[color,background-color,border-color,scale] duration-(--duration-press) ease-out active:scale-[0.97] disabled:cursor-default disabled:opacity-50 disabled:active:scale-100';

const BUTTON_SIZE_CLASSES: Record<ButtonSize, string> = {
    md: 'min-h-11 rounded-xl px-[18px] text-[15px]',
    sm: 'rounded-[10px] px-3.5 py-2 text-sm',
};

const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
    primary:
        'border-accent bg-accent text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_10px_20px_-12px_rgba(67,56,202,0.75)] hover:border-accent-hover hover:bg-accent-hover',
    secondary: 'border-button-line bg-transparent text-ink hover:bg-ink/5',
    ghost: 'border-transparent bg-transparent text-ink-soft hover:bg-ink/5',
    danger: 'border-danger bg-danger text-white hover:border-red-800 hover:bg-red-800',
    dangerGhost: 'border-transparent bg-transparent text-danger hover:bg-red-50',
    inkPrimary:
        'border-ink-cta bg-ink-cta text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_10px_22px_-12px_rgba(79,70,229,0.95)]',
    inkOutline: 'border-paper/42 bg-transparent text-paper hover:bg-paper/10',
    inkGhost: 'border-transparent bg-transparent text-on-ink-muted hover:bg-paper/10',
};

export const buttonClassName = (variant: ButtonVariant, size: ButtonSize = 'md', extra = ''): string =>
    `${BUTTON_BASE} ${BUTTON_SIZE_CLASSES[size]} ${BUTTON_VARIANT_CLASSES[variant]}${extra ? ` ${extra}` : ''}`;

/**
 * md: forms. sm: compact rows. xs: the 32px filter-row selects. inline: a
 * number set into a control row (the tempo); the caller gives it a width.
 */
export type FieldSize = 'md' | 'sm' | 'xs' | 'inline';

/*
 * Text is 16px wherever the pointer is coarse: iOS zooms the whole page into
 * any field set smaller, and leaves it zoomed. The compact sizes come back
 * only under a fine pointer.
 */
const FIELD_SIZE_CLASSES: Record<FieldSize, string> = {
    md: 'min-h-12 rounded-xl px-3.5 py-2.5 text-base',
    sm: 'rounded-lg px-3 py-2 text-base pointer-fine:text-sm',
    xs: 'rounded-lg px-3 py-0 text-base pointer-fine:text-xs',
    inline: 'rounded-md px-1 py-0.5 text-center text-base tabular-nums pointer-fine:text-sm',
};

/** full: fills its row. auto: sizes to its content (selects beside a label). */
export type FieldWidth = 'full' | 'auto';

/**
 * Class string for text-like inputs. Focus treatment comes from .landing-input
 * in index.css (accent border + soft ring), which replaces the default outline.
 * The inline size never takes a width class: its caller sets one.
 */
export const fieldClassName = (size: FieldSize = 'md', extra = '', opts: { width?: FieldWidth } = {}): string => {
    const width = size === 'inline' ? '' : (opts.width ?? 'full') === 'full' ? 'w-full ' : 'w-auto ';
    return `landing-input border-[1.5px] border-field-line bg-white text-ink outline-none transition-colors placeholder:text-ink-muted ${width}${FIELD_SIZE_CLASSES[size]}${extra ? ` ${extra}` : ''}`;
};

/**
 * Filter/facet chip — pill toggle matching the transport bar's pill language.
 * h-8 (32px) meets the minimum touch target. Callers add aria-pressed when the
 * chip is a toggle rather than an action.
 */
export const chipClassName = (active: boolean, extra = ''): string =>
    [
        'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] transition-colors',
        active
            ? 'border-accent/40 bg-accent-tint font-semibold text-accent'
            : 'border-panel-line font-medium text-ink-soft hover:bg-ink/5',
        extra,
    ]
        .filter(Boolean)
        .join(' ');

export const fieldLabelClassName = 'block text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted';

/**
 * Inline text link. On touch screens an invisible ::after widens the hit area
 * to ~44px tall without moving the text, so callers' own margins and display
 * still hold and desktop is unchanged.
 */
export const linkClassName =
    'relative text-sm text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:text-accent-hover hover:decoration-accent/60 pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3.5';

/** One row: 44px tall on touch, highlighted by pointer or keyboard alike. */
export const menuItemClassName = (danger = false, extra = ''): string =>
    `flex w-full cursor-pointer items-center px-3 py-2 text-left text-sm outline-none select-none data-highlighted:bg-ink/5 data-disabled:cursor-default data-disabled:text-stone-400 pointer-coarse:min-h-11 ${
        danger ? 'text-danger' : 'text-stone-800'
    }${extra ? ` ${extra}` : ''}`;
