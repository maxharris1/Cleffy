import { afterEach, describe, expect, it, vi } from 'vitest';

import { refuseInput, shake } from '@/lib/shake';

const reduceMotion = (reduce: boolean) =>
    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({ matches: reduce && query.includes('reduce'), media: query })),
    );

const animatable = () => {
    const el = document.createElement('div');
    const animation = { finished: Promise.resolve() } as unknown as Animation;
    const animate = vi.fn(() => animation);
    Object.defineProperty(el, 'animate', { value: animate });
    return { el, animate, animation };
};

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('shake', () => {
    it('runs a 280ms decaying translateX shake on the ease-out curve', () => {
        reduceMotion(false);
        const { el, animate, animation } = animatable();
        expect(shake(el)).toBe(animation);
        expect(animate).toHaveBeenCalledWith(
            [
                { transform: 'translateX(0)' },
                { transform: 'translateX(-6px)' },
                { transform: 'translateX(5px)' },
                { transform: 'translateX(-3px)' },
                { transform: 'translateX(2px)' },
                { transform: 'translateX(0)' },
            ],
            { duration: 280, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
        );
    });

    it('restarts for a second refusal', () => {
        reduceMotion(false);
        const { el, animate } = animatable();
        shake(el);
        shake(el);
        expect(animate).toHaveBeenCalledTimes(2);
    });

    it('does not move under reduced motion', () => {
        reduceMotion(true);
        const { el, animate } = animatable();
        expect(shake(el)).toBeNull();
        expect(animate).not.toHaveBeenCalled();
    });

    it('is a no-op without an element or Web Animations', () => {
        reduceMotion(false);
        expect(shake(null)).toBeNull();
        const plain = document.createElement('div');
        Object.defineProperty(plain, 'animate', { value: undefined });
        expect(shake(plain)).toBeNull();
    });
});

describe('refuseInput', () => {
    it('shakes the wrapper, then focuses the field with its text selected', () => {
        reduceMotion(false);
        const { el: wrapper, animate } = animatable();
        const input = document.createElement('input');
        input.value = 'ABCD-EFGH';
        wrapper.append(input);
        document.body.append(wrapper);

        refuseInput(wrapper, input);

        expect(animate).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(input);
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe('ABCD-EFGH'.length);
    });

    it('still refocuses and selects under reduced motion', () => {
        reduceMotion(true);
        const { el: wrapper, animate } = animatable();
        const input = document.createElement('input');
        input.value = '123456';
        wrapper.append(input);
        document.body.append(wrapper);

        refuseInput(wrapper, input);

        expect(animate).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(input);
        expect(input.selectionEnd).toBe(6);
    });
});
