// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { featureMapRows, readRepoFile as read, SKILL_DIR } from './featureMapRows';

const SKILL_HEADINGS = ['Launch', 'Doctor', 'Drive', 'Evidence', 'Cleanup', 'Feature map', 'What cannot be driven'];

const subdirectories = (dir: string): string[] =>
    readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${dir}/${entry.name}`);

const areasOnDisk = [
    ...subdirectories('src'),
    ...subdirectories('src/features'),
    ...subdirectories('supabase/functions').filter((area) => area !== 'supabase/functions/_shared'),
].sort();

const rows = featureMapRows();

const skillHeadings = [...read(`${SKILL_DIR}/SKILL.md`).matchAll(/^## (.+)$/gm)]
    .map(([, heading = '']) => heading.trim())
    .filter((heading) => SKILL_HEADINGS.includes(heading));

describe('verify-cleffy feature map', () => {
    it('has a row for every area on disk', () => {
        const mapped = new Set(rows.map((row) => row.area));
        expect(areasOnDisk.filter((area) => !mapped.has(area))).toEqual([]);
    });

    it('names a journey and a smoke check on every row', () => {
        expect(rows.filter((row) => !row.journey || !row.smokeCheck).map((row) => row.area)).toEqual([]);
    });

    it('has no rows for areas that no longer exist', () => {
        const onDisk = new Set(areasOnDisk);
        expect(rows.filter((row) => !onDisk.has(row.area)).map((row) => row.area)).toEqual([]);
    });
});

describe('verify-cleffy SKILL.md', () => {
    it('has its sections in order', () => {
        expect(skillHeadings).toEqual(SKILL_HEADINGS);
    });
});

describe('verify-cleffy scenario copies', () => {
    const copyCommands = [
        ...read(`${SKILL_DIR}/SKILL.md`).matchAll(/^cp scripts\/qa\/drive-example\.mjs (\S+)$/gm),
    ].map(([, destination = '']) => destination);

    it('documents one copy command, into a folder git ignores', () => {
        expect(copyCommands).toHaveLength(1);
        const ignored = spawnSync('git', ['check-ignore', '-q', copyCommands[0]!.replace('<scenario>', 'probe')]);
        expect(ignored.status).toBe(0);
    });

    it('runs a copy made the documented way with the repo installed packages', () => {
        const copy = copyCommands[0]!.replace('<scenario>', `feature-map-test-${process.pid}`);
        const evidence = mkdtempSync(join(tmpdir(), 'verify-cleffy-copy-'));
        try {
            const shell = spawnSync('bash', [
                '-c',
                `mkdir -p "$(dirname "$1")" && cp scripts/qa/drive-example.mjs "$1"`,
                '_',
                copy,
            ]);
            expect(shell.status).toBe(0);
            const run = spawnSync('node', [copy], {
                encoding: 'utf8',
                timeout: 60_000,
                env: { ...process.env, CLEFFY_QA_APP_URL: 'http://127.0.0.1:9', CLEFFY_QA_EVIDENCE_DIR: evidence },
            });
            const output = `${run.stdout}${run.stderr}`;
            expect(output).not.toContain('ERR_MODULE_NOT_FOUND');
            expect(output).toContain('[drive-example]');
            expect(readdirSync(evidence)).toContain('result.json');
        } finally {
            rmSync(copy, { force: true });
            rmSync(evidence, { recursive: true, force: true });
        }
    }, 90_000);
});
