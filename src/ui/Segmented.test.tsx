import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Segmented } from '@/ui/Segmented';

afterEach(cleanup);

const OPTIONS = [
    { value: 'day', label: 'Day' },
    { value: 'week', label: 'Week' },
    { value: 'month', label: 'Month' },
] as const;

const indicator = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-segmented-indicator]') as HTMLElement;

describe('Segmented', () => {
    it('is a named group of toggle buttons with the chosen one pressed', () => {
        render(<Segmented label="Range" value="week" options={OPTIONS} onChange={() => undefined} />);
        expect(screen.getByRole('group', { name: 'Range' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Week' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Day' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('slides one segment-wide indicator to the chosen segment', () => {
        const { container, rerender } = render(
            <Segmented label="Range" value="day" options={OPTIONS} onChange={() => undefined} />,
        );
        expect(indicator(container).style.transform).toBe('translateX(0%)');
        expect(indicator(container).style.width).toMatch(/^calc\(/);
        const node = indicator(container);
        rerender(<Segmented label="Range" value="month" options={OPTIONS} onChange={() => undefined} />);
        // The same node moves, so the transition retargets rather than restarts.
        expect(indicator(container)).toBe(node);
        expect(node.style.transform).toBe('translateX(200%)');
    });

    it('animates the slide with a transform transition, and jumps under reduced motion', () => {
        const { container } = render(
            <Segmented label="Range" value="day" options={OPTIONS} onChange={() => undefined} />,
        );
        expect(indicator(container)).toHaveClass('transition-transform', 'motion-reduce:transition-none');
    });

    it('reports the segment picked', async () => {
        const onChange = vi.fn();
        render(<Segmented label="Range" value="day" options={OPTIONS} onChange={onChange} />);
        await userEvent.click(screen.getByRole('button', { name: 'Month' }));
        expect(onChange).toHaveBeenCalledWith('month');
    });

    it('names icon segments by their label', () => {
        render(
            <Segmented
                label="View"
                value="grid"
                options={[
                    { value: 'grid', label: 'Grid view', icon: <svg /> },
                    { value: 'list', label: 'List view', icon: <svg /> },
                ]}
                onChange={() => undefined}
            />,
        );
        expect(screen.getByRole('button', { name: 'Grid view' })).toHaveAttribute('title', 'Grid view');
    });
});
