import { useEffect, useMemo, useState } from 'react';

import {
    createNote,
    deleteNote,
    listNoteRecipients,
    listNotes,
    todayIsoDate,
    updateNote,
    type NoteRecipient,
} from '@/features/notes/notesService';
import type { PracticeNoteRow, PracticeNoteUpdate } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Dialog } from '@/ui/Dialog';
import { EmptyState } from '@/ui/EmptyState';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { fieldClassName, fieldLabelClassName } from '@/ui/classNames';
import { MoreVerticalIcon } from '@/ui/icons';

export type NotesRole = 'owner' | 'member';

export interface NotesPanelProps {
    documentId: string;
    /** 'owner' opens the journal; every other member gets the shared notes, read-only. */
    role: NotesRole;
    onClose: () => void;
}

/**
 * The practice journal for one score.
 *
 * Organized by lesson day rather than as a thread: a teacher looking at this in
 * week nine wants "what did we do on the 14th", not a scroll of messages. The
 * date headings are the spine, the composer writes into whichever day it is set
 * to, and back-dating a note files it under that day rather than at the top.
 *
 * A student (or any non-owner member) sees the same panel with the shared notes
 * only and nothing to press — the journal is the teacher's, and sharing a line
 * from it is always a deliberate act.
 */
export const NotesPanel = ({ documentId, role, onClose }: NotesPanelProps) => {
    const isOwner = role === 'owner';

    const [notes, setNotes] = useState<PracticeNoteRow[] | null>(null);
    const [recipients, setRecipients] = useState<NoteRecipient[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const [draft, setDraft] = useState('');
    const [notedOn, setNotedOn] = useState(todayIsoDate);
    const [shareDraft, setShareDraft] = useState(false);
    const [recipientId, setRecipientId] = useState<string | null>(null);

    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editBody, setEditBody] = useState('');
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;
        void (async () => {
            try {
                const [rows, people] = await Promise.all([
                    listNotes(documentId),
                    // Only the owner composes, and only the owner may read the roster.
                    isOwner ? listNoteRecipients(documentId) : Promise.resolve<NoteRecipient[]>([]),
                ]);
                if (mounted) {
                    setNotes(rows);
                    setRecipients(people);
                    setRecipientId(people[0]?.studentUserId ?? null);
                }
            } catch (err) {
                if (mounted) {
                    setNotes([]);
                    setError(err instanceof Error ? err.message : 'Could not load practice notes.');
                }
            }
        })();
        return () => {
            mounted = false;
        };
    }, [documentId, isOwner]);

    /**
     * The read-only mode shows shared notes, whoever is asking. RLS already hands
     * a student nothing else, but stating it here means the mode's contract does
     * not depend on which policy happened to match.
     */
    const visible = useMemo(() => (notes ?? []).filter((note) => isOwner || note.shared), [notes, isOwner]);
    const days = useMemo(() => groupByDay(visible), [visible]);

    const save = async () => {
        const body = draft.trim();
        if (!body) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const created = await createNote(documentId, body, notedOn, shareDraft, recipientId);
            setNotes((prev) => sortNotes([created, ...(prev ?? [])]));
            setDraft('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not save that note.');
        } finally {
            setBusy(false);
        }
    };

    const patchNote = async (id: string, patch: PracticeNoteUpdate) => {
        setBusy(true);
        setError(null);
        try {
            const updated = await updateNote(id, patch);
            setNotes((prev) => sortNotes((prev ?? []).map((note) => (note.id === id ? updated : note))));
            setEditingId((current) => (current === id ? null : current));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not update that note.');
        } finally {
            setBusy(false);
        }
    };

    const remove = async (id: string) => {
        setBusy(true);
        setError(null);
        try {
            await deleteNote(id);
            setNotes((prev) => (prev ?? []).filter((note) => note.id !== id));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not delete that note.');
        } finally {
            setBusy(false);
            setConfirmDeleteId(null);
        }
    };

    // Naming the reader only helps when there is more than one of them.
    const recipientLabel = (studentUserId: string | null): string | null => {
        if (!studentUserId || recipients.length < 2) {
            return null;
        }
        return recipients.find((person) => person.studentUserId === studentUserId)?.displayName ?? null;
    };

    const soleRecipient = recipients.length === 1 ? recipients[0] : undefined;

    return (
        <Dialog label="Practice notes" onClose={onClose} sheet>
            {isOwner ? (
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                    className="rounded-xl border border-stone-200/80 bg-paper/60 p-3"
                >
                    <label htmlFor="practice-note-body" className={fieldLabelClassName}>
                        New note
                    </label>
                    <textarea
                        id="practice-note-body"
                        rows={3}
                        value={draft}
                        disabled={busy}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder="What to practise before the next lesson…"
                        className={fieldClassName('sm', 'mt-1.5 resize-y')}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <div className="w-44">
                            <label htmlFor="practice-note-date" className="sr-only">
                                Lesson day
                            </label>
                            <input
                                id="practice-note-date"
                                type="date"
                                value={notedOn}
                                disabled={busy}
                                onChange={(event) => setNotedOn(event.target.value || todayIsoDate())}
                                className={fieldClassName('sm')}
                            />
                        </div>
                        <Button
                            type="submit"
                            size="sm"
                            disabled={busy || draft.trim().length === 0}
                            className="ml-auto"
                        >
                            {busy ? 'Saving…' : 'Save'}
                        </Button>
                    </div>
                    {/*
                      Asked whether or not the note is being shared: who a note is
                      about is fixed at write time and can never be changed after,
                      so guessing it silently would decide, unasked, who could one
                      day read the note.
                    */}
                    {recipients.length > 1 ? (
                        <div className="mt-2.5">
                            <label htmlFor="practice-note-student" className={fieldLabelClassName}>
                                About
                            </label>
                            <select
                                id="practice-note-student"
                                value={recipientId ?? ''}
                                disabled={busy}
                                onChange={(event) => setRecipientId(event.target.value || null)}
                                className={fieldClassName('sm', 'mt-1.5')}
                            >
                                {recipients.map((person) => (
                                    <option key={person.studentUserId} value={person.studentUserId}>
                                        {person.displayName}
                                    </option>
                                ))}
                            </select>
                        </div>
                    ) : null}
                    <label className="mt-2.5 flex items-center gap-2.5 text-sm text-stone-600">
                        <input
                            type="checkbox"
                            checked={shareDraft}
                            disabled={busy || recipients.length === 0}
                            onChange={(event) => setShareDraft(event.target.checked)}
                            className="size-4 shrink-0 rounded border-stone-300 text-accent focus:ring-accent"
                        />
                        <span>{soleRecipient ? `Visible to ${soleRecipient.displayName}` : 'Visible to student'}</span>
                    </label>
                    {recipients.length === 0 ? (
                        <p className="mt-1 text-xs text-stone-500">
                            Assign this score to a student to share notes with them.
                        </p>
                    ) : null}
                </form>
            ) : (
                <p className="-mt-2 text-xs text-stone-500">Notes your teacher has shared with you.</p>
            )}

            {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}

            <div className="mt-4">
                {notes === null ? (
                    <LoadingText className="text-sm">Loading…</LoadingText>
                ) : visible.length === 0 ? (
                    isOwner ? (
                        <p className="text-sm text-stone-600">
                            Nothing written down yet. The first note you save starts this score&apos;s journal.
                        </p>
                    ) : (
                        <EmptyState
                            title="No notes from your teacher yet."
                            body="Anything they write for you about this piece will show up here."
                            className="py-4"
                        />
                    )
                ) : (
                    days.map((day) => (
                        <section key={day.day} className="mt-5 first:mt-0">
                            <h3 className={fieldLabelClassName}>{formatDay(day.day)}</h3>
                            <ul className="mt-2 flex flex-col gap-2">
                                {day.notes.map((note) => (
                                    <li key={note.id} className="rounded-xl border border-stone-200/80 px-3 py-2.5">
                                        <div className="flex items-start gap-2">
                                            <div className="min-w-0 flex-1">
                                                {editingId === note.id ? (
                                                    <>
                                                        <label
                                                            htmlFor={`practice-note-edit-${note.id}`}
                                                            className="sr-only"
                                                        >
                                                            Edit note
                                                        </label>
                                                        <textarea
                                                            id={`practice-note-edit-${note.id}`}
                                                            rows={3}
                                                            value={editBody}
                                                            disabled={busy}
                                                            onChange={(event) => setEditBody(event.target.value)}
                                                            className={fieldClassName('sm', 'resize-y')}
                                                        />
                                                        <div className="mt-2 flex justify-end gap-2">
                                                            <Button
                                                                variant="ghost"
                                                                size="sm"
                                                                disabled={busy}
                                                                onClick={() => setEditingId(null)}
                                                                className="px-2.5 py-1"
                                                            >
                                                                Cancel
                                                            </Button>
                                                            <Button
                                                                size="sm"
                                                                disabled={busy || editBody.trim().length === 0}
                                                                onClick={() =>
                                                                    void patchNote(note.id, { body: editBody.trim() })
                                                                }
                                                                className="px-2.5 py-1"
                                                            >
                                                                Save
                                                            </Button>
                                                        </div>
                                                    </>
                                                ) : (
                                                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-800">
                                                        {note.body}
                                                    </p>
                                                )}
                                                {note.shared ? (
                                                    <div className="mt-1.5 flex items-center gap-1.5">
                                                        <Badge tone="accent">Shared</Badge>
                                                        {recipientLabel(note.student_user_id) ? (
                                                            <span className="text-xs text-stone-500">
                                                                {recipientLabel(note.student_user_id)}
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                ) : null}
                                            </div>
                                            {isOwner ? (
                                                <button
                                                    type="button"
                                                    aria-label="Note actions"
                                                    aria-expanded={menuFor === note.id}
                                                    onClick={() =>
                                                        setMenuFor((current) => (current === note.id ? null : note.id))
                                                    }
                                                    className="rounded-lg p-1.5 text-stone-500 transition hover:bg-ink/5"
                                                >
                                                    <MoreVerticalIcon size={16} />
                                                </button>
                                            ) : null}
                                        </div>

                                        {/*
                                          The actions open inline rather than as a floating menu: this
                                          dialog scrolls (sheet), and an absolutely-positioned popover
                                          would be clipped by its own overflow container.
                                        */}
                                        {isOwner && menuFor === note.id ? (
                                            <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-stone-100 pt-2">
                                                {note.student_user_id ? (
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            void patchNote(note.id, { shared: !note.shared })
                                                        }
                                                        className="px-2.5 py-1"
                                                    >
                                                        {note.shared ? 'Hide from student' : 'Make visible to student'}
                                                    </Button>
                                                ) : (
                                                    // student_user_id is immutable by design, so a note written
                                                    // with nobody named can never be shared with anyone.
                                                    <span className="px-2.5 py-1 text-xs text-stone-500">
                                                        Not addressed to a student
                                                    </span>
                                                )}
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    disabled={busy}
                                                    onClick={() => {
                                                        setEditingId(note.id);
                                                        setEditBody(note.body);
                                                        setMenuFor(null);
                                                    }}
                                                    className="px-2.5 py-1"
                                                >
                                                    Edit
                                                </Button>
                                                <Button
                                                    variant="dangerGhost"
                                                    size="sm"
                                                    disabled={busy}
                                                    onClick={() => setConfirmDeleteId(note.id)}
                                                    className="px-2.5 py-1"
                                                >
                                                    Delete
                                                </Button>
                                            </div>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))
                )}
            </div>

            {confirmDeleteId ? (
                <ConfirmDialog
                    title="Delete this note?"
                    body="It will be removed from the journal, and from the student's view if it was shared. This cannot be undone."
                    confirmLabel="Delete"
                    danger
                    busy={busy}
                    onConfirm={() => void remove(confirmDeleteId)}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            ) : null}
        </Dialog>
    );
};

/** Newest lesson day first, newest note within the day first — the service's order. */
const sortNotes = (notes: PracticeNoteRow[]): PracticeNoteRow[] =>
    [...notes].sort((a, b) =>
        a.noted_on === b.noted_on ? b.created_at.localeCompare(a.created_at) : b.noted_on.localeCompare(a.noted_on),
    );

/** Runs of the same noted_on, in the order they arrive (so it inherits sortNotes' order). */
const groupByDay = (notes: PracticeNoteRow[]): Array<{ day: string; notes: PracticeNoteRow[] }> => {
    const days: Array<{ day: string; notes: PracticeNoteRow[] }> = [];
    for (const note of notes) {
        const current = days[days.length - 1];
        if (current && current.day === note.noted_on) {
            current.notes.push(note);
        } else {
            days.push({ day: note.noted_on, notes: [note] });
        }
    }
    return days;
};

const formatDay = (isoDate: string): string => {
    if (isoDate === todayIsoDate()) {
        return 'Today';
    }
    const [year, month, day] = isoDate.split('-').map(Number);
    if (!year || !month || !day) {
        return isoDate;
    }
    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
};
