// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as client from '@/features/legal/consentAge';
import * as server from '../../supabase/functions/_shared/consentAge';

/**
 * The consent-age table exists three times — the Edge Functions' copy, the
 * browser's mirror, and public.consent_age() which the before_user_created Auth
 * hook reads — and the three must say the same thing. If they drift, the age
 * screen lets someone through whom the hook then refuses (or the reverse, which
 * is worse), so a mismatch fails the build here instead.
 *
 * The SQL side is parsed out of the newest migration that defines the
 * function, the way tests/security/functionGrants.test.ts resolves
 * create-or-replace: the last definition in timestamp order is the live one.
 */

const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

const latestConsentAgeSql = (): string => {
    const defining = readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith('.sql'))
        .sort()
        .filter((file) =>
            /create\s+or\s+replace\s+function\s+public\.consent_age\s*\(/i.test(
                readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8'),
            ),
        );
    const latest = defining.at(-1);
    if (!latest) {
        throw new Error('no migration defines public.consent_age()');
    }
    const sql = readFileSync(resolve(MIGRATIONS_DIR, latest), 'utf8');
    const body = sql.match(/create\s+or\s+replace\s+function\s+public\.consent_age[\s\S]*?\$\$;/i)?.[0];
    if (!body) {
        throw new Error(`could not find the consent_age body in ${latest}`);
    }
    return body;
};

const sqlTable = (): { ages: Record<string, number>; fallback: number } => {
    const body = latestConsentAgeSql();
    const ages: Record<string, number> = {};
    for (const [, code, age] of body.matchAll(/when\s+'([A-Z]{2})'\s+then\s+(\d+)/g)) {
        ages[code as string] = Number(age);
    }
    const fallback = Number(body.match(/else\s+(\d+)\s+end/i)?.[1]);
    return { ages, fallback };
};

describe('consent ages agree everywhere', () => {
    it('the browser mirror matches the server table exactly', () => {
        expect(client.CONSENT_AGES).toEqual(server.CONSENT_AGES);
        expect(client.DEFAULT_CONSENT_AGE).toBe(server.DEFAULT_CONSENT_AGE);
        expect(client.TEACHER_ATTESTATION_VERSION).toBe(server.TEACHER_ATTESTATION_VERSION);
        expect(client.teacherAttestationText(16, 'Germany')).toBe(server.teacherAttestationText(16, 'Germany'));
    });

    it('public.consent_age() matches the server table exactly', () => {
        const { ages, fallback } = sqlTable();
        expect(ages).toEqual(server.CONSENT_AGES);
        expect(fallback).toBe(server.DEFAULT_CONSENT_AGE);
    });
});

describe('the table itself', () => {
    it('defaults to 13 and lists the UK at 13', () => {
        expect(server.DEFAULT_CONSENT_AGE).toBe(13);
        expect(server.consentAgeFor('US')).toBe(13);
        expect(server.consentAgeFor('GB')).toBe(13);
    });

    it('lists every EU/EEA state, each between 13 and 16', () => {
        const eea = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO'.split(
            ' ',
        );
        for (const code of eea) {
            const age = server.CONSENT_AGES[code];
            expect(age, code).toBeGreaterThanOrEqual(13);
            expect(age, code).toBeLessThanOrEqual(16);
        }
        expect(Object.keys(server.CONSENT_AGES).sort()).toEqual([...eea, 'GB'].sort());
    });

    it('reads the higher ages where countries set them', () => {
        expect(server.consentAgeFor('de')).toBe(16);
        expect(server.consentAgeFor('FR')).toBe(15);
        expect(server.consentAgeFor('es')).toBe(14);
        expect(server.consentAgeFor('NL')).toBe(16);
    });

    it('accepts only two-letter codes', () => {
        expect(server.isCountryCode('DE')).toBe(true);
        expect(server.isCountryCode('de')).toBe(true);
        expect(server.isCountryCode('DEU')).toBe(false);
        expect(server.isCountryCode('')).toBe(false);
        expect(server.isCountryCode(16)).toBe(false);
    });
});
