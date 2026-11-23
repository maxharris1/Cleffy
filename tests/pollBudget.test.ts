import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A poll whose timeout reaches Vitest's default 5 s test limit never reports
 * its own failure: the test times out first, or, when the awaited state comes
 * late, fails a run the poll would have passed.
 */
const TEST_LIMIT_MS = 5_000;
const ROOTS = ['src', 'tests'];

const testFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return testFiles(path);
        return /\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });

const pollTimeouts = (source: string) =>
    [...source.matchAll(/(?:expect\.poll|vi\.waitFor)\([^;]*?\btimeout:\s*([\d_]+)/g)].map((m) =>
        Number(m[1]!.replaceAll('_', '')),
    );

describe('poll budgets', () => {
    it('reads the timeout of a poll', () => {
        expect(pollTimeouts('await expect.poll(() => f(), { timeout: 10_000, interval: 100 }).toEqual([]);')).toEqual([
            10_000,
        ]);
        expect(pollTimeouts('await vi.waitFor(() => g(),\n    { timeout: 900 });')).toEqual([900]);
    });

    it('keeps every poll timeout under the test limit', () => {
        const others = ROOTS.flatMap(testFiles).filter((file) => !file.endsWith('pollBudget.test.ts'));
        const over = others.flatMap((file) =>
            pollTimeouts(readFileSync(file, 'utf8'))
                .filter((ms) => ms >= TEST_LIMIT_MS)
                .map((ms) => `${relative(process.cwd(), file)}: ${ms} ms`),
        );
        expect(over).toEqual([]);
    });
});
