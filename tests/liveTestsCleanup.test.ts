// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * scripts/live-tests-cleanup.sh deletes rows straight from a database, so it
 * must never be pointed anywhere but the local stack. The refusal is checked
 * by running it; what it deletes is pinned by its text (the live tests are
 * skipped in CI, and so is running it against a real stack here).
 */
const SCRIPT = resolve(process.cwd(), 'scripts/live-tests-cleanup.sh');

const run = (url: string) => spawnSync('bash', [SCRIPT, url], { encoding: 'utf8' });

describe('scripts/live-tests-cleanup.sh', () => {
    it.each([
        'postgresql://postgres:secret@db.example.supabase.co:5432/postgres',
        'postgresql://postgres:secret@127.0.0.1.example.com:5432/postgres',
        'postgres://user@10.0.0.5/postgres',
    ])('refuses a database that is not local: %s', (url) => {
        const result = run(url);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('refusing a database that is not local');
    });

    it('deletes only realtime hints of scores that no longer exist, and the live-test accounts’ audit rows', () => {
        const sql = readFileSync(SCRIPT, 'utf8');
        expect(sql).toMatch(/delete from realtime\.messages m[\s\S]*not exists \(\s*select 1 from public\.documents d/);
        expect(sql).toContain("a.payload::text ~ '@(takedown|district)\\.test\"'");
        expect(sql.match(/delete from/g)).toHaveLength(2);
    });
});
