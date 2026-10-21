/**
 * The youngest age at which a person may agree to Cleffy's processing on their
 * own, by country — the "digital age of consent".
 *
 * Cleffy is for people 13 and over, and older where a country says so: GDPR
 * Art. 8 lets each EU/EEA member state set its own age between 13 and 16, and
 * the UK set 13 (UK GDPR / Data Protection Act 2018 s.9). Everywhere else the
 * floor is 13, the COPPA line. Nobody under the age for their country signs up
 * by themselves; under-13s arrive later through a teacher consent flow that is
 * not part of this build.
 *
 * Three copies, held together by tests/legal/consentAgeInSync.test.ts:
 *  - this file, which the Edge Functions use (student-provision checks the
 *    teacher's attestation against it);
 *  - src/features/legal/consentAge.ts, the browser's mirror, which the age
 *    screen and the add-student form read;
 *  - public.consent_age() in supabase/migrations/20261021120000_consent_age.sql,
 *    which the before_user_created Auth hook reads.
 * Change all three together, or the test fails.
 *
 * NO imports, so vitest and Deno load this exact file.
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

/** What the add-student and restore forms send, as `attestation` on the request. */
export interface TeacherAttestationInput {
    country?: unknown;
    countryName?: unknown;
    confirmed?: unknown;
    wording?: unknown;
    version?: unknown;
}

export interface TeacherAttestation {
    /** Upper case. */
    country: string;
    minAge: number;
    /** The sentence the teacher ticked, exactly as shown. */
    wording: string;
    version: string;
}

export type AttestationCheck =
    { ok: true; attestation: TeacherAttestation } | { ok: false; status: 400 | 409; code: string; error: string };

const MAX_COUNTRY_NAME = 80;

/**
 * student-provision's reading of a teacher's attestation (server copy only;
 * the browser builds one, it never judges one).
 *
 * The age is the server's, not the form's: the wording must be the sentence
 * this table produces for that country, so a form that named a lower age —
 * an old build, or a hand-written request — is refused rather than recorded.
 * A different wording version is a 409, the "reload the page" kind.
 */
export const readTeacherAttestation = (input: unknown): AttestationCheck => {
    const refuse = (code: string, error: string, status: 400 | 409 = 400): AttestationCheck => ({
        ok: false,
        status,
        code,
        error,
    });
    if (!input || typeof input !== 'object') {
        return refuse('attestation_required', 'Confirm the student’s country and age to continue.');
    }
    const { country, countryName, confirmed, wording, version } = input as TeacherAttestationInput;
    if (!isCountryCode(country)) {
        return refuse('attestation_country', 'Choose the country the student lives in.');
    }
    if (confirmed !== true) {
        return refuse('attestation_unconfirmed', 'Confirm the student meets the minimum age for their country.');
    }
    if (typeof countryName !== 'string' || !countryName.trim() || countryName.length > MAX_COUNTRY_NAME) {
        return refuse('attestation_country', 'Choose the country the student lives in.');
    }
    if (version !== TEACHER_ATTESTATION_VERSION) {
        return refuse('attestation_outdated', 'This page is out of date. Reload it and try again.', 409);
    }
    const minAge = consentAgeFor(country);
    if (wording !== teacherAttestationText(minAge, countryName)) {
        return refuse('attestation_outdated', 'This page is out of date. Reload it and try again.', 409);
    }
    return { ok: true, attestation: { country: country.toUpperCase(), minAge, wording, version } };
};
