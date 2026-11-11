import { consentAgeFor } from '@/features/legal/consentAge';

/**
 * The age screen's decisions, apart from its UI so they can be tested.
 *
 * What the account keeps is `AgeGate`: the country and the age that country
 * requires, which the person has just shown they meet. Their birth month and
 * year are compared here and dropped — they are never sent, stored or logged.
 * public.hook_before_user_created (20261021120000_consent_age.sql) checks the
 * same object server-side before GoTrue creates the user.
 */
export interface AgeGate {
    /** ISO 3166-1 alpha-2, upper case. */
    country: string;
    /** consent_age(country) at the time of the check. */
    min_age: number;
    source: 'self';
    v: 1;
}

export const ageGateFor = (country: string): AgeGate => {
    const code = country.toUpperCase();
    return { country: code, min_age: consentAgeFor(code), source: 'self', v: 1 };
};

/**
 * Whether someone born in `birthMonth` (1-12) of `birthYear` has CERTAINLY
 * turned `age` by `now`.
 *
 * Month and year are all that is asked, so in the birthday month itself the
 * answer is unknowable — and read as "not yet". Being a few weeks
 * conservative once is the price of never asking for a full date of birth.
 */
export const isCertainlyAtLeast = (birthYear: number, birthMonth: number, age: number, now: Date = new Date()) => {
    const monthNow = now.getFullYear() * 12 + now.getMonth();
    const birthdayMonth = (birthYear + age) * 12 + (birthMonth - 1);
    return monthNow > birthdayMonth;
};

/**
 * A refusal is remembered on this device for a day, so the answer cannot be
 * changed by pressing Back and trying an earlier year — the FTC's point about
 * neutral age screens. It holds no birthday, only when the refusal happened.
 * Storage that throws (private mode, blocked site data) just forgets.
 */
const BLOCK_KEY = 'cleffy.ageCheck.refusedAt';
const BLOCK_MS = 24 * 60 * 60 * 1000;

export const ageCheckBlocked = (now: number = Date.now()): boolean => {
    try {
        const at = Number(window.localStorage.getItem(BLOCK_KEY));
        return Number.isFinite(at) && at > 0 && now - at < BLOCK_MS;
    } catch {
        return false;
    }
};

export const rememberAgeCheckRefusal = (now: number = Date.now()): void => {
    try {
        window.localStorage.setItem(BLOCK_KEY, String(now));
    } catch {
        // Nothing to remember it in; the refusal on screen still stands.
    }
};
