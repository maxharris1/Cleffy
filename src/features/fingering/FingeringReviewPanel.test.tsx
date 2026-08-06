import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FingeringReviewPanel } from '@/features/fingering/FingeringReviewPanel';
import { emptyRegion, type RecognizedNote, type RecognizedRegion } from '@/features/fingering/model';

vi.mock('@/features/playback/auditionNotes', () => ({
    auditionNotes: vi.fn(async () => undefined),
    stopAudition: vi.fn(),
}));

import { auditionNotes } from '@/features/playback/auditionNotes';

afterEach(() => {
    cleanup();
    vi.mocked(auditionNotes).mockClear();
});

const seed = (): RecognizedRegion => emptyRegion('doc-1', 2, { x: 0.1, y: 0.1, w: 0.3, h: 0.1 });

const spanProps = {
    handSpan: 'standard' as const,
    onHandSpanChange: vi.fn(),
};

const note = (partial: Partial<RecognizedNote> & Pick<RecognizedNote, 'midi' | 'eventIndex'>): RecognizedNote => ({
    id: partial.id ?? crypto.randomUUID(),
    midi: partial.midi,
    name: partial.name ?? `n${partial.midi}`,
    staff: partial.staff ?? 'upper',
    bbox: partial.bbox ?? { x: 0, y: 0, w: 0, h: 0 },
    eventIndex: partial.eventIndex,
    annotatedFinger: partial.annotatedFinger ?? null,
    fingerSource: partial.fingerSource ?? null,
    confidence: partial.confidence ?? 'high',
});

