/**
 * Class-string builders for the design system. They live apart from the
 * component files so those stay fast-refresh clean, and so button-shaped
 * non-buttons (router <Link>s, file-input <label>s) can share the exact look.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerGhost';
export type ButtonSize = 'md' | 'sm';

const BUTTON_BASE =
    'inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap font-medium transition disabled:cursor-default disabled:opacity-50';

const BUTTON_SIZE_CLASSES: Record<ButtonSize, string> = {
    md: 'rounded-xl px-5 py-3',
    sm: 'rounded-lg px-3.5 py-2 text-sm',
};

const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
    primary: 'landing-cta text-white',
    secondary: 'border border-stone-300/90 bg-white/70 text-stone-800 hover:bg-white',
    ghost: 'text-stone-600 hover:bg-stone-100',
    danger: 'bg-danger text-white hover:bg-red-500',
    dangerGhost: 'text-danger hover:bg-red-50',
};

export const buttonClassName = (variant: ButtonVariant, size: ButtonSize = 'md', extra = ''): string =>
    `${BUTTON_BASE} ${BUTTON_SIZE_CLASSES[size]} ${BUTTON_VARIANT_CLASSES[variant]}${extra ? ` ${extra}` : ''}`;

export type FieldSize = 'md' | 'sm';

const FIELD_SIZE_CLASSES: Record<FieldSize, string> = {
    md: 'rounded-xl px-3.5 py-3',
    sm: 'rounded-lg px-3 py-2 text-sm',
};

/**
 * Class string for text-like inputs. Focus treatment comes from .landing-input
 * in index.css (accent border + soft ring), which replaces the default outline.
 */
export const fieldClassName = (size: FieldSize = 'md', extra = ''): string =>
    `landing-input w-full border border-stone-300/90 bg-white/70 text-stone-900 outline-none transition placeholder:text-stone-500 ${FIELD_SIZE_CLASSES[size]}${extra ? ` ${extra}` : ''}`;

export const fieldLabelClassName = 'block text-xs font-medium uppercase tracking-[0.08em] text-stone-600';
