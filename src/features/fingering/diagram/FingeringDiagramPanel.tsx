import { useMemo, useState } from 'react';

import { canPlaceProposals } from '@/features/fingering/applyFingerings';
import { KeyboardDiagram } from '@/features/fingering/diagram/KeyboardDiagram';
import { HAND_COLORS, snapRange } from '@/features/fingering/diagram/keyboardLayout';
import type { HandSpan } from '@/features/fingering/engine/span';
import { suggestForRegionDetailed } from '@/features/fingering/engine/suggest';
import { HandSpanToggle } from '@/features/fingering/HandSpanToggle';
import {
    buildSequences,
    mergedEventIndices,
    midiToName,
    pressedAtIndex,
    type FingeringSequence,
    type Hand,
    type RecognizedRegion,
} from '@/features/fingering/model';
import { StepHearBar } from '@/features/fingering/StepHearBar';
import { SuggestOptionToggle } from '@/features/fingering/SuggestOptionToggle';
import { useAuditionChord } from '@/features/fingering/useAuditionChord';
import { buttonClassName } from '@/ui/classNames';
import { CloseIcon } from '@/ui/icons';

export type FingeringSource = 'annotated' | 'suggested';

const SUGGEST_TOP_K = 3;

export interface FingeringDiagramPanelProps {
    region: RecognizedRegion;
    /** Owner/editor on a writable doc — shows "Apply to score". */
    canApply: boolean;
    /** Flow-owned hand size — shared with review. */
    handSpan: HandSpan;
    onHandSpanChange: (span: HandSpan) => void;
    onApply?: (sequences: Record<Hand, FingeringSequence | null>) => void;
    onEditNotes: () => void;
    onClose: () => void;
}

/**
 * Floating, non-modal card housing the keyboard diagram — the score and the
 * selection stay visible while teaching. One toggle switches the populator:
 * fingerings written on the score vs. the suggestion engine; the SAME
 * KeyboardDiagram renders both. "From score" is hidden when nothing is
 * annotated. Chords are one step; phrases step through left-to-right.
 */
