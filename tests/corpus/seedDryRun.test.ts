import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MUTOPIA_TREE_URL, OPENSCORE_REPOS } from '../../scripts/playalong-corpus.mjs';

/**
 * Offline dry run. The CLI reads every metadata URL through a disk cache keyed
 * by sha1(url), so a pre-seeded cache directory stands in for the network: the
 * Mutopia git tree, two piece RDFs, and empty OpenScore trees. The database is
 * pointed at a closed port; a dry run tolerates that and plans against an
 * empty ledger. `--source mutopia,openscore` keeps IA (and IMSLP) out entirely.
 */
const MUTOPIA = 'https://www.mutopiaproject.org';

const rdf = (fields: Record<string, string>): string =>
    `<?xml version="1.0"?>\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:mp="http://www.mutopiaproject.org/piece-data/0.1/">\n<rdf:Description rdf:about=".">${Object.entries(
        fields,
    )
        .map(([k, v]) => `\n    <mp:${k}>${v}</mp:${k}>`)
        .join('')}\n</rdf:Description>\n</rdf:RDF>\n`;

const seedCache = (dir: string, entries: Record<string, string>): void => {
    mkdirSync(dir, { recursive: true });
    for (const [url, body] of Object.entries(entries)) {
        writeFileSync(join(dir, `${createHash('sha1').update(url).digest('hex')}.txt`), body);
    }
};

const runSeed = (args: string[], env: Record<string, string>) =>
    spawnSync(
        process.execPath,
        [
            '--experimental-strip-types',
            '--disable-warning=ExperimentalWarning',
            resolve(process.cwd(), 'scripts/seed-playalong-corpus.mjs'),
            ...args,
        ],
        {
            encoding: 'utf8',
            env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'unused', ...env },
            timeout: 120_000,
        },
    );

describe('seed-playalong-corpus --dry-run (mocked network)', () => {
    it('plans Mutopia files for the top popular works, records skips, and never writes', () => {
        const root = mkdtempSync(join(tmpdir(), 'corpus-seed-'));
        const cache = join(root, 'cache');
        const evalDir = join(root, 'eval');
        mkdirSync(evalDir);
        const tree = {
            truncated: false,
            tree: [
                { type: 'blob', path: 'ftp/BeethovenLv/O27/moonlight/moonlight-lys/moonlight1-let.ly' },
                { type: 'blob', path: 'ftp/BeethovenLv/WoO59/fur_Elise_WoO59/fur_Elise_WoO59.ly' },
                { type: 'blob', path: 'ftp/BeethovenLv/O13/pathetique/pathetique.ly' },
                { type: 'tree', path: 'ftp/BeethovenLv' },
            ],
        };
        seedCache(cache, {
            [MUTOPIA_TREE_URL]: JSON.stringify(tree),
            [`${MUTOPIA}/ftp/BeethovenLv/O27/moonlight/moonlight.rdf`]: rdf({
                title: 'Sonata No. 14 “Moonlight”',
                composer: 'BeethovenLv',
                opus: 'Op. 27, No. 2',
                for: 'Piano',
                date: '1802',
                source: 'Berners, 1908',
                licence: 'Creative Commons Attribution-ShareAlike 2.5',
                midFile: 'moonlight-mids.zip',
                pdfFileA4: 'moonlight-a4.pdf',
                pdfFileLet: 'moonlight-let.pdf',
                id: 'Mutopia-2007/02/11-276',
                maintainer: 'Stewart Holmes',
            }),
            [`${MUTOPIA}/ftp/BeethovenLv/WoO59/fur_Elise_WoO59/fur_Elise_WoO59.rdf`]: rdf({
                title: 'Für Elise',
                composer: 'BeethovenLv',
                opus: 'WoO 59',
                for: 'Piano',
                date: '1810',
                licence: 'Public Domain',
                midFile: 'fur_Elise_WoO59.mid',
                pdfFileLet: 'fur_Elise_WoO59-let.pdf',
                id: 'Mutopia-2015/08/18-931',
                maintainer: 'Stelios Samelis',
            }),
            [`${MUTOPIA}/ftp/BeethovenLv/O13/pathetique/pathetique.rdf`]: rdf({
                title: 'Sonata No. 8 “Pathétique”',
                composer: 'BeethovenLv',
                opus: 'Op. 13',
                for: 'Piano',
                date: '1798',
                licence: 'Creative Commons Attribution-NonCommercial 3.0',
                pdfFileLet: 'pathetique-let.pdf',
                id: 'Mutopia-2000/01/01-1',
            }),
            ...Object.fromEntries(
                OPENSCORE_REPOS.map((repo) => [repo.treeUrl, JSON.stringify({ truncated: false, tree: [] })]),
            ),
        });

        const result = runSeed(
            [
                '--dry-run',
                '--limit',
                '3',
                '--sleep',
                '0',
                '--source',
                'mutopia,openscore',
                '--cache-dir',
                cache,
                '--eval-dir',
                evalDir,
                '--catalog',
                join(root, 'missing-catalog.jsonl'),
                '--no-wiki',
                '--no-editions',
            ],
            {},
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toMatch(/mode dry-run/);
        expect(result.stderr).toMatch(/ledger unavailable/);
        expect(result.stderr).toMatch(/mutopia index: 3 pieces/);

        const events = result.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const plans = events.filter((e) => e.status === 'plan');
        expect(plans.map((e) => [e.workTitle, e.origin, e.filename, e.reason])).toEqual([
            ['Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)', 'mutopia', 'moonlight-let.pdf', 'CC-BY-SA'],
            ['Für Elise, WoO 59 (Beethoven, Ludwig van)', 'mutopia', 'fur_Elise_WoO59-let.pdf', 'PD'],
        ]);
        expect(events.find((e) => e.status === 'plan_skip')).toMatchObject({
            workTitle: 'Piano Sonata No.8, Op.13 (Beethoven, Ludwig van)',
            reason: 'mutopia:non_commercial',
        });
        expect(events.at(-2)).toMatchObject({
            event: 'corpus_seed',
            ready: 0,
            queued: 0,
            skipped: 0,
            failed: 0,
            target: 3,
            mode: 'dry-run',
            fetched: 0,
        });
        expect(events.at(-1)).toMatchObject({
            event: 'corpus_seed_coverage',
            attempted: 3,
            popular: { mutopia: 2, openscore: 0, ia: 0, none: 1, total: 3 },
            parked: [],
        });
        expect(result.stdout).not.toMatch(/imslp\.org/);
    });

    it('refuses a live run without a corpus owner', () => {
        const result = runSeed(['--limit', '1'], { CORPUS_OWNER_USER_ID: '' });
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(/CORPUS_OWNER_USER_ID is required/);
    });

    it('rejects unknown sources and flags; --source imslp and --imslp-wait are accepted', () => {
        expect(runSeed(['--dry-run', '--source', 'ftp'], {}).stderr).toMatch(/--source must be one of/);
        expect(runSeed(['--dry-run', '--imslp'], {}).stderr).toMatch(/unknown flag/);
        const accepted = runSeed(
            ['--dry-run', '--source', 'imslp', '--imslp-wait', '--limit', '0', '--no-wiki', '--no-editions'],
            {},
        );
        expect(accepted.stderr).not.toMatch(/unknown flag|--source must be one of/);
        expect(accepted.status).not.toBe(2);
    });
});
