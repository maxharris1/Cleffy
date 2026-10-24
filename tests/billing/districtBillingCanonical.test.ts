import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * public.district_billing has ONE definition (launch fix pass round 2, D item 4
 * / A item 4): the block between the canonical markers, byte-identical in
 * 20261020180500_district_seat_cap_and_grace.sql (mh/district-seats, #61) and
 * 20261021120700_district_retention.sql (mh/launch-consent, #64).
 * tests/sql/district_billing_canonical.sql runs a copy of it against a real
 * database -- from nothing, then again over itself -- and checks the end state
 * and the constraints. What CI holds here: that copy is the migration's bytes,
 * the bytes hash to the value #64 is held to as well, and the block keeps the
 * properties that make it rerunnable and closed to clients.
 *
 * Changing the block means changing it in both PRs and this hash with it.
 */

const CANONICAL_SHA256 = 'a3043de59252d4191331b137fedb8192f3cdc206db2a222be8e35d7b913b60be';

const OPEN = '-- >>> canonical public.district_billing >>>';
const CLOSE = '-- <<< canonical public.district_billing <<<\n';

const read = (...segments: string[]): string => readFileSync(resolve(process.cwd(), ...segments), 'utf8');

/** Every canonical block in a file, markers included. */
const blocks = (source: string): string[] => {
    const found: string[] = [];
    let from = 0;
    for (;;) {
        const start = source.indexOf(OPEN, from);
        if (start < 0) {
            return found;
        }
        const end = source.indexOf(CLOSE, start);
        expect(end, 'closing marker').toBeGreaterThan(start);
        found.push(source.slice(start, end + CLOSE.length));
        from = end + CLOSE.length;
    }
};

const MIGRATION = read('supabase/migrations', '20261020180500_district_seat_cap_and_grace.sql');
const [BLOCK] = blocks(MIGRATION);

describe('the canonical district_billing definition', () => {
    it('appears exactly once in the migration, with the hash #64 is held to', () => {
        expect(blocks(MIGRATION)).toHaveLength(1);
        expect(createHash('sha256').update(BLOCK!).digest('hex')).toBe(CANONICAL_SHA256);
    });

    it('is what the SQL proof runs, byte for byte, both times', () => {
        const proof = blocks(read('tests/sql', 'district_billing_canonical.sql'));
        expect(proof).toHaveLength(2);
        for (const copy of proof) {
            expect(copy).toBe(BLOCK);
        }
    });

    it('is the only declaration of the table anywhere in this branch’s migrations', () => {
        const outside = MIGRATION.replace(BLOCK!, '');
        expect(outside).not.toMatch(/create table[^;]*public\.district_billing \(/i);
        expect(outside).not.toMatch(/alter table public\.district_billing\s+(add|drop|alter)/i);
        expect(outside).not.toMatch(/(grant|revoke)[^;]+on table public\.district_billing\b(?!_log)/i);
    });

    it('creates the table only if it is missing, and each constraint only if missing by name', () => {
        expect(BLOCK).toMatch(/create table if not exists public\.district_billing \(/);
        for (const name of [
            'district_billing_contract_ends_source_check',
            'district_billing_contract_ends_source_matches',
        ]) {
            expect(BLOCK).toMatch(
                new RegExp(
                    `if not exists \\([^;]*conname = '${name}'\\s*\\) then\\s*alter table public\\.district_billing\\s*add constraint ${name}`,
                ),
            );
        }
        expect(BLOCK).toMatch(/create index if not exists district_billing_subscription/);
        expect(BLOCK).toMatch(/create index if not exists district_billing_contract_ends/);
        // Nothing in the table definition that a rerun would add a second time.
        const table = BLOCK!.slice(
            BLOCK!.indexOf('create table'),
            BLOCK!.indexOf(');', BLOCK!.indexOf('create table')),
        );
        expect(table).not.toMatch(/\bcheck\b/i);
    });

    it('holds the source to the date, an admin pin of null aside, without a null slipping through', () => {
        expect(BLOCK).toContain(
            "check ((contract_ends_source is null) = (contract_ends_at is null) or contract_ends_source is not distinct from 'admin')",
        );
        expect(BLOCK).toContain("check (contract_ends_source in ('admin', 'stripe'))");
    });

    it('lets the service role read and nobody else anything, the same after every run', () => {
        expect(BLOCK).toContain('alter table public.district_billing enable row level security;');
        expect(BLOCK).toContain(
            'revoke all on table public.district_billing from public, anon, authenticated, service_role;',
        );
        expect(BLOCK).toContain('grant select on table public.district_billing to service_role;');
        expect(BLOCK!.match(/^grant /gm)).toHaveLength(1);
        expect(BLOCK).not.toMatch(/create policy/i);
    });

    it('carries contract_ends_at nullable, where the retention purge reads it', () => {
        expect(BLOCK).toMatch(/\n {4}contract_ends_at timestamptz,\n/);
    });
});
