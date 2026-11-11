import { readFileSync } from 'node:fs';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SwapLabel } from '@/ui/SwapLabel';

afterEach(cleanup);

const LABELS = { idle: 'Export', busy: 'Exporting…' };

describe('SwapLabel', () => {
    it('renders every label in one cell and hides all but the active one', () => {
        const { container } = render(<SwapLabel labels={LABELS} active="busy" />);
        const wrapper = container.firstElementChild as HTMLElement;
        expect(wrapper).toHaveClass('swap-label');
        expect(wrapper.children).toHaveLength(2);
        expect(screen.getByText('Export')).toHaveAttribute('aria-hidden', 'true');
        expect(screen.getByText('Exporting…')).not.toHaveAttribute('aria-hidden');
        expect(screen.getByText('Exporting…')).toHaveAttribute('data-swap-active');
    });

    it('names its button after the active label only', () => {
        const { rerender } = render(
            <button type="button">
                <SwapLabel labels={LABELS} active="idle" />
            </button>,
        );
        expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
        rerender(
            <button type="button">
                <SwapLabel labels={LABELS} active="busy" />
            </button>,
        );
        expect(screen.getByRole('button', { name: 'Exporting…' })).toBeInTheDocument();
    });

    it('keeps the same nodes across a swap, so the CSS transition retargets', () => {
        const { rerender } = render(<SwapLabel labels={LABELS} active="idle" />);
        const busy = screen.getByText('Exporting…');
        rerender(<SwapLabel labels={LABELS} active="busy" />);
        expect(screen.getByText('Exporting…')).toBe(busy);
        rerender(<SwapLabel labels={LABELS} active="idle" />);
        expect(screen.getByText('Exporting…')).toBe(busy);
        expect(busy).toHaveAttribute('aria-hidden', 'true');
    });

    it('is a polite live region unless told not to be', () => {
        const { container, rerender } = render(<SwapLabel labels={LABELS} active="idle" />);
        expect(container.firstElementChild).toHaveAttribute('aria-live', 'polite');
        rerender(<SwapLabel labels={LABELS} active="idle" live={false} />);
        expect(container.firstElementChild).not.toHaveAttribute('aria-live');
    });

    it('marks the scale variant and the alignment', () => {
        const { container } = render(<SwapLabel labels={LABELS} active="idle" scale align="start" />);
        expect(container.firstElementChild).toHaveAttribute('data-scale', 'true');
        expect(container.firstElementChild).toHaveClass('justify-items-start');
    });

    it('blurs only with motion allowed, and is a plain crossfade under reduced motion', () => {
        const css = readFileSync(`${process.cwd()}/src/index.css`, 'utf8');
        expect(css).toMatch(/\.swap-label > :not\(\[data-swap-active\]\) \{\s*opacity: 0;\s*filter: blur\(2px\);/);
        expect(css).toMatch(
            /@media \(prefers-reduced-motion: reduce\) \{\s*\.swap-label > \* \{\s*transition: opacity var\(--duration-press\)[^}]*\}\s*\.swap-label > :not\(\[data-swap-active\]\),\s*\.swap-label\[data-scale\] > :not\(\[data-swap-active\]\) \{\s*filter: none;\s*transform: none;/,
        );
    });
});
