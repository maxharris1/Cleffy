import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignInArt } from '@/features/marketing/SignInArt';

const stubFonts = (load: () => Promise<unknown>) => {
    Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: { check: () => false, load },
    });
};

const handwriting = (container: HTMLElement) => Array.from(container.querySelectorAll('.font-hand'));

const hidden = (node: Element) => node.closest('.score-ink-pending') !== null;

describe('SignInArt handwriting', () => {
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        Reflect.deleteProperty(document, 'fonts');
    });

    it('keeps the handwriting hidden while Caveat is still loading', async () => {
        vi.useFakeTimers();
        stubFonts(() => new Promise(() => {}));
        const { container } = render(<SignInArt />);
        await act(() => vi.advanceTimersByTimeAsync(3001));
        const notes = handwriting(container);
        expect(notes).toHaveLength(3);
        expect(notes.every(hidden)).toBe(true);
    });

    it('keeps the handwriting hidden when Caveat fails to load', async () => {
        vi.useFakeTimers();
        stubFonts(() => Promise.reject(new Error('font blocked')));
        const { container } = render(<SignInArt />);
        await act(() => vi.advanceTimersByTimeAsync(3001));
        const notes = handwriting(container);
        expect(notes).toHaveLength(3);
        expect(notes.every(hidden)).toBe(true);
    });

    it('shows the handwriting once Caveat has loaded', async () => {
        stubFonts(() => Promise.resolve([]));
        const { container } = render(<SignInArt />);
        await act(async () => {});
        const notes = handwriting(container);
        expect(notes).toHaveLength(3);
        expect(notes.some(hidden)).toBe(false);
    });
});
