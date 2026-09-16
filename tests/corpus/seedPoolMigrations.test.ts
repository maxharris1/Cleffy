import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Shape guard for the seed-pool migrations (plan Phase 2c). The claim RPC
 * gains exactly one optional ceiling that defaults to today's behaviour, keeps
 * user rows ahead of seed rows, and stays service_role-only; the seed sweep
 * only ever pokes the seed URL, only for seed rows, and stays quiet while the
 * corpus is paused or the seed service is not configured.
 */
const read = (name: string): string => readFileSync(resolve(process.cwd(), 'supabase/migrations', name), 'utf8');

describe('20260916170000_omr_claim_priority_filter.sql', () => {
    const sql = read('20260916170000_omr_claim_priority_filter.sql');

    it('replaces the (text, int) overload with one that adds a nullable p_max_priority', () => {
        expect(sql).toContain('drop function if exists public.omr_claim_job (text, int);');
        expect(sql).toMatch(
            /create or replace function public\.omr_claim_job \(\s*p_worker_id text,\s*p_lease_seconds int default 300,\s*p_max_priority int default null\s*\)/,
        );
    });

    it('filters on priority <= p_max_priority only when set and keeps the claim order', () => {
        expect(sql).toContain('and (p_max_priority is null or priority <= p_max_priority)');
        expect(sql).toContain('order by priority desc, id');
        expect(sql).toContain('for update skip locked');
        expect(sql).toContain("where status = 'queued'");
        expect(sql).toContain('and run_after <= now()');
    });

    it('re-applies the service_role-only grants for the new signature', () => {
        expect(sql).toContain(
            'revoke all on function public.omr_claim_job (text, int, int) from public, anon, authenticated;',
        );
        expect(sql).toContain('grant execute on function public.omr_claim_job (text, int, int) to service_role;');
        expect(sql).not.toMatch(/grant .* to (authenticated|anon)/i);
    });
});

describe('20260916170100_omr_seed_sweep.sql', () => {
    const sql = read('20260916170100_omr_seed_sweep.sql');

    it('counts only queued seed rows and returns while paused', () => {
        expect(sql).toContain('create or replace function public.omr_seed_sweep ()');
        expect(sql).toContain('from public.playalong_corpus_control c');
        expect(sql).toContain('if coalesce(paused, false) then');
        expect(sql).toMatch(/where status = 'queued'\s+and priority < 0\s+and run_after <= now\(\);/);
    });

    it('pokes the seed URL from vault and is a no-op without it; never reaps or purges', () => {
        expect(sql).toContain("where name = 'omr_seed_service_url'");
        expect(sql).toContain("where name = 'omr_service_secret'");
        expect(sql).not.toContain("'omr_service_url'");
        expect(sql).toContain("url := rtrim(svc_url, '/') || '/poke'");
        expect(sql).not.toMatch(/omr_reap_expired_leases|score_cache_purge_stale/);
    });

    it('schedules its own cron row without touching omr-sweep', () => {
        expect(sql).toContain("where jobname = 'omr-seed-sweep';");
        expect(sql).toContain(
            "select cron.schedule ('omr-seed-sweep', '* * * * *', $$select public.omr_seed_sweep ()$$);",
        );
        expect(sql).not.toContain("'omr-sweep'");
        expect(sql).toContain('revoke all on function public.omr_seed_sweep () from public, anon, authenticated;');
        expect(sql).toContain('grant execute on function public.omr_seed_sweep () to service_role;');
    });
});
