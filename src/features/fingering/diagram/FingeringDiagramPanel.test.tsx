import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FingeringDiagramPanel } from '@/features/fingering/diagram/FingeringDiagramPanel';
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

const spanProps = {
    handSpan: 'standard' as const,
    onHandSpanChange: vi.fn(),
};

const note = (overrides: Partial<RecognizedNote>): RecognizedNote => ({
    id: crypto.randomUUID(),
    midi: 60,
    name: 'C4',
    staff: 'upper',
    bbox: { x: 0, y: 0, w: 0, h: 0 },
    eventIndex: 0,
    annotatedFinger: null,
    fingerSource: null,
    confidence: 'high',
    ...overrides,
});

const phrase = (): RecognizedRegion => ({
    ...emptyRegion('doc-1', 3, { x: 0, y: 0, w: 0.5, h: 0.2 }),
    notes: [
        note({ midi: 60, eventIndex: 0, annotatedFinger: 1 }),
        note({ midi: 62, eventIndex: 1, annotatedFinger: 2 }),
        note({ midi: 48, staff: 'lower', eventIndex: 0, annotatedFinger: 5 }),
    ],
});

describe('FingeringDiagramPanel', () => {
    it('shows the page number and the first step, both hands', () => {
        render(<FingeringDiagramPanel region={phrase()} canApply={false} {...spanProps} onEditNotes={vi.fn()} onClose={vi.fn()} />);
        expect(screen.getByText('Fingering — p. 4')).toBeInTheDocument();
        expect(screen.getByLabelText('C4, Right hand, finger 1')).toBeInTheDocument();
        expect(screen.getByLabelText('C3, Left hand, finger 5')).toBeInTheDocument();
        expect(screen.getByText('1 / 2')).toBeInTheDocument();
    });

    it('steps through the phrase', async () => {
        const user = userEvent.setup();
        render(<FingeringDiagramPanel region={phrase()} canApply={false} {...spanProps} onEditNotes={vi.fn()} onClose={vi.fn()} />);

        expect(screen.getByRole('button', { name: 'Previous step' })).toBeDisabled();
        await user.click(screen.getByRole('button', { name: 'Next step' }));
        expect(screen.getByText('2 / 2')).toBeInTheDocument();
        expect(screen.getByLabelText('D4, Right hand, finger 2')).toBeInTheDocument();
        expect(screen.queryByLabelText('C4, Right hand, finger 1')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Next step' })).toBeDisabled();
    });

    it('hides step controls for a single chord', () => {
        const region: RecognizedRegion = {
            ...emptyRegion('doc-1', 0, { x: 0, y: 0, w: 0.5, h: 0.2 }),
            notes: [note({ midi: 60 }), note({ midi: 64, eventIndex: 0 })],
        };
        render(<FingeringDiagramPanel region={region} canApply={false} {...spanProps} onEditNotes={vi.fn()} onClose={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Next step' })).not.toBeInTheDocument();
        // No written digits → Suggested is the only mode (engine fingers the dyad).
        expect(screen.queryByRole('button', { name: 'From score' })).not.toBeInTheDocument();
        expect(screen.getByText('Suggested')).toBeInTheDocument();
        expect(screen.getByLabelText('C4, Right hand, finger 1')).toBeInTheDocument();
        expect(screen.getByLabelText('E4, Right hand, finger 3')).toBeInTheDocument();
    });

    it('wires Edit notes and Close', async () => {
        const user = userEvent.setup();
        const onEditNotes = vi.fn();
        const onClose = vi.fn();
        render(
            <FingeringDiagramPanel region={phrase()} canApply={false} {...spanProps} onEditNotes={onEditNotes} onClose={onClose} />,
        );
        await user.click(screen.getByRole('button', { name: 'Edit notes' }));
        expect(onEditNotes).toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Close fingering diagram' }));
        expect(onClose).toHaveBeenCalled();
    });

    it('auditions the current step from the Hear control', async () => {
        const user = userEvent.setup();
        render(<FingeringDiagramPanel region={phrase()} canApply={false} {...spanProps} onEditNotes={vi.fn()} onClose={vi.fn()} />);
        await user.click(screen.getByRole('button', { name: 'Hear this step' }));
        expect(auditionNotes).toHaveBeenCalledWith(expect.arrayContaining([60, 48]));
        await user.click(screen.getByRole('button', { name: 'Next step' }));
        await user.click(screen.getByRole('button', { name: 'Hear this step' }));
        expect(auditionNotes).toHaveBeenLastCalledWith([62]);
    });

    it('defaults to Suggested and skips the From-score toggle when nothing is annotated', async () => {
        const user = userEvent.setup();
        const onApply = vi.fn();
        // Unmarked C-E-G chord with page anchors → engine suggests 1-3-5.
        const region: RecognizedRegion = {
            ...emptyRegion('doc-1', 0, { x: 0, y: 0, w: 0.5, h: 0.2 }),
            notes: [
                note({ midi: 60, bbox: { x: 0.2, y: 0.4, w: 0.015, h: 0.01 } }),
                note({ midi: 64, bbox: { x: 0.2, y: 0.39, w: 0.015, h: 0.01 } }),
                note({ midi: 67, bbox: { x: 0.2, y: 0.38, w: 0.015, h: 0.01 } }),
            ],
            source: 'vision',
        };
        render(<FingeringDiagramPanel region={region} canApply {...spanProps} onApply={onApply} onEditNotes={vi.fn()} onClose={vi.fn()} />);

        expect(screen.queryByRole('button', { name: 'From score' })).not.toBeInTheDocument();
        expect(screen.getByLabelText('C4, Right hand, finger 1')).toBeInTheDocument();
        expect(screen.getByLabelText('E4, Right hand, finger 3')).toBeInTheDocument();
        expect(screen.getByLabelText('G4, Right hand, finger 5')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Apply to score…' })).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Apply to score…' }));
        expect(onApply).toHaveBeenCalledTimes(1);
        const sequences = onApply.mock.calls[0]?.[0] as Record<string, { events: unknown[] } | null>;
        expect(sequences.R?.events).toHaveLength(1);
    });

    it('shows From score when digits are annotated, and pins them in Suggested', async () => {
        const user = userEvent.setup();
        // A written 2 on C of a C-E-G chord is not what the engine would pick.
        const region: RecognizedRegion = {
            ...emptyRegion('doc-1', 0, { x: 0, y: 0, w: 0.5, h: 0.2 }),
            notes: [
                note({ midi: 60, annotatedFinger: 2, fingerSource: 'vision' }),
                note({ midi: 64 }),
                note({ midi: 67 }),
            ],
            source: 'vision',
        };
        render(<FingeringDiagramPanel region={region} canApply={false} {...spanProps} onEditNotes={vi.fn()} onClose={vi.fn()} />);
        // Defaults to Suggested (matches review preview); From score is available.
        expect(screen.getByRole('button', { name: 'Suggested' })).toHaveAttribute('aria-pressed', 'true');
        // Pinned: the written 2 survives under Keep written.
        expect(screen.getByLabelText('C4, Right hand, finger 2')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'From score' }));
        expect(screen.getByLabelText('C4, Right hand, finger 2')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Suggested' }));
        await user.click(screen.getByRole('checkbox', { name: 'Keep written fingerings' }));
        // Freed: the engine's canonical 1-3-5 takes over.
        expect(screen.getByLabelText('C4, Right hand, finger 1')).toBeInTheDocument();
    });

    it('surfaces redistributed hands for an unplayable RH pack', () => {
        const region: RecognizedRegion = {
            ...emptyRegion('doc-1', 0, { x: 0, y: 0, w: 0.5, h: 0.2 }),
            notes: [
                note({ id: 'b3', midi: 59, name: 'B3' }),
                note({ id: 'd4', midi: 62, name: 'D4' }),
                note({ id: 'fs4', midi: 66, name: 'F#4' }),
                note({ id: 'fs5', midi: 78, name: 'F#5' }),
            ],
            source: 'omr',
        };
        render(<FingeringDiagramPanel region={region} canApply={false} {...spanProps} onEditNotes={vi.fn()} onClose={vi.fn()} />);
        expect(screen.getByText('Left hand')).toBeInTheDocument();
        expect(screen.getByText('Right hand')).toBeInTheDocument();
        expect(screen.getByText(/moved to left hand for reach/i)).toBeInTheDocument();
        // All four notes get real fingers (no unmarked badges on the keys).
        expect(screen.queryByLabelText(/finger unmarked/)).not.toBeInTheDocument();
    });

    it('shows Option picker when the engine returns distinct alternates', () => {
        const region: RecognizedRegion = {
            ...emptyRegion('doc-1', 0, { x: 0, y: 0, w: 0.5, h: 0.2 }),
            notes: [
                note({ midi: 60, eventIndex: 0 }),
                note({ midi: 62, eventIndex: 1 }),
                note({ midi: 64, eventIndex: 2 }),
                note({ midi: 65, eventIndex: 3 }),
                note({ midi: 67, eventIndex: 4 }),
                note({ midi: 69, eventIndex: 5 }),
                note({ midi: 71, eventIndex: 6 }),
                note({ midi: 72, eventIndex: 7 }),
            ],
            source: 'omr',
        };
        render(<FingeringDiagramPanel region={region} canApply={false} {...spanProps} onEditNotes={vi.fn()} onClose={vi.fn()} />);
        expect(screen.getByRole('group', { name: 'Suggestion option' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument();
    });
});
