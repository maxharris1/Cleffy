import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface FeatureMapRow {
    area: string;
    journey: string;
    smokeCheck: string;
}

export const SKILL_DIR = '.claude/skills/verify-cleffy';

export const readRepoFile = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

export const featureMapRows = (): FeatureMapRow[] =>
    readRepoFile(`${SKILL_DIR}/feature-map.md`)
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

export const functionRows = (): (FeatureMapRow & { name: string })[] =>
    featureMapRows().flatMap((row) => {
        const name = /^supabase\/functions\/([^/]+)$/.exec(row.area)?.[1];
        return name ? [{ ...row, name }] : [];
    });
