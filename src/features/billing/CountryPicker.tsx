import { useId, useMemo } from 'react';

import { countryOptions } from '@/features/billing/billingRegion';
import { fieldClassName } from '@/ui/classNames';

interface CountryPickerProps {
    value: string;
    onChange: (country: string) => void;
    className?: string;
}

/** "Prices for: [country]" -- the country sets the currency every price is shown and charged in. */
export const CountryPicker = ({ value, onChange, className = '' }: CountryPickerProps) => {
    const id = useId();
    const options = useMemo(() => countryOptions(), []);
    return (
        <p className={`flex flex-wrap items-center gap-2 text-sm text-stone-600 ${className}`}>
            <label htmlFor={id}>Prices for</label>
            <select
                id={id}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className={fieldClassName('sm', 'w-auto max-w-full py-1.5')}
            >
                {options.map((option) => (
                    <option key={option.code} value={option.code}>
                        {option.name}
                    </option>
                ))}
            </select>
        </p>
    );
};
