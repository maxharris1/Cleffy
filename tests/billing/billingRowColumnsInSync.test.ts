import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Drift guard.
 *
 * `src/types/database.ts` is hand-authored — its own header asks for it to be
 * kept in lockstep with supabase/migrations — and it is the only description the
 * client has of these two tables. Nothing under src/ queries either one, and
 * both are declared `Insert: never; Update: never`, so a column can land in SQL
 * and be missed here without a single call site going red. That already
 * happened: `mode` arrived on both tables in
 * 20260828180000_billing_stripe_mode.sql, NOT NULL and half of
 * billing_customers' primary key, and neither Row type learned about it.
 *
 * The fields are read out of the source text rather than off the types
 * themselves, because types are erased long before this runs — `keyof` is not
 * something a test can enumerate at runtime.
 *
 * Resolved from the project root: the jsdom test environment gives import.meta a
 * non-file URL, so fileURLToPath cannot be used here.
 */
const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');
const DATABASE_TYPES = resolve(process.cwd(), 'src/types/database.ts');

const allMigrations = (): string =>
    readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8'))
        .join('\n');

/** Table-level clauses, which share the create-table body with the columns. */
const NOT_A_COLUMN = /^(primary|unique|check|constraint|foreign|exclude|like)$/i;

/**
 * Blanks out everything nested in parens — `check (mode in ('live', 'test'))`,
 * `references auth.users (id)` — so the commas that survive are the ones
 * separating one definition from the next.
 */
const flatten = (body: string): string => {
    let depth = 0;
    return [...body]
        .map((char) => {
            if (char === '(') {
                depth += 1;
            } else if (char === ')') {
                depth -= 1;
            } else if (depth === 0) {
                return char;
            }
            return ' ';
        })
        .join('');
};

/** Every `alter table` touching one table, in each spelling Postgres accepts. */
const alterTable = (table: string): RegExp =>
    new RegExp(`alter table (?:only )?(?:if exists )?public\\."?${table}"?\\b[\\s\\S]*?;`, 'gi');

/**
 * What a table ends up with: its create-table body, plus every later `add column`.
 *
 * Comments come off the WHOLE file first, not just the create-table body. The
 * statement scan is lazy up to the next `;`, so a `--` comment containing one
 * truncates the match and every clause below it goes unseen — silently, because
 * a column the scan misses is simply absent from the expected set, and a Row
 * type missing that same column then matches. That is the drift this file
 * exists to catch, so the guard must not have a spelling that hides it: today
 * `columnsOf('managed_students', …)` loses `claimed_at` to the `;` in "on the
 * code path the claim stamps it;" three lines above it.
 *
 * The two regexes are correspondingly loose about the forms Postgres and the
 * Supabase CLI both emit — `alter table only`, a quoted identifier, `add` with
 * COLUMN left off — because each of those parsed as "no columns added" rather
 * than as an error. NOT_A_COLUMN carries the widening: dropping the mandatory
 * `column` keyword lets `add constraint` and `add primary key` through the
 * capture, and that is the list which already knows they are not columns.
 */
const columnsOf = (table: string, sql: string): Set<string> => {
    const bare = sql.replace(/--[^\n]*/g, '');
    const created = new RegExp(`create table public\\.${table} \\(\\n([\\s\\S]*?)\\n\\);`, 'i').exec(bare);
    if (!created?.[1]) {
        throw new Error(`no create table for public.${table}`);
    }

    const columns = new Set(
        flatten(created[1])
            .split(',')
            .map((definition) => definition.trim().split(/\s/)[0] ?? '')
            .filter((name) => name !== '' && !NOT_A_COLUMN.test(name)),
    );

    // Whole statements, because one `alter table` may carry several `add column`
    // clauses — that is how managed_students grew its four.
    for (const [statement] of bare.matchAll(alterTable(table))) {
        // Neither is modelled below, and both drift the other way — a type
        // naming a column the table no longer has. Loud beats silent.
        if (/\b(?:drop|rename) column\b/i.test(statement)) {
            throw new Error(`public.${table} has a drop/rename column this guard does not model`);
        }
        for (const clause of statement.matchAll(/add (?:column )?(?:if not exists )?"?(\w+)"?/gi)) {
            const added = clause[1];
            if (added && !NOT_A_COLUMN.test(added)) {
                columns.add(added);
            }
        }
    }

    return columns;
};

/**
 * The fields a Row type declares. A type that stops being a plain object literal
 * — an intersection, say — stops matching and throws, rather than quietly
 * asserting nothing.
 */
const fieldsOf = (typeName: string, source: string): Set<string> => {
    const declared = new RegExp(`export type ${typeName} = \\{\\n([\\s\\S]*?)\\n\\};`).exec(source);
    if (!declared?.[1]) {
        throw new Error(`no exported object type ${typeName} in src/types/database.ts`);
    }

    const body = declared[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    return new Set([...body.matchAll(/^\s*(\w+)\??\s*:/gm)].map(([, field]) => field ?? ''));
};

/**
 * The guard's own coverage.
 *
 * A drift guard that misses a spelling does not fail — it agrees with a type
 * that is missing the same column, which is worse than having no guard at all,
 * because the green tick is now evidence for the wrong thing. Each case below
 * added a column that the first version of `columnsOf` could not see.
 */
describe('columnsOf sees a column however the migration spells it', () => {
    const table = `create table public.subscriptions (\n    id text primary key,\n    user_id uuid not null\n);`;
    const sees = (statement: string): boolean => columnsOf('subscriptions', `${table}\n${statement}`).has('seat_id');

    it.each([
        ['plain', 'alter table public.subscriptions add column seat_id text;'],
        // pg_dump and `supabase db diff` both emit ONLY.
        ['only', 'alter table only public.subscriptions add column seat_id text;'],
        ['if exists', 'alter table if exists public.subscriptions add column seat_id text;'],
        ['quoted identifier', 'alter table public."subscriptions" add column seat_id text;'],
        // COLUMN is optional to Postgres, so it has to be optional here too.
        ['no COLUMN keyword', 'alter table public.subscriptions add seat_id text;'],
        ['if not exists', 'alter table public.subscriptions add column if not exists seat_id text;'],
        // The one that was live: a `;` inside a comment truncated the lazy
        // match, and every clause below it vanished.
        [
            'a clause below a comment containing a semicolon',
            'alter table public.subscriptions\n    add column seat_count int,\n    -- the webhook writes it; the portal reads it\n    add column seat_id text;',
        ],
    ])('%s', (_name, statement) => {
        expect(sees(statement)).toBe(true);
    });

    it('refuses to guess at a drop it does not model', () => {
        expect(() => sees('alter table public.subscriptions drop column seat_id;')).toThrow(/does not model/);
    });

    it('still knows a constraint is not a column', () => {
        const columns = columnsOf(
            'subscriptions',
            `${table}\nalter table public.subscriptions add constraint subs_pkey primary key (id);`,
        );
        expect(columns).toEqual(new Set(['id', 'user_id']));
    });
});

describe('billing row types stay in sync with the migrations', () => {
    const sql = allMigrations();
    const types = readFileSync(DATABASE_TYPES, 'utf8');

    it('BillingCustomerRow names every column of billing_customers', () => {
        expect(fieldsOf('BillingCustomerRow', types)).toEqual(columnsOf('billing_customers', sql));
    });

    it('SubscriptionRow names every column of subscriptions', () => {
        expect(fieldsOf('SubscriptionRow', types)).toEqual(columnsOf('subscriptions', sql));
    });
});
