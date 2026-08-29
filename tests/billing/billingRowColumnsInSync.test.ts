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

/** What a table ends up with: its create-table body, plus every later `add column`. */
const columnsOf = (table: string, sql: string): Set<string> => {
    const created = new RegExp(`create table public\\.${table} \\(\\n([\\s\\S]*?)\\n\\);`, 'i').exec(sql);
    if (!created?.[1]) {
        throw new Error(`no create table for public.${table}`);
    }

    const columns = new Set(
        flatten(created[1].replace(/--[^\n]*/g, ''))
            .split(',')
            .map((definition) => definition.trim().split(/\s/)[0] ?? '')
            .filter((name) => name !== '' && !NOT_A_COLUMN.test(name)),
    );

    // Whole statements, because one `alter table` may carry several `add column`
    // clauses — that is how managed_students grew its four.
    for (const [statement] of sql.matchAll(new RegExp(`alter table public\\.${table}\\b[\\s\\S]*?;`, 'gi'))) {
        for (const clause of statement.matchAll(/add column (?:if not exists )?(\w+)/gi)) {
            const added = clause[1];
            if (added) {
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
