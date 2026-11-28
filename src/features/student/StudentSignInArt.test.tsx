import { readFileSync } from 'node:fs';

import { cleanup, render, screen } from '@testing-library/react';
import postcss from 'postcss';
import { afterEach, describe, expect, it } from 'vitest';

import { StudentSignInArt } from '@/features/student/StudentSignInArt';

const opszClasses = (): Set<string> => {
    const classes = new Set<string>();
    postcss
        .parse(readFileSync(`${process.cwd()}/src/index.css`, 'utf8'))
        .walkDecls('font-variation-settings', (decl) => {
            if (decl.value.replace(/\s+/g, ' ').trim() === "'opsz' 10" && decl.parent?.type === 'rule') {
                for (const selector of (decl.parent as postcss.Rule).selectors) {
                    const [, name] = /^\.([\w-]+)$/.exec(selector.trim()) ?? [];
                    if (name) {
                        classes.add(name);
                    }
                }
            }
        });
    return classes;
};

describe('StudentSignInArt', () => {
    afterEach(cleanup);

    it("sets the setup card's Bodoni at optical size 10, as Flow-Student does", () => {
        const classes = opszClasses();
        render(<StudentSignInArt />);

        for (const text of ['Leo Martin', 'Cleffy']) {
            const sized = [...classes].some((name) => screen.getByText(text).closest(`.${name}`));
            expect(sized, text).toBe(true);
        }
    });

    it('sets the wordmark and the teacher byline at normal line height, as Flow-Student does', () => {
        render(<StudentSignInArt />);

        expect(screen.getByText('Cleffy')).toHaveClass('leading-[normal]');
        expect(screen.getByText('From Ms. Davis')).toHaveClass('leading-[normal]');
    });
});
