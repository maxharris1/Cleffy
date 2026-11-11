/**
 * The browser's copy of supabase/functions/_shared/consentAge.ts: the youngest
 * age at which a person may use Cleffy on their own, by country.
 *
 * A mirror rather than an import so the age screen's chunk carries no Edge
 * Function path, and so the copy the user is judged against is visible in the
 * front end's own tree. tests/legal/consentAgeInSync.test.ts fails the build
 * when this, the server copy and public.consent_age() disagree — read the
 * server file for why each age is what it is.
 */

/** Where a country is not listed below. */
export const DEFAULT_CONSENT_AGE = 13;

/**
 * ISO 3166-1 alpha-2 → age. Every EU/EEA state is listed, the 13s included, so
 * "not listed" only ever means "outside the EEA and the UK".
 */
export const CONSENT_AGES: Readonly<Record<string, number>> = {
    AT: 14,
    BE: 13,
    BG: 14,
    HR: 16,
    CY: 14,
    CZ: 15,
    DK: 13,
    EE: 13,
    FI: 13,
    FR: 15,
    DE: 16,
    GR: 15,
    HU: 16,
    IE: 16,
    IT: 14,
    LV: 13,
    LT: 14,
    LU: 16,
    MT: 13,
    NL: 16,
    PL: 16,
    PT: 13,
    RO: 16,
    SK: 16,
    SI: 15,
    ES: 14,
    SE: 13,
    // EEA, outside the EU.
    IS: 13,
    LI: 16,
    NO: 13,
    // United Kingdom.
    GB: 13,
};

/** Two ASCII letters, either case. Says nothing about whether ISO assigned it. */
export const isCountryCode = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z]{2}$/.test(value);

/** The consent age for a country code, case-insensitive; the default for anything unlisted. */
export const consentAgeFor = (country: string): number => CONSENT_AGES[country.toUpperCase()] ?? DEFAULT_CONSENT_AGE;

/**
 * Bumped whenever the teacher's attestation wording changes, and stored with
 * every attestation (teacher_attestations.wording_version) so a record always
 * says which sentence the teacher agreed to.
 */
export const TEACHER_ATTESTATION_VERSION = '2026-10-21';

/**
 * The sentence a teacher ticks on add-student and restore. `countryName` is the
 * display name the form showed; the server stores this text as sent.
 */
export const teacherAttestationText = (minAge: number, countryName: string): string =>
    `I confirm this student is at least ${minAge} years old, the minimum age to use Cleffy in ${countryName}.`;
