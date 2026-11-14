import { describe, expect, it } from 'vitest';
import { fieldClassName } from './classNames';

const classes = (s: string) => s.split(/\s+/);

describe('fieldClassName width', () => {
    it('fills the row by default', () => {
        expect(classes(fieldClassName('sm'))).toContain('w-full');
        expect(classes(fieldClassName('sm'))).not.toContain('w-auto');
    });

    it('auto width carries no w-full', () => {
        const c = classes(fieldClassName('sm', 'shrink-0', { width: 'auto' }));
        expect(c).toContain('w-auto');
        expect(c).toContain('shrink-0');
        expect(c).not.toContain('w-full');
    });

    it('inline size never gets a width class', () => {
        const c = classes(fieldClassName('inline'));
        expect(c).not.toContain('w-full');
        expect(c).not.toContain('w-auto');
    });
});
