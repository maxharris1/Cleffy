import { readFileSync } from 'node:fs';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoverImage } from '@/features/library/CoverImage';
import { resetShownCoversForTests } from '@/features/library/shownCovers';

/** jsdom has no HTMLImageElement.decode: stand one in that the test resolves. */
const stubDecode = () => {
    let finish: () => void = () => undefined;
    const decode = vi.fn(
        () =>
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
    );
    Object.defineProperty(HTMLImageElement.prototype, 'decode', { value: decode, configurable: true, writable: true });
    return { decode, finish: () => act(async () => finish()) };
};

const placeholder = <p>engraved placeholder</p>;

beforeEach(() => {
    resetShownCoversForTests();
});

afterEach(() => {
    cleanup();
    delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
});

describe('CoverImage', () => {
    it('stays transparent over the placeholder until the image has decoded, then fades in', async () => {
        const { decode, finish } = stubDecode();
        const { container } = render(<CoverImage src="blob:a" cacheKey="d1:0:" placeholder={placeholder} />);
        const img = container.querySelector('img') as HTMLImageElement;

        expect(img).toHaveClass('cover-fade');
        expect(img).not.toHaveAttribute('data-loaded');
        expect(img).not.toHaveAttribute('data-settled');
        expect(screen.getByText('engraved placeholder')).toBeInTheDocument();
        expect(decode).toHaveBeenCalledTimes(1);

        await finish();
        expect(img).toHaveAttribute('data-loaded');
        // Still underneath while the fade runs, gone once it has finished.
        expect(screen.getByText('engraved placeholder')).toBeInTheDocument();
        fireEvent.transitionEnd(img, { propertyName: 'opacity' });
        expect(screen.queryByText('engraved placeholder')).not.toBeInTheDocument();
    });

    it('shows a cover this page has shown before at once, without the fade', async () => {
        const { finish } = stubDecode();
        const first = render(<CoverImage src="blob:a" cacheKey="d1:0:" placeholder={placeholder} />);
        await finish();
        first.unmount();

        // Library → score → back: the same cover, settled.
        const { container } = render(<CoverImage src="blob:b" cacheKey="d1:0:" placeholder={placeholder} />);
        const img = container.querySelector('img') as HTMLImageElement;
        expect(img).toHaveAttribute('data-loaded');
        expect(img).toHaveAttribute('data-settled');
        expect(screen.queryByText('engraved placeholder')).not.toBeInTheDocument();
    });

    it('still fades in a cover that was unmounted before it decoded', () => {
        stubDecode();
        const first = render(<CoverImage src="blob:a" cacheKey="d1:0:" placeholder={placeholder} />);
        first.unmount();

        // Never revealed, so never seen: no skipping the fade on the way back.
        const { container } = render(<CoverImage src="blob:b" cacheKey="d1:0:" placeholder={placeholder} />);
        const img = container.querySelector('img') as HTMLImageElement;
        expect(img).not.toHaveAttribute('data-settled');
        expect(img).not.toHaveAttribute('data-loaded');
        expect(screen.getByText('engraved placeholder')).toBeInTheDocument();
    });

    it('does not count a decode that lands after unmount as shown', async () => {
        const { finish } = stubDecode();
        const first = render(<CoverImage src="blob:a" cacheKey="d1:0:" />);
        first.unmount();
        await finish();

        const { container } = render(<CoverImage src="blob:b" cacheKey="d1:0:" />);
        expect(container.querySelector('img')).not.toHaveAttribute('data-settled');
    });

    it('fades a new revision of a score in again', async () => {
        const { finish } = stubDecode();
        const first = render(<CoverImage src="blob:a" cacheKey="d1:0:" />);
        await finish();
        first.unmount();

        const { container } = render(<CoverImage src="blob:b" cacheKey="d1:1:" />);
        expect(container.querySelector('img')).not.toHaveAttribute('data-settled');
    });

    it('reveals a cover that fails to decode rather than hiding it forever', async () => {
        Object.defineProperty(HTMLImageElement.prototype, 'decode', {
            value: () => Promise.reject(new Error('EncodingError')),
            configurable: true,
            writable: true,
        });
        const { container } = render(<CoverImage src="blob:a" cacheKey="d2:0:" />);
        await act(async () => undefined);
        expect(container.querySelector('img')).toHaveAttribute('data-loaded');
    });

    it('fades on opacity alone, and only quicker under reduced motion', () => {
        const css = readFileSync(`${process.cwd()}/src/index.css`, 'utf8');
        expect(css).toMatch(/\.cover-fade \{\s*opacity: 0;\s*transition: opacity 200ms var\(--ease-out\);\s*\}/);
        expect(css).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\s*\.cover-fade \{\s*transition-duration: var\(--duration-exit\);/,
        );
    });
});
