import { describe, expect, it } from 'vitest';
import {
    type ButtonSize,
    type ButtonVariant,
    buttonClassName,
    chipClassName,
    chipRowClassName,
    fieldClassName,
    menuPopupClassName,
} from './classNames';

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

const VARIANTS: readonly ButtonVariant[] = [
    'primary',
    'secondary',
    'ghost',
    'accentGhost',
    'danger',
    'dangerGhost',
    'inkPrimary',
    'inkOutline',
    'inkGhost',
];
const SIZES: readonly ButtonSize[] = ['md', 'sm'];

describe('buttonClassName', () => {
    it.each(VARIANTS.flatMap((variant) => SIZES.map((size) => [variant, size] as const)))(
        '%s %s neither transitions nor scales under reduced motion',
        (variant, size) => {
            const c = classes(buttonClassName(variant, size));
            expect(c).toContain('motion-reduce:transition-none');
            expect(c).toContain('motion-reduce:active:scale-100');
        },
    );

    it.each(SIZES)('%s is at least 44px tall', (size) => {
        expect(classes(buttonClassName('secondary', size))).toContain('min-h-11');
    });

    it('destructive text uses the reference red', () => {
        expect(classes(buttonClassName('dangerGhost'))).toContain('text-destructive');
    });
});

describe('chipClassName', () => {
    it.each([true, false])('is 34px tall with 13px sides, and a 44px target on touch (active %s)', (active) => {
        const c = classes(chipClassName(active));
        expect(c).toEqual(expect.arrayContaining(['h-[34px]', 'px-[13px]', 'pointer-coarse:hit-44']));
    });

    it('is at least 44px wide on coarse phones so its target never overlaps a neighbour', () => {
        expect(classes(chipClassName(false))).toEqual(
            expect.arrayContaining(['max-sm:pointer-coarse:min-w-11', 'justify-center']),
        );
    });
});

describe('chipRowClassName', () => {
    it('scrolls on phones, wraps from sm, and pads coarse-pointer phones so the 44px chip hit area is not clipped', () => {
        const c = classes(chipRowClassName);
        expect(c).toContain('overflow-x-auto');
        expect(c).toContain('sm:overflow-x-visible');
        expect(c).toContain('max-sm:pointer-coarse:py-[5px]');
    });
});

describe('menuPopupClassName', () => {
    it('paper is the dialog paper, not a white card', () => {
        const c = classes(menuPopupClassName('paper'));
        expect(c).toEqual(expect.arrayContaining(['bg-paper', 'dialog-paper', 'rounded-[18px]']));
        expect(c).not.toContain('bg-white');
    });

    it('white stays the stock dropdown', () => {
        expect(classes(menuPopupClassName('white'))).toEqual(expect.arrayContaining(['bg-white', 'rounded-xl']));
    });
});
