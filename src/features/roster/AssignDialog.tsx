import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { assignScore, listAssignmentsForStudents, listRoster } from '@/features/roster/rosterService';
import type { AssignmentAccess, ManagedStudentRow } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { EmptyState } from '@/ui/EmptyState';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { TextField } from '@/ui/TextField';
import { buttonClassName } from '@/ui/classNames';

export interface AssignDialogProps {
    documentId: string;
    documentTitle: string;
    onClose: () => void;
    /** Fires after at least one assignment landed, so the caller can refresh counts. */
    onAssigned?: () => void;
}

/**
 * Hands a score to one or more students in a single pass.
 *
 * Assigning is idempotent per (score, student) — assign_score upserts — so the
 * students who already have this score are shown ticked and disabled rather
 * than hidden: a teacher opening this wants to see the whole roster and who is
 * already on it, and re-assigning them here would silently rewrite the note and
 * due date they were given last time.
 *
 * Archived students are absent entirely. Their seat is freed and their login is
 * refused, and assign_score would reject them anyway.
 */
export const AssignDialog = ({ documentId, documentTitle, onClose, onAssigned }: AssignDialogProps) => {
    const [roster, setRoster] = useState<ManagedStudentRow[] | null>(null);
    const [assigned, setAssigned] = useState<Set<string>>(new Set());
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [access, setAccess] = useState<AssignmentAccess>('edit');
    const [note, setNote] = useState('');
    const [due, setDue] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;
        void (async () => {
            try {
                const active = (await listRoster()).filter((student) => student.archived_at === null);
                if (!mounted) {
                    return;
                }
                setRoster(active);
                const already = await assignedStudentIds(documentId);
                if (mounted) {
                    setAssigned(already);
                }
            } catch (err) {
                if (mounted) {
                    setError(err instanceof Error ? err.message : 'Could not load your roster.');
                }
            }
        })();
        return () => {
            mounted = false;
        };
    }, [documentId]);

    const toggle = (studentUserId: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(studentUserId)) {
                next.delete(studentUserId);
            } else {
                next.add(studentUserId);
            }
            return next;
        });
    };

    const submit = async () => {
        const targets = (roster ?? []).filter(
            (student) => selected.has(student.student_user_id) && !assigned.has(student.student_user_id),
        );
        if (targets.length === 0) {
            setError('Pick at least one student.');
            return;
        }

        setError(null);
        setBusy(true);
        // Sequential, not Promise.all: rosters are small, and one failure has to
        // name the student it belongs to rather than arriving as a bare rejection.
        for (const student of targets) {
            try {
                await assignScore(documentId, student.student_user_id, access, note.trim() || null, dueIsoFrom(due));
            } catch (err) {
                const reason = err instanceof Error ? err.message : 'Something went wrong.';
                setError(`Could not assign to ${student.display_name}. ${reason}`);
                setBusy(false);
                // Earlier students in the batch are already assigned; re-read so
                // the ticks tell the truth about what actually landed.
                setAssigned(await assignedStudentIds(documentId).catch(() => assigned));
                onAssigned?.();
                return;
            }
        }
        setBusy(false);
        onAssigned?.();
        onClose();
    };

    const pickedCount = (roster ?? []).filter(
        (student) => selected.has(student.student_user_id) && !assigned.has(student.student_user_id),
    ).length;

    return (
        <Dialog label="Assign to students" onClose={onClose} sheet>
            <p className="text-sm text-stone-600">
                Give “{documentTitle}” to students on your roster. They will find it waiting when they sign in with
                their code.
            </p>

            {roster === null && error ? (
                <ErrorText className="mt-4">{error}</ErrorText>
            ) : roster === null ? (
                <LoadingText className="mt-4 text-sm">Loading your roster…</LoadingText>
            ) : roster.length === 0 ? (
                <EmptyState
                    className="mt-6 mb-2"
                    title="No students yet"
                    body="Add a student and they get a printed login code — no email address, no password to remember."
                >
                    <Link to="/students" className={buttonClassName('primary', 'sm')}>
                        Add a student
                    </Link>
                </EmptyState>
            ) : (
                <>
                    <ul className="mt-4 max-h-52 overflow-auto">
                        {roster.map((student) => {
                            const already = assigned.has(student.student_user_id);
                            return (
                                <li key={student.id}>
                                    <label
                                        className={`flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition ${
                                            already ? 'text-stone-500' : 'cursor-pointer text-stone-800 hover:bg-ink/5'
                                        }`}
                                    >
                                        <input
                                            type="checkbox"
                                            className="h-4 w-4 accent-accent"
                                            checked={already || selected.has(student.student_user_id)}
                                            disabled={already || busy}
                                            onChange={() => toggle(student.student_user_id)}
                                        />
                                        <span className="min-w-0 flex-1 truncate">{student.display_name}</span>
                                        {already ? <Badge tone="accent">Assigned</Badge> : null}
                                    </label>
                                </li>
                            );
                        })}
                    </ul>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium uppercase tracking-[0.08em] text-stone-600">Access</span>
                        <div className="flex rounded-lg border border-stone-300 p-0.5">
                            {(['edit', 'view'] as const).map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    aria-pressed={access === value}
                                    onClick={() => setAccess(value)}
                                    className={`rounded-md px-3 py-1.5 text-sm transition ${
                                        access === value ? 'bg-accent text-white' : 'text-stone-600 hover:bg-ink/5'
                                    }`}
                                >
                                    {value === 'edit' ? 'Can edit' : 'View only'}
                                </button>
                            ))}
                        </div>
                    </div>
                    <p className="mt-1.5 text-xs text-stone-500">
                        {access === 'edit'
                            ? 'They can add their own fingerings and practice marks.'
                            : 'They can read and play from it, but not mark it up.'}
                    </p>

                    <div className="mt-4">
                        <TextField
                            id="assign-note"
                            label="Note (optional)"
                            size="sm"
                            value={note}
                            maxLength={280}
                            placeholder="Bars 12–24, hands separately"
                            onChange={(event) => setNote(event.target.value)}
                        />
                    </div>
                    <div className="mt-4 sm:max-w-[13rem]">
                        <TextField
                            id="assign-due"
                            label="Due date (optional)"
                            size="sm"
                            type="date"
                            value={due}
                            onChange={(event) => setDue(event.target.value)}
                        />
                    </div>

                    {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}

                    <div className="mt-5 flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
                            Cancel
                        </Button>
                        <Button size="sm" onClick={() => void submit()} disabled={busy || pickedCount === 0}>
                            {busy ? 'Assigning…' : pickedCount > 1 ? `Assign to ${pickedCount} students` : 'Assign'}
                        </Button>
                    </div>
                </>
            )}
        </Dialog>
    );
};

/**
 * Which students already hold this score.
 *
 * Read from the teacher's whole assignment map rather than a per-document
 * query: it is the same call the roster page makes, rosters are dozens of rows
 * at most, and it keeps the service surface to the one grouped read.
 */
const assignedStudentIds = async (documentId: string): Promise<Set<string>> => {
    const grouped = await listAssignmentsForStudents();
    const ids = new Set<string>();
    for (const [studentUserId, entries] of grouped) {
        if (entries.some((entry) => entry.assignment.document_id === documentId)) {
            ids.add(studentUserId);
        }
    }
    return ids;
};

/** A date input yields a local calendar day; "due" means the end of that day. */
const dueIsoFrom = (day: string): string | null => {
    if (!day) {
        return null;
    }
    const at = new Date(`${day}T23:59:59`);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
};