export const FingeringDiagramPanel = ({
    region,
    canApply,
    handSpan,
    onHandSpanChange,
    onApply,
    onEditNotes,
    onClose,
}: FingeringDiagramPanelProps) => {
    const hasAnnotated = region.notes.some((n) => n.annotatedFinger !== null);
    // Review always previews suggestions — open on Suggested so redistribution
    // and live digits match what the teacher just verified. "From score" remains
    // one tap away when written digits exist.
    const [source, setSource] = useState<FingeringSource>('suggested');
    const [keepWritten, setKeepWritten] = useState(true);
    const [step, setStep] = useState(0);
    const [optionIndex, setOptionIndex] = useState(0);
    const { hearing, hear } = useAuditionChord();

    const effectiveSource: FingeringSource = hasAnnotated ? source : 'suggested';

    const annotated = useMemo(() => buildSequences(region), [region]);
    const suggestion = useMemo(
        () =>
            effectiveSource === 'suggested'
                ? suggestForRegionDetailed(region, keepWritten && hasAnnotated, handSpan, { k: SUGGEST_TOP_K })
                : null,
        [effectiveSource, region, keepWritten, hasAnnotated, handSpan],
    );

    const optionCount = suggestion ? 1 + suggestion.alternatives.length : 1;
    const selectedOption = Math.min(optionIndex, optionCount - 1);
    const selectedSequences =
        suggestion && selectedOption > 0
            ? (suggestion.alternatives[selectedOption - 1]?.sequences ?? suggestion.sequences)
            : suggestion?.sequences;
    const sequences =
        effectiveSource === 'suggested' && selectedSequences ? selectedSequences : annotated;

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
    const showApply =
        effectiveSource === 'suggested' && canApply && onApply !== undefined && canPlaceProposals(region);

    const movedForReach = useMemo(() => {
        if (!suggestion || eventIndex === undefined) {
            return null;
        }
        const moved = region.notes.filter(
            (n) => n.eventIndex === eventIndex && suggestion.movedNoteIds.includes(n.id),
        );
        if (moved.length === 0) {
            return null;
        }
        const byHand: Record<Hand, string[]> = { L: [], R: [] };
        for (const n of moved) {
            const hand = suggestion.fingeringHand.get(n.id);
            if (hand) {
                byHand[hand].push(midiToName(n.midi, region.keySignature));
            }
        }
        const parts: string[] = [];
        if (byHand.L.length > 0) {
            parts.push(`${byHand.L.join('·')} moved to left hand for reach`);
        }
        if (byHand.R.length > 0) {
            parts.push(`${byHand.R.join('·')} moved to right hand for reach`);
        }
        return parts.length > 0 ? `${parts.join('; ')}. Edit notes to reassign.` : null;
    }, [suggestion, eventIndex, region]);

    const hearStep = () => hear(pressed.map((p) => p.midi));

    return (
        <div
            data-ui-overlay
            className="pointer-events-none absolute inset-x-0 bottom-[calc(4.5rem+var(--safe-bottom))] z-30 flex justify-center px-2 sm:bottom-6"
        >
            <div className="pointer-events-auto w-full max-w-xl rounded-2xl border border-stone-200 bg-white/95 p-3 shadow-xl backdrop-blur">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-stone-800">Fingering — p. {region.page + 1}</h3>
                    <div className="flex items-center gap-1">
                        {hasAnnotated ? (
                            <div
                                role="group"
                                aria-label="Fingering source"
                                className="flex rounded-lg border border-stone-200 p-0.5 text-xs"
                            >
                                <button
                                    type="button"
                                    aria-pressed={effectiveSource === 'annotated'}
                                    onClick={() => setSource('annotated')}
                                    className={`rounded-md px-2 py-1 transition ${
                                        effectiveSource === 'annotated'
                                            ? 'bg-accent-soft text-accent'
                                            : 'text-stone-600'
                                    }`}
                                >
                                    From score
                                </button>
                                <button
                                    type="button"
                                    aria-pressed={effectiveSource === 'suggested'}
                                    onClick={() => setSource('suggested')}
                                    className={`rounded-md px-2 py-1 transition ${
                                        effectiveSource === 'suggested'
                                            ? 'bg-accent-soft text-accent'
                                            : 'text-stone-600'
                                    }`}
                                >
                                    Suggested
                                </button>
                            </div>
                        ) : (
                            <span className="rounded-md bg-accent-soft px-2 py-1 text-xs text-accent">Suggested</span>
                        )}
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
                    showMissingFinger={effectiveSource === 'suggested'}
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
                    <div className="flex items-center gap-1.5">
                        <StepHearBar
                            step={
                                steps.length > 1
                                    ? {
                                          current,
                                          total: steps.length,
                                          onPrev: () => setStep(current - 1),
                                          onNext: () => setStep(current + 1),
                                      }
                                    : undefined
                            }
                            hearing={hearing}
                            hearDisabled={pressed.length === 0}
                            onHear={hearStep}
                        />
                    </div>
                </div>

                {steps.length > 1 ? (
                    <p className="mt-1.5 text-[11px] leading-snug text-stone-500">
                        Each step shows the notes struck together — notes held from earlier steps aren't redrawn.
                    </p>
                ) : null}

                {movedForReach ? (
                    <p className="mt-1.5 text-[11px] leading-snug text-amber-800">{movedForReach}</p>
                ) : null}

                {effectiveSource === 'suggested' ? (
                    <div className="mt-2 border-t border-stone-100 pt-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-3">
                                {hasAnnotated ? (
                                    <label className="flex items-center gap-1.5 text-xs text-stone-600">
                                        <input
                                            type="checkbox"
                                            checked={keepWritten}
                                            onChange={(e) => setKeepWritten(e.target.checked)}
                                            className="h-3.5 w-3.5 accent-[--color-accent]"
                                        />
                                        Keep written fingerings
                                    </label>
                                ) : null}
                                <HandSpanToggle value={handSpan} onChange={onHandSpanChange} />
                                <SuggestOptionToggle
                                    count={optionCount}
                                    value={selectedOption}
                                    onChange={setOptionIndex}
                                />
                            </div>
                            {showApply && selectedSequences ? (
                                <button
                                    type="button"
                                    onClick={() => onApply(selectedSequences)}
                                    className={buttonClassName('primary', 'sm')}
                                >
                                    Apply to score…
                                </button>
                            ) : null}
                        </div>
                        <p className="mt-1.5 text-[11px] leading-snug text-stone-500">
                            One good option, not the only one — editions differ
                            {optionCount > 1 ? '; try Option 2/3 for nearby alternatives' : ''}. Suggestions
                            consider only the selected notes. Select through the end of a phrase so crossings
                            land where the music continues. A “?” badge means the reach exceeds the chosen hand
                            size.
                        </p>
                    </div>
                ) : null}
            </div>
        </div>
    );
};
