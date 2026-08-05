import { useMemo, useState } from 'react';

import { KeyboardDiagram, type PressedKey } from '@/features/fingering/diagram/KeyboardDiagram';
import { HAND_COLORS } from '@/features/fingering/diagram/keyboardLayout';
import {
    clampMidi,
    midiToName,
    type Finger,
    type NormRect,
    type RecognizedNote,
    type RecognizedRegion,
    type Staff,
} from '@/features/fingering/model';
import { buttonClassName } from '@/ui/classNames';
import { Dialog } from '@/ui/Dialog';

export interface FingeringReviewPanelProps {
    /** Seed region — vision result or an empty region for manual entry. */
    initial: RecognizedRegion;
    /** The crop the vision reading saw, for tap-to-select note markers. */
    snapshot?: { dataUrl: string; rect: NormRect } | null;
    onConfirm: (region: RecognizedRegion) => void;
    onCancel: () => void;
}

/** Fixed tap-to-enter strip range (C2–C7); the strip scrolls horizontally. */
const ENTRY_RANGE = { min: 36, max: 96 };

const FINGER_OPTIONS: Array<Finger | null> = [1, 2, 3, 4, 5, null];

/**
 * Verify/correct the notes of a selected passage before the diagram renders —
 * wrong pitches make a teaching diagram actively harmful. Also the manual
 * note-entry path (local docs, offline, AI unavailable): tap keys to add
 * notes to the selected step, then assign fingers.
 */
