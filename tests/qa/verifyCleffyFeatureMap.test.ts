// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SKILL_DIR = '.claude/skills/verify-cleffy';
const SKILL_HEADINGS = ['Launch', 'Doctor', 'Drive', 'Evidence', 'Cleanup', 'Feature map', 'What cannot be driven'];

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const subdirectories = (dir: string): string[] =>
    readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${dir}/${entry.name}`);

const areasOnDisk = [
    ...subdirectories('src'),
    ...subdirectories('src/features'),
    ...subdirectories('supabase/functions').filter((area) => area !== 'supabase/functions/_shared'),
].sort();

const rows = read(`${SKILL_DIR}/feature-map.md`)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .map((line) =>
        line
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((cell) => cell.trim()),
    )
    .flatMap(([area = '', journey = '', smokeCheck = '']) => {
        const path = /^`([^`]+)`$/.exec(area)?.[1];
        return path ? [{ area: path, journey, smokeCheck }] : [];
    });

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
