import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

const stylesheets = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            return stylesheets(path);
        }
        return name.endsWith('.css') ? [path] : [];
    });

const parsed = stylesheets(SRC).map((path) => ({
    file: relative(SRC, path),
    root: postcss.parse(readFileSync(path, 'utf8')),
}));

describe('print page rules', () => {
    it('sets page margins only on named pages, so loading a stylesheet never changes how other pages print', () => {
        const unnamed = parsed.flatMap(({ file, root }) => {
            const found: string[] = [];
            root.walkAtRules('page', (rule) => {
                if (!/^[a-z][\w-]*$/i.test(rule.params.trim())) {
                    found.push(`${file}: @page ${rule.params}`.trim());
                }
            });
            return found;
        });

        expect(unnamed).toEqual([]);
    });

    it('puts a page on a named page only while a printable setup card is in the document', () => {
        const assignments = parsed.flatMap(({ file, root }) => {
            const found: { file: string; selector: string; page: string }[] = [];
            root.walkDecls('page', (decl) => {
                if (decl.parent?.type === 'rule') {
                    for (const selector of (decl.parent as postcss.Rule).selectors) {
                        found.push({ file, selector, page: decl.value });
                    }
                }
            });
            return found;
        });

        expect(assignments).not.toEqual([]);
        expect(assignments.filter(({ selector }) => !selector.includes('.student-code-card'))).toEqual([]);
    });

    it('keeps the 16 mm margin on the setup card sheet', () => {
        const cardSheet = parsed.find(({ file }) => file === 'features/roster/StudentCodeCard.css')?.root;
        const margins: Record<string, string> = {};
        cardSheet?.walkAtRules('page', (rule) => {
            rule.walkDecls('margin', (decl) => {
                margins[rule.params.trim()] = decl.value;
            });
        });
        const pages = new Set<string>();
        cardSheet?.walkDecls('page', (decl) => {
            pages.add(decl.value);
        });

        expect([...pages]).not.toEqual([]);
        for (const page of pages) {
            expect(margins[page]).toBe('16mm');
        }
    });
});
