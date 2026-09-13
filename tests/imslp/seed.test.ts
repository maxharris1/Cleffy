import { mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { taxonomyCategories, writeCatalog } from '../../scripts/imslp-catalog.mjs';

const fixtureCatalog = () => ({
    generatedAt: '2026-09-10T00:00:00.000Z',
    works: [
        {
            page_id: 1,
            page_title: 'Goldberg Variations, BWV 988 (Bach, Johann Sebastian)',
            composer: 'Bach, Johann Sebastian',
            categories: ['For piano', 'Baroque', 'G major'],
            touched: '2010-01-01T00:00:00Z',
        },
    ],
    categories: taxonomyCategories().map((category) => ({
        category,
        pages_done: category === 'For piano' ? 12 : 1,
    })),
});

const runSeed = (args: string[]) =>
    spawnSync(
        process.execPath,
        [
            '--experimental-strip-types',
            '--disable-warning=ExperimentalWarning',
            resolve(process.cwd(), 'scripts/imslp-seed.mjs'),
            ...args,
        ],
        { encoding: 'utf8', env: { ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' } },
    );

describe('imslp:seed', () => {
    it('loads a tiny fixture file without network', () => {
        const dir = mkdtempSync(join(tmpdir(), 'imslp-seed-'));
        const jsonlPath = join(dir, 'imslp-works-catalog.jsonl');
        const syncPath = join(dir, 'imslp-works-sync.json');
        writeCatalog(fixtureCatalog(), { jsonlPath, syncPath });

        const result = runSeed(['--dry-run', '--catalog', jsonlPath]);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toMatch(/1 works/);
        expect(result.stdout).toMatch(/dry run \(no writes\)/);
        expect(result.stdout).toMatch(new RegExp(`${taxonomyCategories().length} chip categories`));
    });

    it('refuses a fixture that omits a chip category', () => {
        const dir = mkdtempSync(join(tmpdir(), 'imslp-seed-missing-'));
        const jsonlPath = join(dir, 'imslp-works-catalog.jsonl');
        const syncPath = join(dir, 'imslp-works-sync.json');
        writeCatalog(
            {
                generatedAt: '2026-09-10T00:00:00.000Z',
                works: [],
                categories: [{ category: 'For piano', pages_done: 1 }],
            },
            { jsonlPath, syncPath },
        );

        const result = runSeed(['--dry-run', '--catalog', jsonlPath]);
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(/missing chip categories/);
    });
});
