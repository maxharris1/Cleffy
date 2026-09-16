import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security shape of the play-along corpus migration. The RPC semantics
 * (era preference, layout uniqueness, the mutopia-over-omr guard) are
 * exercised against Postgres; this guards what a review can miss in a
 * 200-line file: every table service_role-only with RLS on and no policies,
 * every RPC revoked from the client roles, and score_cache left alone.
 */
const sql = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260916140000_playalong_corpus.sql'),
    'utf8',
);

const TABLES = ['playalong_corpus', 'playalong_corpus_seed', 'playalong_corpus_control'];
const FUNCTIONS = ['playalong_corpus_get_by_hash', 'playalong_corpus_get_by_layout', 'playalong_corpus_put'];

describe('20260916140000_playalong_corpus.sql', () => {
    it('creates every corpus table service_role-only: RLS on, zero policies, grant to service_role', () => {
        for (const table of TABLES) {
            expect(sql).toContain(`create table if not exists public.${table} (`);
            expect(sql).toContain(`alter table public.${table} enable row level security;`);
            expect(sql).toContain(`grant all on public.${table} to service_role;`);
        }
        expect(sql).not.toMatch(/create policy/i);
    });

    it('keys the corpus by (pdf_sha256, engine_version, era) and the ledger by (work_title, origin, filename)', () => {
        expect(sql).toContain('primary key (pdf_sha256, engine_version, era)');
        expect(sql).toContain('primary key (work_title, origin, filename)');
    });

    it('revokes every RPC from public/anon/authenticated and grants it to service_role only', () => {
        for (const fn of FUNCTIONS) {
            expect(sql).toMatch(new RegExp(`create or replace function public\\.${fn} \\(`));
            expect(sql).toMatch(
                new RegExp(`revoke all on function public\\.${fn} \\([^;]*\\) from public, anon, authenticated;`),
            );
            expect(sql).toMatch(new RegExp(`grant execute on function public\\.${fn} \\([^;]*\\) to service_role;`));
        }
        expect(sql.match(/security definer/g)?.length).toBe(FUNCTIONS.length);
        expect(sql.match(/set search_path = public/g)?.length).toBe(FUNCTIONS.length);
    });

    it('carries licence / credit provenance on the corpus row', () => {
        for (const column of ['licence_tag', 'editor_credit', 'source_url', 'imslp_page_title']) {
            expect(sql).toMatch(new RegExp(`^\\s+${column} text`, 'm'));
        }
    });

    it('guards every create and the control-row insert so a re-apply over prod is a no-op', () => {
        expect(sql).not.toMatch(/^create (table|index)(?! if not exists)/m);
        expect(sql).toContain(
            'insert into public.playalong_corpus_control (paused) values (false) on conflict do nothing;',
        );
    });

    it('does not touch score_cache or drop anything', () => {
        const statements = sql.replace(/--[^\n]*/g, '');
        expect(statements).not.toMatch(/public\.score_cache/);
        expect(statements).not.toMatch(/\bdrop\b/i);
    });
});
