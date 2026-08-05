import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FingeringDiagramPanel } from '@/features/fingering/diagram/FingeringDiagramPanel';
import { emptyRegion, type RecognizedNote, type RecognizedRegion } from '@/features/fingering/model';

afterEach(cleanup);

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
        render(<FingeringDiagramPanel region={phrase()} canApply={false} onEditNotes={vi.fn()} onClose={vi.fn()} />);
        expect(screen.getByText('Fingering — p. 4')).toBeInTheDocument();
        expect(screen.getByLabelText('C4, finger 1')).toBeInTheDocument();
        expect(screen.getByLabelText('C3, finger 5')).toBeInTheDocument();
        expect(screen.getByText('1 / 2')).toBeInTheDocument();
    });

    it('steps through the phrase', async () => {
        const user = userEvent.setup();
        render(<FingeringDiagramPanel region={phrase()} canApply={false} onEditNotes={vi.fn()} onClose={vi.fn()} />);

        expect(screen.getByRole('button', { name: 'Previous step' })).toBeDisabled();
        await user.click(screen.getByRole('button', { name: 'Next step' }));
        expect(screen.getByText('2 / 2')).toBeInTheDocument();
        expect(screen.getByLabelText('D4, finger 2')).toBeInTheDocument();
        expect(screen.queryByLabelText('C4, finger 1')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Next step' })).toBeDisabled();
    });

    it('hides step controls for a single chord and marks unfingered notes', () => {
        const region: RecognizedRegion = {
            ...emptyRegion('doc-1', 0, { x: 0, y: 0, w: 0.5, h: 0.2 }),
            notes: [note({ midi: 60 }), note({ midi: 64, eventIndex: 0 })],
        };
        render(<FingeringDiagramPanel region={region} canApply={false} onEditNotes={vi.fn()} onClose={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Next step' })).not.toBeInTheDocument();
        expect(screen.getByLabelText('C4, finger unmarked')).toBeInTheDocument();
    });

    it('wires Edit notes and Close', async () => {
        const user = userEvent.setup();
        const onEditNotes = vi.fn();
        const onClose = vi.fn();
        render(
            <FingeringDiagramPanel region={phrase()} canApply={false} onEditNotes={onEditNotes} onClose={onClose} />,
        );
        await user.click(screen.getByRole('button', { name: 'Edit notes' }));
        expect(onEditNotes).toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Close fingering diagram' }));
        expect(onClose).toHaveBeenCalled();
    });

    it('switches to engine-suggested fingerings and applies them', async () => {
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
        render(<FingeringDiagramPanel region={region} canApply onApply={onApply} onEditNotes={vi.fn()} onClose={vi.fn()} />);

        // From-score view: all unmarked.
        expect(screen.getByLabelText('C4, finger unmarked')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Apply to score…' })).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Suggested' }));
        expect(screen.getByLabelText('C4, finger 1')).toBeInTheDocument();
        expect(screen.getByLabelText('E4, finger 3')).toBeInTheDocument();
        expect(screen.getByLabelText('G4, finger 5')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Apply to score…' }));
        expect(onApply).toHaveBeenCalledTimes(1);
        const sequences = onApply.mock.calls[0]?.[0] as Record<string, { events: unknown[] } | null>;
        expect(sequences.R?.events).toHaveLength(1);
    });

    it('pins written fingerings by default and frees them when unchecked', async () => {
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
        render(<FingeringDiagramPanel region={region} canApply={false} onEditNotes={vi.fn()} onClose={vi.fn()} />);
        await user.click(screen.getByRole('button', { name: 'Suggested' }));
        // Pinned: the written 2 survives.
        expect(screen.getByLabelText('C4, finger 2')).toBeInTheDocument();
        await user.click(screen.getByRole('checkbox', { name: 'Keep written fingerings' }));
        // Freed: the engine's canonical 1-3-5 takes over.
        expect(screen.getByLabelText('C4, finger 1')).toBeInTheDocument();
    });
});
