import { useMemo } from 'react';

import { consentAgeFor, teacherAttestationText } from '@/features/legal/consentAge';
import { countryName, countryOptions } from '@/features/legal/countries';
import { fieldClassName, fieldLabelClassName } from '@/ui/classNames';

export interface AgeAttestationFieldsProps {
    /** Prefixes the inputs' ids, so the add form and the restore dialog can both be mounted. */
    idPrefix: string;
    country: string;
    onCountryChange: (country: string) => void;
    confirmed: boolean;
    onConfirmedChange: (confirmed: boolean) => void;
    disabled?: boolean;
}

/**
 * The student's country and the teacher's "at least N" — what add-student and
 * restore both need before student-provision will act (readTeacherAttestation).
 *
 * The sentence names the age for the chosen country, so it only appears once
 * a country is picked; changing the country clears the tick, because the
 * teacher agreed to a different sentence. No birthday is ever asked.
 */
export const AgeAttestationFields = ({
    idPrefix,
    country,
    onCountryChange,
    confirmed,
    onConfirmedChange,
    disabled = false,
}: AgeAttestationFieldsProps) => {
    const countries = useMemo(() => countryOptions(), []);
    const countryId = `${idPrefix}-country`;
    const confirmId = `${idPrefix}-age-confirm`;

    return (
        <div>
            <label htmlFor={countryId} className={fieldLabelClassName}>
                Student’s country
            </label>
            <select
                id={countryId}
                value={country}
                disabled={disabled}
                onChange={(event) => {
                    onCountryChange(event.target.value);
                    onConfirmedChange(false);
                }}
                className={fieldClassName('sm', 'mt-1.5 sm:max-w-sm')}
            >
                <option value="">Choose a country</option>
                {countries.map((option) => (
                    <option key={option.code} value={option.code}>
                        {option.name}
                    </option>
                ))}
            </select>
            {country ? (
                <label htmlFor={confirmId} className="mt-3 flex cursor-pointer items-start gap-2.5">
                    <input
                        id={confirmId}
                        type="checkbox"
                        checked={confirmed}
                        disabled={disabled}
                        onChange={(event) => onConfirmedChange(event.target.checked)}
                        className="mt-0.5 accent-accent"
                    />
                    <span className="text-sm leading-relaxed text-stone-700">
                        {teacherAttestationText(consentAgeFor(country), countryName(country))}
                    </span>
                </label>
            ) : null}
        </div>
    );
};
