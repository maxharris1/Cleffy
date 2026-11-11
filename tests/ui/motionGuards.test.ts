import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Motion guards. A bare `transition` (Tailwind's or CSS's `all`) animates
 * whatever happens to change — layout, a box-shadow, a colour switched on
 * purpose to be instant — and costs paint on every hover. Every transition
 * names the properties it means to animate; easing comes from the @theme
 * tokens in src/index.css rather than one-off curves.
 */

const SRC = resolve(process.cwd(), 'src');

const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
    });

const files = walk(SRC);
const sources = files.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
const styles = files.filter((f) => f.endsWith('.css'));

/** Lines of code, comments dropped (prose may say "transition"). */
const codeLines = (path: string) =>
    readFileSync(path, 'utf8')
        .split('\n')
        .map((text, i) => ({ text, line: i + 1 }))
        .filter(({ text }) => !/^\s*(\*|\/\/|\/\*)/.test(text));

describe('motion guards', () => {
    it('uses no bare `transition` or `transition-all` utility', () => {
        const offenders: string[] = [];
        for (const file of sources) {
            for (const { text, line } of codeLines(file)) {
                if (/(?<=["'` ])transition(-all)?(?=["'` ])/.test(text)) {
                    offenders.push(`${relative(SRC, file)}:${line}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('names the properties in every CSS transition', () => {
        const offenders: string[] = [];
        for (const file of styles) {
            const css = readFileSync(file, 'utf8');
            for (const match of css.matchAll(/transition\s*:\s*([^;]+);/g)) {
                const value = (match[1] ?? '').trim();
                if (value === 'none') {
                    continue;
                }
                const entries = value.split(',').map((part) => part.trim().split(/\s+/)[0] ?? '');
                if (entries.some((property) => property === 'all' || /^[\d.]+m?s$/.test(property))) {
                    offenders.push(`${relative(SRC, file)}: transition: ${value}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it('takes its easing from the theme tokens', () => {
        const css = readFileSync(join(SRC, 'index.css'), 'utf8');
        const curves = [...css.matchAll(/cubic-bezier\([^)]*\)/g)].length;
        // Only the token definitions themselves.
        expect(curves).toBe(2);
        expect(css).toMatch(/--ease-out:\s*cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
        expect(css).toMatch(/--ease-drawer:\s*cubic-bezier\(0\.32, 0\.72, 0, 1\)/);
    });
});