describe('FingeringReviewPanel', () => {
    it('disables Show diagram until a note exists', () => {
        render(<FingeringReviewPanel initial={seed()} {...spanProps} onConfirm={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Show diagram' })).toBeDisabled();
    });

    it('adds a note by tapping a key and confirms with its finger', async () => {
        const user = userEvent.setup();
        const onConfirm = vi.fn();
        render(<FingeringReviewPanel initial={seed()} {...spanProps} onConfirm={onConfirm} onCancel={vi.fn()} />);

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
        render(<FingeringReviewPanel initial={seed()} {...spanProps} onConfirm={vi.fn()} onCancel={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'C4' }));
        // Now pressed — accessible name includes hand and suggested finger.
        await user.click(screen.getByRole('button', { name: 'C4, Right hand, finger 1' }));
        expect(screen.getByRole('button', { name: 'Show diagram' })).toBeDisabled();
    });

    it('sends tapped notes to the chosen hand — pitch never guesses the hand', async () => {
        const user = userEvent.setup();
        const onConfirm = vi.fn();
        render(<FingeringReviewPanel initial={seed()} {...spanProps} onConfirm={onConfirm} onCancel={vi.fn()} />);

        // A left-hand note ABOVE middle C — the old midi>=60 heuristic would
        // have mis-assigned this to the right hand.
        await user.click(screen.getByRole('button', { name: 'Left hand' }));
        await user.click(screen.getByRole('button', { name: 'C4' }));
        await user.click(screen.getByRole('button', { name: 'Show diagram' }));

        const region = onConfirm.mock.calls[0]?.[0] as RecognizedRegion;
        expect(region.notes[0]?.staff).toBe('lower');
        expect(region.handOf[region.notes[0]!.staff]).toBe('L');
    });

    it('swaps hands for the whole region', async () => {
        const user = userEvent.setup();
        const onConfirm = vi.fn();
        render(<FingeringReviewPanel initial={seed()} {...spanProps} onConfirm={onConfirm} onCancel={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'C4' }));
        await user.click(screen.getByRole('button', { name: 'Swap hands' }));
        await user.click(screen.getByRole('button', { name: 'Show diagram' }));

        const region = onConfirm.mock.calls[0]?.[0] as RecognizedRegion;
        expect(region.handOf).toEqual({ upper: 'L', lower: 'R' });
    });

    it('adds a second step and keeps notes separate', async () => {
        const user = userEvent.setup();
        const onConfirm = vi.fn();
        render(<FingeringReviewPanel initial={seed()} {...spanProps} onConfirm={onConfirm} onCancel={vi.fn()} />);

        await user.click(screen.getByRole('button', { name: 'C4' }));
        await user.click(screen.getByRole('button', { name: '+ step' }));
        await user.click(screen.getByRole('button', { name: 'E4' }));
        await user.click(screen.getByRole('button', { name: 'Show diagram' }));

        const region = onConfirm.mock.calls[0]?.[0] as RecognizedRegion;
        expect(region.notes).toHaveLength(2);
        const indices = new Set(region.notes.map((n) => n.eventIndex));
        expect(indices.size).toBe(2);
    });

    it('steps through groupings and auditions the selected chord', async () => {
        const user = userEvent.setup();
        const region: RecognizedRegion = {
            ...seed(),
            notes: [
                note({ midi: 43, name: 'G2', staff: 'lower', eventIndex: 0 }),
                note({ midi: 59, name: 'B3', eventIndex: 1 }),
                note({ midi: 62, name: 'D4', eventIndex: 1 }),
                note({ midi: 66, name: 'F#4', eventIndex: 1 }),
            ],
            source: 'omr',
        };
        render(<FingeringReviewPanel initial={region} {...spanProps} onConfirm={vi.fn()} onCancel={vi.fn()} />);

        expect(screen.getByRole('button', { name: 'Step 1' })).toHaveAttribute('aria-pressed', 'true');
        await user.click(screen.getByRole('button', { name: 'Hear this step' }));
        expect(auditionNotes).toHaveBeenCalledWith([43]);

        await user.click(screen.getByRole('button', { name: 'Step 2' }));
        expect(screen.getByRole('button', { name: 'Step 2' })).toHaveAttribute('aria-pressed', 'true');
        await user.click(screen.getByRole('button', { name: 'Hear this step' }));
        expect(auditionNotes).toHaveBeenLastCalledWith([59, 62, 66]);
    });

    it('shows suggested fingers on an unmarked triad', () => {
        const region: RecognizedRegion = {
            ...seed(),
            notes: [
                note({ id: 'c', midi: 60, name: 'C4', eventIndex: 0 }),
                note({ id: 'e', midi: 64, name: 'E4', eventIndex: 0 }),
                note({ id: 'g', midi: 67, name: 'G4', eventIndex: 0 }),
            ],
            source: 'omr',
        };
        render(<FingeringReviewPanel initial={region} {...spanProps} onConfirm={vi.fn()} onCancel={vi.fn()} />);
        // Interactive keys use hand in the label; badges still encode fingers via chip text.
        expect(screen.getByText(/C4 · 1/)).toBeInTheDocument();
        expect(screen.getByText(/E4 · 3/)).toBeInTheDocument();
        expect(screen.getByText(/G4 · 5/)).toBeInTheDocument();
    });

    it('suggests fingers for a Gymnopédie-style RH pack after redistribute', () => {
        const region: RecognizedRegion = {
            ...seed(),
            notes: [
                note({ id: 'b3', midi: 59, name: 'B3', eventIndex: 0 }),
                note({ id: 'd4', midi: 62, name: 'D4', eventIndex: 0 }),
                note({ id: 'fs4', midi: 66, name: 'F#4', eventIndex: 0 }),
                note({ id: 'fs5', midi: 78, name: 'F#5', eventIndex: 0 }),
            ],
            source: 'omr',
        };
        render(<FingeringReviewPanel initial={region} {...spanProps} onConfirm={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.queryByText(/ · \?/)).not.toBeInTheDocument();
        expect(screen.getByText(/B3 · /)).toBeInTheDocument();
        expect(screen.getByText(/F#5 · /)).toBeInTheDocument();
    });

    it('colors snapshot markers by redistributed fingering hand', () => {
        const region: RecognizedRegion = {
            ...seed(),
            notes: [
                note({
                    id: 'b3',
                    midi: 59,
                    name: 'B3',
                    staff: 'upper',
                    eventIndex: 0,
                    bbox: { x: 0.12, y: 0.12, w: 0.02, h: 0.02 },
                }),
                note({
                    id: 'd4',
                    midi: 62,
                    name: 'D4',
                    staff: 'upper',
                    eventIndex: 0,
                    bbox: { x: 0.15, y: 0.12, w: 0.02, h: 0.02 },
                }),
                note({
                    id: 'fs4',
                    midi: 66,
                    name: 'F#4',
                    staff: 'upper',
                    eventIndex: 0,
                    bbox: { x: 0.18, y: 0.12, w: 0.02, h: 0.02 },
                }),
                note({
                    id: 'fs5',
                    midi: 78,
                    name: 'F#5',
                    staff: 'upper',
                    eventIndex: 0,
                    bbox: { x: 0.21, y: 0.12, w: 0.02, h: 0.02 },
                }),
            ],
            source: 'vision',
        };
        render(
            <FingeringReviewPanel
                initial={region}
                {...spanProps}
                snapshot={{ dataUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', rect: seed().rect }}
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />,
        );
        // Melody peel sends F#5 to RH; triad to LH — markers must match keyboard, not staff.
        expect(screen.getByRole('button', { name: 'Select note F#5' })).toHaveStyle({
            backgroundColor: 'rgb(67, 56, 202)',
        });
        expect(screen.getByRole('button', { name: 'Select note B3' })).toHaveStyle({
            backgroundColor: 'rgb(22, 163, 74)',
        });
    });

    it('notifies Flow when hand size changes', async () => {
        const user = userEvent.setup();
        const onHandSpanChange = vi.fn();
        render(
            <FingeringReviewPanel
                initial={seed()}
                handSpan="standard"
                onHandSpanChange={onHandSpanChange}
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />,
        );

        await user.click(screen.getByRole('button', { name: 'large' }));
        expect(onHandSpanChange).toHaveBeenCalledWith('large');
    });
});