export const FingeringReviewPanel = ({ initial, snapshot = null, onConfirm, onCancel }: FingeringReviewPanelProps) => {
    const [region, setRegion] = useState<RecognizedRegion>(initial);
    const [selectedEvent, setSelectedEvent] = useState(() =>
        initial.notes.length > 0 ? Math.min(...initial.notes.map((n) => n.eventIndex)) : 0,
    );
    const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

    const eventIndices = useMemo(() => {
        const indices = new Set(region.notes.map((n) => n.eventIndex));
        indices.add(selectedEvent);
        return [...indices].sort((a, b) => a - b);
    }, [region.notes, selectedEvent]);

    const selectedNote = region.notes.find((n) => n.id === selectedNoteId) ?? null;

    const updateNote = (id: string, patch: Partial<RecognizedNote>) => {
        setRegion((r) => ({
            ...r,
            notes: r.notes.map((n) => {
                if (n.id !== id) {
                    return n;
                }
                const next = { ...n, ...patch };
                if (patch.midi !== undefined) {
                    next.midi = clampMidi(patch.midi);
                    next.name = midiToName(next.midi, r.keySignature);
                }
                return next;
            }),
        }));
    };

    const removeNote = (id: string) => {
        setRegion((r) => ({ ...r, notes: r.notes.filter((n) => n.id !== id) }));
        if (selectedNoteId === id) {
            setSelectedNoteId(null);
        }
    };

    /** Tap on the entry strip: toggle the key in the selected step. */
    const toggleKey = (midi: number) => {
        const existing = region.notes.find((n) => n.eventIndex === selectedEvent && n.midi === midi);
        if (existing) {
            removeNote(existing.id);
            return;
        }
        const staff: Staff = midi >= 60 ? 'upper' : 'lower';
        const note: RecognizedNote = {
            id: crypto.randomUUID(),
            midi,
            name: midiToName(midi, region.keySignature),
            staff,
            bbox: { x: 0, y: 0, w: 0, h: 0 },
            eventIndex: selectedEvent,
            annotatedFinger: null,
            fingerSource: null,
            confidence: 'high',
        };
        setRegion((r) => ({ ...r, notes: [...r.notes, note] }));
        setSelectedNoteId(note.id);
    };

    const addEvent = () => {
        const next = region.notes.length > 0 ? Math.max(...region.notes.map((n) => n.eventIndex)) + 1 : 0;
        setSelectedEvent(Math.max(next, selectedEvent + 1));
        setSelectedNoteId(null);
    };

    const swapHands = () => {
        setRegion((r) => ({
            ...r,
            handOf: { upper: r.handOf.lower, lower: r.handOf.upper },
        }));
    };

    const stripPressed: PressedKey[] = region.notes
        .filter((n) => n.eventIndex === selectedEvent)
        .map((n) => ({ midi: n.midi, finger: n.annotatedFinger, hand: region.handOf[n.staff] }));

    return (
        <Dialog label="Notes in selection" onClose={onCancel} sheet>
            <p className="mb-3 text-sm text-stone-600">
                {initial.source === 'vision'
                    ? 'Check the reading before the diagram renders — tap a marker or chip to fix a note. Amber means unsure.'
                    : 'Tap keys to enter the notes of each step — a chord is one step with several notes. Select a note to set its finger.'}
            </p>

            {snapshot ? (
                <div className="relative mb-3 overflow-hidden rounded-lg border border-stone-200 bg-white">
                    <img src={snapshot.dataUrl} alt="Selected passage" className="w-full" />
                    {region.notes.map((n) => {
                        if (n.bbox.w <= 0) {
                            return null;
                        }
                        const cx = (n.bbox.x + n.bbox.w / 2 - snapshot.rect.x) / snapshot.rect.w;
                        const cy = (n.bbox.y + n.bbox.h / 2 - snapshot.rect.y) / snapshot.rect.h;
                        if (cx < 0 || cx > 1 || cy < 0 || cy > 1) {
                            return null;
                        }
                        return (
                            <button
                                key={n.id}
                                type="button"
                                aria-label={`Select note ${n.name}`}
                                onClick={() => {
                                    setSelectedEvent(n.eventIndex);
                                    setSelectedNoteId(n.id);
                                }}
                                className={`absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/90 shadow ${
                                    selectedNoteId === n.id ? 'ring-2 ring-accent ring-offset-1' : 'opacity-75'
                                }`}
                                style={{
                                    left: `${cx * 100}%`,
                                    top: `${cy * 100}%`,
                                    backgroundColor:
                                        n.confidence === 'low' ? '#d97706' : HAND_COLORS[region.handOf[n.staff]],
                                }}
                            />
                        );
                    })}
                </div>
            ) : null}

            <div className="mb-3 flex flex-wrap items-center gap-1.5">
                {eventIndices.map((index, position) => {
                    const notes = region.notes.filter((n) => n.eventIndex === index);
                    return (
                        <button
                            key={index}
                            type="button"
                            aria-pressed={selectedEvent === index}
                            aria-label={`Step ${position + 1}`}
                            onClick={() => {
                                setSelectedEvent(index);
                                setSelectedNoteId(null);
                            }}
                            className={`rounded-lg border px-2 py-1 text-xs transition ${
                                selectedEvent === index
                                    ? 'border-accent bg-accent-soft text-accent'
                                    : 'border-stone-200 text-stone-600 hover:bg-stone-50'
                            }`}
                        >
                            {notes.length > 0
                                ? notes
                                      .map((n) => `${n.name}${n.annotatedFinger ? `·${n.annotatedFinger}` : ''}`)
                                      .join(' ')
                                : 'empty'}
                        </button>
                    );
                })}
                <button type="button" onClick={addEvent} className={buttonClassName('ghost', 'sm', 'px-2 text-xs')}>
                    + step
                </button>
            </div>

            <div className="mb-3 overflow-x-auto rounded-lg border border-stone-200 bg-stone-50 p-1.5">
                <KeyboardDiagram
                    pressed={stripPressed}
                    range={ENTRY_RANGE}
                    onKeyTap={toggleKey}
                    keySignature={region.keySignature}
                    className="h-24 min-w-[640px]"
                />
            </div>

            {region.notes.filter((n) => n.eventIndex === selectedEvent).length > 0 ? (
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                    {region.notes
                        .filter((n) => n.eventIndex === selectedEvent)
                        .sort((a, b) => a.midi - b.midi)
                        .map((n) => (
                            <button
                                key={n.id}
                                type="button"
                                aria-pressed={selectedNoteId === n.id}
                                onClick={() => setSelectedNoteId(selectedNoteId === n.id ? null : n.id)}
                                className={`rounded-lg border px-2 py-1 text-xs transition ${
                                    selectedNoteId === n.id
                                        ? 'border-accent bg-accent-soft text-accent'
                                        : n.confidence === 'low'
                                          ? 'border-amber-300 bg-amber-50 text-amber-900'
                                          : 'border-stone-200 text-stone-700 hover:bg-stone-50'
                                }`}
                            >
                                <span
                                    className="mr-1 inline-block h-2 w-2 rounded-full"
                                    style={{ backgroundColor: HAND_COLORS[region.handOf[n.staff]] }}
                                />
                                {n.name}
                                {n.annotatedFinger ? ` · ${n.annotatedFinger}` : ''}
                            </button>
                        ))}
                </div>
            ) : null}

            {selectedNote ? (
                <div className="mb-3 rounded-xl border border-stone-200 bg-stone-50 p-2.5">
                    <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm font-medium text-stone-800">{selectedNote.name}</span>
                        <button
                            type="button"
                            onClick={() => removeNote(selectedNote.id)}
                            className={buttonClassName('dangerGhost', 'sm', 'px-2 text-xs')}
                        >
                            Remove note
                        </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="flex items-center gap-1" role="group" aria-label="Finger">
                            <span className="mr-1 text-xs text-stone-500">Finger</span>
                            {FINGER_OPTIONS.map((finger) => (
                                <button
                                    key={finger ?? 'none'}
                                    type="button"
                                    aria-pressed={selectedNote.annotatedFinger === finger}
                                    aria-label={finger === null ? 'No finger' : `Finger ${finger}`}
                                    onClick={() =>
                                        updateNote(selectedNote.id, {
                                            annotatedFinger: finger,
                                            fingerSource: finger === null ? null : 'manual',
                                        })
                                    }
                                    className={`h-8 w-8 rounded-lg border text-sm transition ${
                                        selectedNote.annotatedFinger === finger
                                            ? 'border-accent bg-accent text-white'
                                            : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-100'
                                    }`}
                                >
                                    {finger ?? '∅'}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center gap-1" role="group" aria-label="Pitch">
                            <span className="mr-1 text-xs text-stone-500">Pitch</span>
                            <button
                                type="button"
                                aria-label="Semitone down"
                                onClick={() => updateNote(selectedNote.id, { midi: selectedNote.midi - 1 })}
                                className={buttonClassName('secondary', 'sm', 'px-2')}
                            >
                                −1
                            </button>
                            <button
                                type="button"
                                aria-label="Semitone up"
                                onClick={() => updateNote(selectedNote.id, { midi: selectedNote.midi + 1 })}
                                className={buttonClassName('secondary', 'sm', 'px-2')}
                            >
                                +1
                            </button>
                            <button
                                type="button"
                                aria-label="Octave down"
                                onClick={() => updateNote(selectedNote.id, { midi: selectedNote.midi - 12 })}
                                className={buttonClassName('secondary', 'sm', 'px-2')}
                            >
                                −8ᵛᵃ
                            </button>
                            <button
                                type="button"
                                aria-label="Octave up"
                                onClick={() => updateNote(selectedNote.id, { midi: selectedNote.midi + 12 })}
                                className={buttonClassName('secondary', 'sm', 'px-2')}
                            >
                                +8ᵛᵃ
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={() =>
                                updateNote(selectedNote.id, {
                                    staff: selectedNote.staff === 'upper' ? 'lower' : 'upper',
                                })
                            }
                            className={buttonClassName('secondary', 'sm')}
                        >
                            {region.handOf[selectedNote.staff] === 'R' ? 'Right hand' : 'Left hand'} ⇄
                        </button>
                    </div>
                </div>
            ) : null}

            <div className="mb-3 text-xs text-stone-500">
                Upper staff → {region.handOf.upper === 'R' ? 'right' : 'left'} hand{' '}
                <button type="button" onClick={swapHands} className={buttonClassName('ghost', 'sm', 'px-1.5 text-xs')}>
                    Swap hands
                </button>
            </div>

            <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={onCancel} className={buttonClassName('ghost', 'sm')}>
                    Cancel
                </button>
                <button
                    type="button"
                    disabled={region.notes.length === 0}
                    onClick={() => onConfirm(region)}
                    className={buttonClassName('primary', 'sm')}
                >
                    Show diagram
                </button>
            </div>
        </Dialog>
    );
};
