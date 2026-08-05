import { useMemo, useState } from 'react';

import { KeyboardDiagram } from '@/features/fingering/diagram/KeyboardDiagram';
import { HAND_COLORS, snapRange } from '@/features/fingering/diagram/keyboardLayout';
import {
    buildSequences,
    mergedEventIndices,
    midiToName,
    pressedAtIndex,
    type RecognizedRegion,
} from '@/features/fingering/model';
import { buttonClassName } from '@/ui/classNames';
import { CloseIcon } from '@/ui/icons';

export interface FingeringDiagramPanelProps {
    region: RecognizedRegion;
    onEditNotes: () => void;
    onClose: () => void;
}

/**
 * Floating, non-modal card housing the keyboard diagram — the score and the
 * selection stay visible while teaching. Chords render as one step; phrases
 * step through left-to-right with ‹ › controls.
 */
export const FingeringDiagramPanel = ({ region, onEditNotes, onClose }: FingeringDiagramPanelProps) => {
    const sequences = useMemo(() => buildSequences(region), [region]);
    const steps = useMemo(() => mergedEventIndices(region), [region]);
    const [step, setStep] = useState(0);
    const current = Math.min(step, Math.max(0, steps.length - 1));

    const range = useMemo(() => {
        if (region.notes.length === 0) {
            return { min: 60, max: 72 };
        }
        const midis = region.notes.map((n) => n.midi);
        return snapRange(Math.min(...midis), Math.max(...midis));
    }, [region]);

    const eventIndex = steps[current];
    const pressed = eventIndex === undefined ? [] : pressedAtIndex(sequences, eventIndex);

    return (
        <div
            data-ui-overlay
            className="pointer-events-none absolute inset-x-0 bottom-[calc(4.5rem+var(--safe-bottom))] z-30 flex justify-center px-2 sm:bottom-6"
        >
            <div className="pointer-events-auto w-full max-w-xl rounded-2xl border border-stone-200 bg-white/95 p-3 shadow-xl backdrop-blur">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-stone-800">Fingering — p. {region.page + 1}</h3>
                    <div className="flex items-center gap-1">
                        <button type="button" onClick={onEditNotes} className={buttonClassName('ghost', 'sm')}>
                            Edit notes
                        </button>
                        <button
                            type="button"
                            aria-label="Close fingering diagram"
                            onClick={onClose}
                            className="rounded-lg p-1.5 text-stone-500 transition hover:bg-stone-100"
                        >
                            <CloseIcon size={16} />
                        </button>
                    </div>
                </div>

                <KeyboardDiagram
                    pressed={pressed}
                    range={range}
                    keySignature={region.keySignature}
                    className="w-full rounded-lg border border-stone-200 bg-stone-50"
                />

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-3 text-xs text-stone-600">
                        {(['L', 'R'] as const).map((hand) =>
                            sequences[hand] ? (
                                <span key={hand} className="flex items-center gap-1.5">
                                    <span
                                        className="h-2.5 w-2.5 rounded-full"
                                        style={{ backgroundColor: HAND_COLORS[hand] }}
                                    />
                                    {hand === 'R' ? 'Right hand' : 'Left hand'}
                                </span>
                            ) : null,
                        )}
                        {pressed.length > 0 ? (
                            <span className="tabular-nums text-stone-500">
                                {pressed
                                    .map(
                                        (p) =>
                                            `${midiToName(p.midi, region.keySignature)}·${String(p.finger ?? '?')}`,
                                    )
                                    .join('  ')}
                            </span>
                        ) : null}
                    </div>
                    {steps.length > 1 ? (
                        <div className="flex items-center gap-1.5">
                            <button
                                type="button"
                                aria-label="Previous step"
                                disabled={current === 0}
                                onClick={() => setStep(current - 1)}
                                className={buttonClassName('secondary', 'sm', 'px-2.5')}
                            >
                                ‹
                            </button>
                            <span className="text-xs tabular-nums text-stone-600">
                                {current + 1} / {steps.length}
                            </span>
                            <button
                                type="button"
                                aria-label="Next step"
                                disabled={current >= steps.length - 1}
                                onClick={() => setStep(current + 1)}
                                className={buttonClassName('secondary', 'sm', 'px-2.5')}
                            >
                                ›
                            </button>
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    );
};
