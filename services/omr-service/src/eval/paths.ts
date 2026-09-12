import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Package root of `cleffy-omr-service` — works from `src/eval` (vitest) and
 * `dist/eval` (the built CLI). Walks up until `package.json` names this package
 * rather than assuming a fixed depth, so a stray copy of the file still lands.
 */
export const packageRoot = (): string => {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        const pkg = join(dir, 'package.json');
        if (existsSync(pkg)) {
            try {
                const raw: unknown = JSON.parse(readFileSync(pkg, 'utf8'));
                if (
                    typeof raw === 'object' &&
                    raw !== null &&
                    'name' in raw &&
                    (raw as { name: unknown }).name === 'cleffy-omr-service'
                ) {
                    return dir;
                }
            } catch {
                // keep walking
            }
        }
        dir = dirname(dir);
    }
    throw new Error('Could not locate the omr-service package root from eval/paths');
};

/** Data root: corpus, cache, results. Sibling of `src/` / `dist/`. */
export const evalRoot = (): string => join(packageRoot(), 'eval');

export const corpusDir = (): string => join(evalRoot(), 'corpus');
export const cacheDir = (): string => join(evalRoot(), 'cache');
export const downloadsDir = (): string => join(cacheDir(), 'downloads');
export const artifactsCacheDir = (): string => join(cacheDir(), 'artifacts');
export const resultsDir = (): string => join(evalRoot(), 'results');
export const fixturesDir = (): string => join(evalRoot(), 'fixtures');
