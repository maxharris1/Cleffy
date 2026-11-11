import type { InputHTMLAttributes, Ref } from 'react';

import { fieldClassName, fieldLabelClassName } from '@/ui/classNames';
import type { FieldSize } from '@/ui/classNames';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'size'> {
    id: string;
    label: string;
    size?: FieldSize;
    /** Adds top margin when stacked below another field. */
    spaced?: boolean;
    /** The input itself (to focus or select it). */
    ref?: Ref<HTMLInputElement>;
}

/** Labelled text input — the one field treatment for auth, join, and search surfaces. */
export const TextField = ({ id, label, size = 'md', spaced = false, ref, ...inputProps }: TextFieldProps) => (
    <>
        <label htmlFor={id} className={`${fieldLabelClassName}${spaced ? ' mt-4' : ''}`}>
            {label}
        </label>
        <input id={id} ref={ref} className={`mt-1.5 ${fieldClassName(size)}`} {...inputProps} />
    </>
);
