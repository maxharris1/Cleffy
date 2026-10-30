import type { ButtonHTMLAttributes } from 'react';

import { CloseIcon } from '@/ui/icons';

export interface CloseButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
    /** Accessible name; "Close" unless the control dismisses something else. */
    label?: string;
    /** Icon size in px. */
    iconSize?: number;
}

/**
 * The app's ✕. Compact on a mouse; on a coarse pointer an invisible ::after
 * (hit-44) makes it a 44px target without moving the icon, so headers and
 * banners keep their desktop layout. Tone (text colour, hover) comes from
 * className when the default stone does not suit the surface.
 */
export const CloseButton = ({
    label = 'Close',
    iconSize = 18,
    className = '',
    type = 'button',
    ...rest
}: CloseButtonProps) => (
    <button
        type={type}
        aria-label={label}
        className={`inline-flex shrink-0 items-center justify-center rounded-lg transition-colors pointer-coarse:hit-44 ${
            className || 'size-7.5 text-stone-500 hover:bg-stone-100'
        }`}
        {...rest}
    >
        <CloseIcon size={iconSize} className="shrink-0" />
    </button>
);
