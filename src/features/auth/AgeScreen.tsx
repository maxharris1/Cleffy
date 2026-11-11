import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';

import {
    ageCheckBlocked,
    ageGateFor,
    isCertainlyAtLeast,
    rememberAgeCheckRefusal,
    type AgeGate,
} from '@/features/auth/ageCheck';
import { countryOptions } from '@/features/legal/countries';
import { BrandShell } from '@/ui/BrandShell';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';
import { fieldClassName, fieldLabelClassName, linkClassName } from '@/ui/classNames';

/** How far back the year list goes. */
const YEARS_SHOWN = 100;

const COPY = {
    register: { title: 'Create account', subtitle: 'First, two quick questions.' },
    join: { title: 'Join a shared score', subtitle: 'First, two quick questions.' },
} as const;

export interface AgeScreenProps {
    purpose: keyof typeof COPY;
    /** Called once the person meets the age for their country; the birthday goes no further. */
    onPass: (gate: AgeGate) => void;
    /** Under the form, e.g. the sign-up page's "Already have an account?". */
    footer?: ReactNode;
}

/**
 * The neutral age screen in front of every self-made account: sign-up on
 * /register, and the guest a share link creates on /join.
 *
 * Neutral in the FTC's sense: it asks when you were born rather than "are you
 * over 13?", says nothing about which answer passes, and a refusal is the
 * same sentence whatever the age — and stays on this device for a day
 * (ageCheck.ts) so Back and an earlier year do not undo it. Country first,
 * because the age it is compared with is that country's (consentAge.ts).
 *
 * Only the outcome leaves this component: `{ country, min_age }`. The month
 * and year live in its state until it unmounts, and are never sent anywhere.
 */
export const AgeScreen = ({ purpose, onPass, footer }: AgeScreenProps) => {
    const [blocked, setBlocked] = useState(() => ageCheckBlocked());
    const [country, setCountry] = useState('');
    const [month, setMonth] = useState('');
    const [year, setYear] = useState('');
    const [error, setError] = useState<string | null>(null);

    const countries = useMemo(() => countryOptions(), []);
    const months = useMemo(() => {
        const format = new Intl.DateTimeFormat(undefined, { month: 'long' });
        return Array.from({ length: 12 }, (_, i) => ({
            value: String(i + 1),
            name: format.format(new Date(2000, i, 1)),
        }));
    }, []);
    const years = useMemo(() => {
        const current = new Date().getFullYear();
        return Array.from({ length: YEARS_SHOWN }, (_, i) => String(current - i));
    }, []);

    if (blocked) {
        return (
            <BrandShell title="Sorry" subtitle="You can’t create a Cleffy account at this time.">
                <p className="text-center text-sm leading-relaxed text-stone-600">
                    Cleffy is for people who meet the minimum age where they live.
                </p>
                <p className="mt-6 text-center">
                    <Link to="/" className={linkClassName}>
                        Back to home
                    </Link>
                </p>
            </BrandShell>
        );
    }

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!country || !month || !year) {
            setError('Choose your country, birth month and birth year.');
            return;
        }
        const gate = ageGateFor(country);
        if (!isCertainlyAtLeast(Number(year), Number(month), gate.min_age)) {
            rememberAgeCheckRefusal();
            setBlocked(true);
            return;
        }
        onPass(gate);
    };

    const { title, subtitle } = COPY[purpose];
    const selectClass = fieldClassName('md', 'mt-1.5');

    return (
        <BrandShell title={title} subtitle={subtitle}>
            <form noValidate onSubmit={submit}>
                <label htmlFor="age-country" className={fieldLabelClassName}>
                    Where do you live?
                </label>
                <select
                    id="age-country"
                    value={country}
                    autoComplete="country"
                    onChange={(e) => setCountry(e.target.value)}
                    className={selectClass}
                >
                    <option value="">Choose a country</option>
                    {countries.map((option) => (
                        <option key={option.code} value={option.code}>
                            {option.name}
                        </option>
                    ))}
                </select>

                <fieldset className="mt-4">
                    <legend className={fieldLabelClassName}>When were you born?</legend>
                    <div className="grid grid-cols-[3fr_2fr] gap-2">
                        <select
                            id="age-month"
                            aria-label="Birth month"
                            value={month}
                            onChange={(e) => setMonth(e.target.value)}
                            className={selectClass}
                        >
                            <option value="">Month</option>
                            {months.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.name}
                                </option>
                            ))}
                        </select>
                        <select
                            id="age-year"
                            aria-label="Birth year"
                            value={year}
                            onChange={(e) => setYear(e.target.value)}
                            className={selectClass}
                        >
                            <option value="">Year</option>
                            {years.map((value) => (
                                <option key={value} value={value}>
                                    {value}
                                </option>
                            ))}
                        </select>
                    </div>
                </fieldset>

                {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}
                <Button type="submit" className="mt-6 w-full">
                    Continue
                </Button>
                <p className="mt-3 text-xs leading-relaxed text-stone-600">
                    We use this once to check you can use Cleffy where you live. Your birthday isn’t saved.
                </p>
            </form>
            {footer}
        </BrandShell>
    );
};
