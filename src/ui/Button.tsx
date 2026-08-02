import type { ButtonHTMLAttributes } from 'react';

import { buttonClassName } from '@/ui/classNames';
import type { ButtonSize, ButtonVariant } from '@/ui/classNames';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
}

/** The app button. Defaults to type="button" so forms must opt in to submit. */
export const Button = ({ variant = 'primary', size = 'md', className = '', type = 'button', ...rest }: ButtonProps) => (
    <button type={type} className={buttonClassName(variant, size, className)} {...rest} />
);
