import { useMemo, useState } from 'react';

import { canPlaceProposals } from '@/features/fingering/applyFingerings';
import { KeyboardDiagram } from '@/features/fingering/diagram/KeyboardDiagram';
import { HAND_COLORS, snapRange } from '@/features/fingering/diagram/keyboardLayout';
import { suggestForRegion, type HandSpan } from '@/features/fingering/engine/suggest';
import {
    buildSequences,
    mergedEventIndices,
    midiToName,
    pressedAtIndex,
    type FingeringSequence,
    type Hand,
    type RecognizedRegion,
} from '@/features/fingering/model';
import { buttonClassName } from '@/ui/classNames';
import { CloseIcon } from '@/ui/icons';

export type FingeringSource = 'annotated' | 'suggested';

export interface FingeringDiagramPanelProps {
    region: RecognizedRegion;
    /** Owner/editor on a writable doc — shows "Apply to score". */
    canApply: boolean;
    onApply?: (sequences: Record<Hand, FingeringSequence | null>) => void;
    onEditNotes: () => void;
    onClose: () => void;
}

/**
 * Floating, non-modal card housing the keyboard diagram — the score and the
 * selection stay visible while teaching. One toggle switches the populator:
 * fingerings written on the score vs. the suggestion engine; the SAME
 * KeyboardDiagram renders both. Chords are one step; phrases step through
 * left-to-right.
 */
export const FingeringDiagramPanel = ({
    region,
    canApply,
    onApply,
    onEditNotes,
    onClose,
}: FingeringDiagramPanelProps) => {
    const [source, setSource] = useState<FingeringSource>('annotated');
    const [keepWritten, setKeepWritten] = useState(true);
    const [handSpan, setHandSpan] = useState<HandSpan>('standard');
    const [step, setStep] = useState(0);

    const annotated = useMemo(() => buildSequences(region), [region]);
    const suggested = useMemo(
        () => (source === 'suggested' ? suggestForRegion(region, keepWritten, handSpan) : null),
        [source, region, keepWritten, handSpan],
    );
    const sequences = source === 'suggested' && suggested ? suggested : annotated;

    // `current` clamps rather than resetting on region edits, so a re-reviewed
    // phrase keeps (or safely truncates to) the step the teacher was on.
    const steps = useMemo(() => mergedEventIndices(region), [region]);
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
    const showApply = source === 'suggested' && canApply && onApply !== undefined && canPlaceProposals(region);

    return (
        <div
            data-ui-overlay
            className="pointer-events-none absolute inset-x-0 bottom-[calc(4.5rem+var(--safe-bottom))] z-30 flex justify-center px-2 sm:bottom-6"
        >
            <div className="pointer-events-auto w-full max-w-xl rounded-2xl border border-stone-200 bg-white/95 p-3 shadow-xl backdrop-blur">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-stone-800">Fingering — p. {region.page + 1}</h3>
                    <div className="flex items-center gap-1">
                        <div
                            role="group"
                            aria-label="Fingering source"
                            className="flex rounded-lg border border-stone-200 p-0.5 text-xs"
                        >
                            <button
                                type="button"
                                aria-pressed={source === 'annotated'}
                                onClick={() => setSource('annotated')}
                                className={`rounded-md px-2 py-1 transition ${
                                    source === 'annotated' ? 'bg-accent-soft text-accent' : 'text-stone-600'
                                }`}
                            >
                                From score
                            </button>
                            <button
                                type="button"
                                aria-pressed={source === 'suggested'}
                                onClick={() => setSource('suggested')}
                                className={`rounded-md px-2 py-1 transition ${
                                    source === 'suggested' ? 'bg-accent-soft text-accent' : 'text-stone-600'
                                }`}
                            >
                                Suggested
                            </button>
                        </div>
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

                {steps.length > 1 ? (
                    <p className="mt-1.5 text-[11px] leading-snug text-stone-500">
                        Each step shows the notes struck together — notes held from earlier steps aren't redrawn.
                    </p>
                ) : null}

                {source === 'suggested' ? (
                    <div className="mt-2 border-t border-stone-100 pt-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-3">
                                <label className="flex items-center gap-1.5 text-xs text-stone-600">
                                    <input
                                        type="checkbox"
                                        checked={keepWritten}
                                        onChange={(e) => setKeepWritten(e.target.checked)}
                                        className="h-3.5 w-3.5 accent-[--color-accent]"
                                    />
                                    Keep written fingerings
                                </label>
                                <div
                                    role="group"
                                    aria-label="Hand size"
                                    className="flex items-center gap-1 text-xs text-stone-600"
                                >
                                    <span className="text-stone-500">Hand size</span>
                                    {(['small', 'standard', 'large'] as const).map((size) => (
                                        <button
                                            key={size}
                                            type="button"
                                            aria-pressed={handSpan === size}
                                            onClick={() => setHandSpan(size)}
                                            className={`rounded-md border px-1.5 py-0.5 capitalize transition ${
                                                handSpan === size
                                                    ? 'border-accent bg-accent-soft text-accent'
                                                    : 'border-stone-200 hover:bg-stone-50'
                                            }`}
                                        >
                                            {size}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {showApply && suggested ? (
                                <button
                                    type="button"
                                    onClick={() => onApply(suggested)}
                                    className={buttonClassName('primary', 'sm')}
                                >
                                    Apply to score…
                                </button>
                            ) : null}
                        </div>
                        <p className="mt-1.5 text-[11px] leading-snug text-stone-500">
                            One good option, not the only one — editions differ, and suggestions consider only the
                            selected notes. Select through the end of a phrase so crossings land where the music
                            continues. A “?” badge means the reach exceeds the chosen hand size.
                        </p>
                    </div>
                ) : null}
            </div>
        </div>
    );
};
