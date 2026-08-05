import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FingeringReviewPanel } from '@/features/fingering/FingeringReviewPanel';
import { emptyRegion, type RecognizedRegion } from '@/features/fingering/model';

afterEach(cleanup);

const seed = (): RecognizedRegion => emptyRegion('doc-1', 2, { x: 0.1, y: 0.1, w: 0.3, h: 0.1 });

describe('FingeringReviewPanel', () => {
    it('disables Show diagram until a note exists', () => {
        render(<FingeringReviewPanel initial={seed()} onConfirm={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Show diagram' })).toBeDisabled();
    });

    it('adds a note by tapping a key and confirms with its finger', async () => {
        const user = userEvent.setup();
        const onConfirm = vi.fn();
        render(<FingeringReviewPanel initial={seed()} onConfirm={onConfirm} onCancel={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'C4' }));
        await user.click(screen.getByRole('button', { name: 'Finger 3' }));
        await user.click(screen.getByRole('button', { name: 'Show diagram' }));

        expect(onConfirm).toHaveBeenCalledTimes(1);
        const region = onConfirm.mock.calls[0]?.[0] as RecognizedRegion;
        expect(region.notes).toHaveLength(1);
        expect(region.notes[0]?.midi).toBe(60);
        expect(region.notes[0]?.staff).toBe('upper');
        expect(region.notes[0]?.annotatedFinger).toBe(3);
        expect(region.notes[0]?.fingerSource).toBe('manual');
    });

    it('toggles a note off when its key is tapped again', async () => {
        const user = userEvent.setup();
        render(<FingeringReviewPanel initial={seed()} onConfirm={vi.fn()} onCancel={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'C4' }));
        // Now pressed — accessible name includes the hand.
        await user.click(screen.getByRole('button', { name: 'C4, Right hand' }));
        expect(screen.getByRole('button', { name: 'Show diagram' })).toBeDisabled();
    });

    it('swaps hands for the whole region', async () => {
        const user = userEvent.setup();
        const onConfirm = vi.fn();
        render(<FingeringReviewPanel initial={seed()} onConfirm={onConfirm} onCancel={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'C4' }));
        await user.click(screen.getByRole('button', { name: 'Swap hands' }));
        await user.click(screen.getByRole('button', { name: 'Show diagram' }));

        const region = onConfirm.mock.calls[0]?.[0] as RecognizedRegion;
        expect(region.handOf).toEqual({ upper: 'L', lower: 'R' });
    });

    it('adds a second step and keeps notes separate', async () => {
        const user = userEvent.setup();
        const onConfirm = vi.fn();
        render(<FingeringReviewPanel initial={seed()} onConfirm={onConfirm} onCancel={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'C4' }));
        await user.click(screen.getByRole('button', { name: '+ step' }));
        await user.click(screen.getByRole('button', { name: 'E4' }));
        await user.click(screen.getByRole('button', { name: 'Show diagram' }));

        const region = onConfirm.mock.calls[0]?.[0] as RecognizedRegion;
        expect(region.notes).toHaveLength(2);
        const indices = new Set(region.notes.map((n) => n.eventIndex));
        expect(indices.size).toBe(2);
    });
});
