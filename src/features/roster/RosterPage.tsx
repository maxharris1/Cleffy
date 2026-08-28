import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router';

import { LimitReachedNotice } from '@/features/billing/LimitReachedNotice';
import { isLimitReachedError, type LimitReachedError } from '@/features/billing/limitErrors';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { StudentCodeCard } from '@/features/roster/StudentCodeCard';
import {
    archiveStudent,
    assignScore,
    fetchStudentTimeline,
    listAssignmentsForStudents,
    listRoster,
    provisionStudent,
    restoreStudent,
    rotateStudentCode,
    unassignScore,
    type RosterAssignment,
    type TimelineEntry,
} from '@/features/roster/rosterService';
import type { AssignmentAccess, AssignmentRow, ManagedStudentRow } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Dialog } from '@/ui/Dialog';
import { EmptyState } from '@/ui/EmptyState';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { TextField } from '@/ui/TextField';
import { MoreVerticalIcon } from '@/ui/icons';

/** A code, held only long enough to show and print it. */
interface CodeCard {
    displayName: string;
    loginCode: string;
}

/**
 * The teacher's roster.
 *
 * Renders inside LibraryShell, so it inherits the RequireRegistered gate and can
 * reach openPricing through the outlet context — which matters because the two
 * ways this page fails are "the server said no" and "your plan is full", and
 * only the second one is worth showing an upgrade for.
 *
 * The page never counts against the plan itself. A full roster is a 402 from
 * student-provision, arriving as LimitReachedError; anything the client decided
 * on its own would be a second, drifting copy of the limits.
 *
 * Whether the plan has a roster at all is a different question, and one the
 * client may answer: canManageStudents reads the server's own students limit, so
 * it cannot drift either. Personal and provisioned students get `students: 0`,
 * and for them the nav drops this page and the body offers the upgrade instead
 * of a form the server would refuse on every submission.
 */
export const RosterPage = () => {
    const { canManageStudents, openPricing } = useOutletContext<LibraryOutletContext>();

    const [students, setStudents] = useState<ManagedStudentRow[] | null>(null);
    const [assignments, setAssignments] = useState<Map<string, RosterAssignment[]>>(new Map());
    const [loadError, setLoadError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [limit, setLimit] = useState<LimitReachedError | null>(null);
    const [codeCard, setCodeCard] = useState<CodeCard | null>(null);
    const [rotateTarget, setRotateTarget] = useState<ManagedStudentRow | null>(null);
    const [archiveTarget, setArchiveTarget] = useState<ManagedStudentRow | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let mounted = true;
        void (async () => {
            try {
                const roster = await listRoster();
                if (!mounted) {
                    return;
                }
                setStudents(roster);
            } catch (err) {
                if (mounted) {
                    setStudents([]);
                    setLoadError(err instanceof Error ? err.message : 'Could not load your roster.');
                }
                return;
            }
            // Best-effort, like the library's favourites and tags: a roster with
            // no counts beside it is still a usable roster.
            try {
                const grouped = await listAssignmentsForStudents();
                if (mounted) {
                    setAssignments(grouped);
                }
            } catch {
                // Counts stay at zero; the per-student panel says so too.
            }
        })();
        return () => {
            mounted = false;
        };
    }, []);

    const reloadRoster = async () => setStudents(await listRoster());
    const reloadAssignments = async () => setAssignments(await listAssignmentsForStudents());

    /**
     * The three ways a roster action ends: it worked, the plan refused it, or it
     * broke. Only the middle one gets an upgrade prompt instead of red text.
     */
    const run = async (action: () => Promise<void>): Promise<void> => {
        setActionError(null);
        setLimit(null);
        setBusy(true);
        try {
            await action();
        } catch (err) {
            if (isLimitReachedError(err)) {
                setLimit(err);
            } else {
                setActionError(err instanceof Error ? err.message : 'Something went wrong.');
            }
        } finally {
            setBusy(false);
        }
    };

    /**
     * Resolves true when the student exists and the form should clear.
     *
     * A refusal resolves false rather than throwing: the typed notice above the
     * form is the whole message, and the name the teacher typed has to survive
     * so that upgrading and pressing Add again costs them nothing.
     */
    const addStudent = async (displayName: string, parentEmail: string): Promise<boolean> => {
        setActionError(null);
        setLimit(null);
        setBusy(true);
        try {
            const { student, loginCode } = await provisionStudent(displayName, parentEmail || undefined);
            setCodeCard({ displayName: student.displayName, loginCode });
            await reloadRoster();
            return true;
        } catch (err) {
            if (isLimitReachedError(err)) {
                setLimit(err);
                return false;
            }
            throw err;
        } finally {
            setBusy(false);
        }
    };

    const confirmRotate = async () => {
        const target = rotateTarget;
        if (!target) {
            return;
        }
        await run(async () => {
            const loginCode = await rotateStudentCode(target.id);
            setCodeCard({ displayName: target.display_name, loginCode });
        });
        setRotateTarget(null);
    };

    const confirmArchive = async () => {
        const target = archiveTarget;
        if (!target) {
            return;
        }
        await run(async () => {
            await archiveStudent(target.id);
            await reloadRoster();
        });
        setArchiveTarget(null);
    };

    const restore = (student: ManagedStudentRow) =>
        run(async () => {
            await restoreStudent(student.id);
            await reloadRoster();
        });

    /**
     * Flipping access re-runs the assignment, which overwrites everything it is
     * given — so the note and due date go back in unchanged.
     */
    const setAccess = (assignment: AssignmentRow, access: AssignmentAccess) =>
        run(async () => {
            await assignScore(
                assignment.document_id,
                assignment.student_user_id,
                access,
                assignment.note,
                assignment.due_at,
            );
            await reloadAssignments();
        });

    const unassign = (assignment: AssignmentRow) =>
        run(async () => {
            await unassignScore(assignment.document_id, assignment.student_user_id);
            await reloadAssignments();
        });

    const activeCount = students?.filter((student) => student.archived_at === null).length ?? 0;
    const archivedCount = (students?.length ?? 0) - activeCount;

    return (
        <div>
            <h1 className="font-display text-2xl font-semibold text-stone-800 sm:text-3xl">Students</h1>
            {/* The upgrade state below explains the roster in its own words —
                printing the pitch twice on the same screen just reads as noise. */}
            {canManageStudents ? (
                <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-stone-600">
                    A student signs in with a printed code — no email address, no password. Assign scores from your
                    library and their markings stay theirs.
                </p>
            ) : null}

            {/*
              The nav hides this page on a plan without a roster, but a bookmark
              or a typed URL still lands here. Say so and offer the upgrade rather
              than showing an add form whose every submission the server refuses.
            */}
            {!canManageStudents ? (
                <EmptyState
                    className="mt-10"
                    title="Your plan doesn’t include students"
                    body="Teacher and Academy add a roster: students sign in with a printed code, and you assign scores straight from your library."
                >
                    <Button onClick={openPricing}>See plans</Button>
                </EmptyState>
            ) : (
                <>
                    <AddStudentForm busy={busy} onAdd={addStudent} />

                    {limit ? <LimitReachedNotice limit={limit} onUpgrade={openPricing} className="mt-5" /> : null}
                    {actionError ? <ErrorText className="mt-4">{actionError}</ErrorText> : null}

                    {students === null ? (
                        <LoadingText className="mt-10">Loading your roster…</LoadingText>
                    ) : loadError ? (
                        <ErrorText className="mt-8">{loadError}</ErrorText>
                    ) : students.length === 0 ? (
                        <p className="mt-10 text-sm text-stone-500">
                            No students yet — add one above and print the card that comes back.
                        </p>
                    ) : (
                        <section className="mt-8">
                            <p className="text-xs text-stone-600">
                                {activeCount} {activeCount === 1 ? 'student' : 'students'}
                                {archivedCount > 0 ? ` · ${archivedCount} archived` : ''}
                            </p>
                            <ul className="mt-3">
                                {students.map((student, index) => (
                                    <StudentRow
                                        key={student.id}
                                        student={student}
                                        index={index}
                                        assignments={assignments.get(student.student_user_id) ?? []}
                                        expanded={expandedId === student.id}
                                        busy={busy}
                                        onToggle={() => setExpandedId((id) => (id === student.id ? null : student.id))}
                                        onRotate={() => setRotateTarget(student)}
                                        onArchive={() => setArchiveTarget(student)}
                                        onRestore={() => void restore(student)}
                                        onSetAccess={setAccess}
                                        onUnassign={unassign}
                                    />
                                ))}
                            </ul>
                        </section>
                    )}
                </>
            )}

            {codeCard ? (
                <Dialog label="Login card" onClose={() => setCodeCard(null)}>
                    <p className="text-sm leading-relaxed text-stone-600">
                        Print this now or write it down. The code is stored as a hash, so nothing can read it back — a
                        lost card is replaced by rotating the code, never recovered.
                    </p>
                    <StudentCodeCard
                        displayName={codeCard.displayName}
                        loginCode={codeCard.loginCode}
                        className="mt-4"
                    />
                    <div className="mt-5 flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => setCodeCard(null)}>
                            Done
                        </Button>
                        <Button size="sm" onClick={() => window.print()}>
                            Print card
                        </Button>
                    </div>
                </Dialog>
            ) : null}

            {rotateTarget ? (
                <ConfirmDialog
                    title="Rotate this login code?"
                    body={`${rotateTarget.display_name}’s current code stops working straight away, and a new card has to reach them before their next lesson. Their scores, annotations and notes are untouched.`}
                    confirmLabel="Rotate code"
                    busy={busy}
                    onConfirm={() => void confirmRotate()}
                    onCancel={() => setRotateTarget(null)}
                />
            ) : null}

            {archiveTarget ? (
                <ConfirmDialog
                    title={`Archive ${archiveTarget.display_name}?`}
                    body="Their seat frees up for another student and their login code stops working. Nothing is deleted — assignments, annotations and practice notes all stay, and restoring them brings it back exactly as it was."
                    confirmLabel="Archive"
                    busy={busy}
                    onConfirm={() => void confirmArchive()}
                    onCancel={() => setArchiveTarget(null)}
                />
            ) : null}
        </div>
    );
};

/**
 * Adds one student.
 *
 * Owns its own fields so a refused add can keep them: `onAdd` resolving false
 * means the plan is full and the typed name is still wanted, resolving true
 * means the student exists and the form should reset, and throwing means
 * something went wrong that belongs under these fields rather than above them.
 */
const AddStudentForm = ({
    busy,
    onAdd,
}: {
    busy: boolean;
    onAdd: (displayName: string, parentEmail: string) => Promise<boolean>;
}) => {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        const displayName = name.trim();
        if (!displayName) {
            setError('Enter the student’s name.');
            return;
        }
        setError(null);
        try {
            if (await onAdd(displayName, email.trim())) {
                setName('');
                setEmail('');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not add that student.');
        }
    };

    return (
        <form
            className="mt-6 rounded-2xl border border-stone-300/70 bg-white/60 p-4 sm:p-5"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <div className="grid gap-4 sm:grid-cols-2">
                <div>
                    <TextField
                        id="roster-name"
                        label="Student name"
                        size="sm"
                        value={name}
                        maxLength={80}
                        placeholder="Ada Lovelace"
                        disabled={busy}
                        onChange={(event) => setName(event.target.value)}
                    />
                </div>
                <div>
                    <TextField
                        id="roster-parent-email"
                        label="Parent email (optional)"
                        size="sm"
                        type="email"
                        value={email}
                        placeholder="parent@example.com"
                        disabled={busy}
                        onChange={(event) => setEmail(event.target.value)}
                    />
                </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-stone-500">
                    The address is for your records and for sending the card home — never the student’s own.
                </p>
                <Button type="submit" size="sm" disabled={busy}>
                    {busy ? 'Adding…' : 'Add student'}
                </Button>
            </div>
            {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}
        </form>
    );
};

const StudentRow = ({
    student,
    index,
    assignments,
    expanded,
    busy,
    onToggle,
    onRotate,
    onArchive,
    onRestore,
    onSetAccess,
    onUnassign,
}: {
    student: ManagedStudentRow;
    index: number;
    assignments: RosterAssignment[];
    expanded: boolean;
    busy: boolean;
    onToggle: () => void;
    onRotate: () => void;
    onArchive: () => void;
    onRestore: () => void;
    onSetAccess: (assignment: AssignmentRow, access: AssignmentAccess) => void;
    onUnassign: (assignment: AssignmentRow) => void;
}) => {
    const archived = student.archived_at !== null;
    const detailId = `student-detail-${student.id}`;

    return (
        <li className="library-list-item" style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}>
            <div
                className={`group border-b border-stone-300/50 transition hover:border-accent/40 ${
                    archived ? 'opacity-60' : ''
                }`}
            >
                <div className="flex items-center gap-0.5">
                    <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        onClick={onToggle}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-3.5 text-left"
                    >
                        <span aria-hidden="true" className="w-3 shrink-0 text-xs text-stone-400">
                            {expanded ? '▾' : '▸'}
                        </span>
                        <span className="truncate font-medium text-stone-800 transition group-hover:text-accent-hover">
                            {student.display_name}
                        </span>
                        {archived ? <Badge>Archived</Badge> : null}
                    </button>
                    <span className="shrink-0 px-2 text-xs text-stone-500">
                        {assignments.length === 0
                            ? 'No scores'
                            : `${assignments.length} ${assignments.length === 1 ? 'score' : 'scores'}`}
                    </span>
                    <RosterRowMenu
                        archived={archived}
                        busy={busy}
                        onRotate={onRotate}
                        onArchive={onArchive}
                        onRestore={onRestore}
                    />
                </div>

                {expanded ? (
                    <div id={detailId} className="pb-5 pl-5">
                        <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-stone-500">
                            Assigned scores
                        </h3>
                        {assignments.length === 0 ? (
                            <p className="mt-2 text-sm text-stone-500">
                                Nothing assigned yet — open a score’s menu in your library and pick “Assign to
                                student…”.
                            </p>
                        ) : (
                            <ul className="mt-2 flex flex-col gap-2">
                                {assignments.map(({ assignment, documentTitle }) => (
                                    <li
                                        key={assignment.id}
                                        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-stone-200 bg-white/70 px-3 py-2"
                                    >
                                        <Link
                                            to={`/doc/${assignment.document_id}`}
                                            className="min-w-0 flex-1 truncate text-sm font-medium text-stone-800 transition hover:text-accent-hover"
                                        >
                                            {documentTitle}
                                        </Link>
                                        {assignment.due_at ? (
                                            <span className="shrink-0 text-xs text-stone-500">
                                                Due {formatDate(assignment.due_at)}
                                            </span>
                                        ) : null}
                                        <AccessToggle
                                            value={assignment.access}
                                            disabled={busy || archived}
                                            onChange={(access) => onSetAccess(assignment, access)}
                                        />
                                        <Button
                                            variant="dangerGhost"
                                            size="sm"
                                            disabled={busy}
                                            onClick={() => onUnassign(assignment)}
                                        >
                                            Unassign
                                        </Button>
                                        {assignment.note ? (
                                            <p className="w-full text-xs leading-relaxed text-stone-600">
                                                {assignment.note}
                                            </p>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        )}

                        <StudentTimeline studentUserId={student.student_user_id} />
                    </div>
                ) : null}
            </div>
        </li>
    );
};

/** Compact edit/view switch on an existing assignment. */
const AccessToggle = ({
    value,
    disabled,
    onChange,
}: {
    value: AssignmentAccess;
    disabled: boolean;
    onChange: (access: AssignmentAccess) => void;
}) => (
    <div className="flex shrink-0 rounded-lg border border-stone-300 p-0.5">
        {(['edit', 'view'] as const).map((option) => (
            <button
                key={option}
                type="button"
                aria-pressed={value === option}
                disabled={disabled}
                onClick={() => onChange(option)}
                className={`rounded-md px-2 py-1 text-xs transition disabled:cursor-default disabled:opacity-50 ${
                    value === option ? 'bg-accent text-white' : 'text-stone-600 hover:bg-ink/5'
                }`}
            >
                {option === 'edit' ? 'Edit' : 'View'}
            </button>
        ))}
    </div>
);

/**
 * The teacher's practice journal for one student, newest lesson day first.
 *
 * Mounted only when a row is expanded, which is what makes it lazy: a roster of
 * thirty students is one query, not thirty-one.
 */
const StudentTimeline = ({ studentUserId }: { studentUserId: string }) => {
    const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;
        void (async () => {
            try {
                const rows = await fetchStudentTimeline(studentUserId);
                if (mounted) {
                    setEntries(rows);
                }
            } catch (err) {
                if (mounted) {
                    setEntries([]);
                    setError(err instanceof Error ? err.message : 'Could not load practice notes.');
                }
            }
        })();
        return () => {
            mounted = false;
        };
    }, [studentUserId]);

    return (
        <section className="mt-5">
            <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-stone-500">Practice notes</h3>
            {entries === null ? (
                <LoadingText className="mt-2 text-sm">Loading notes…</LoadingText>
            ) : error ? (
                <ErrorText className="mt-2">{error}</ErrorText>
            ) : entries.length === 0 ? (
                <p className="mt-2 text-sm text-stone-500">
                    No notes yet — write one from the score while you teach and it lands here.
                </p>
            ) : (
                <ol className="mt-2 flex flex-col gap-4">
                    {groupByDay(entries).map((day) => (
                        <li key={day.day}>
                            <p className="text-xs font-medium text-stone-500">{formatDay(day.day)}</p>
                            <ul className="mt-1.5 flex flex-col gap-1.5 border-l border-stone-300/70 pl-3">
                                {day.entries.map(({ note, documentTitle }) => (
                                    <li key={note.id}>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Link
                                                to={`/doc/${note.document_id}`}
                                                className="text-xs text-stone-500 transition hover:text-stone-700 hover:underline"
                                            >
                                                {documentTitle}
                                            </Link>
                                            <Badge tone={note.shared ? 'accent' : 'neutral'}>
                                                {note.shared ? 'Shared' : 'Private'}
                                            </Badge>
                                        </div>
                                        <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-stone-700">
                                            {note.body}
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
};

/** Row actions, following the library's menu: outside-pointer and Escape close it. */
const RosterRowMenu = ({
    archived,
    busy,
    onRotate,
    onArchive,
    onRestore,
}: {
    archived: boolean;
    busy: boolean;
    onRotate: () => void;
    onArchive: () => void;
    onRestore: () => void;
}) => {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setOpen(false);
            }
        };
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const pick = (action: () => void) => {
        setOpen(false);
        action();
    };

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Student actions"
                disabled={busy}
                onClick={() => setOpen((v) => !v)}
                className="rounded-lg p-1.5 text-stone-400 transition hover:bg-ink/5 hover:text-stone-600 disabled:opacity-50"
            >
                <MoreVerticalIcon size={16} />
            </button>
            {open ? (
                <div
                    role="menu"
                    className="absolute right-0 z-20 mt-1 w-40 rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
                >
                    {archived ? (
                        <MenuItem label="Restore" onClick={() => pick(onRestore)} />
                    ) : (
                        <>
                            <MenuItem label="Rotate code…" onClick={() => pick(onRotate)} />
                            <MenuItem label="Archive…" onClick={() => pick(onArchive)} />
                        </>
                    )}
                </div>
            ) : null}
        </div>
    );
};

const MenuItem = ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button
        type="button"
        role="menuitem"
        onClick={onClick}
        className="w-full cursor-pointer px-3 py-2 text-left text-sm text-stone-800 transition hover:bg-ink/5"
    >
        {label}
    </button>
);

/** Run-length grouping: the query already ordered by day, so runs are the groups. */
const groupByDay = (entries: TimelineEntry[]): Array<{ day: string; entries: TimelineEntry[] }> => {
    const days: Array<{ day: string; entries: TimelineEntry[] }> = [];
    for (const entry of entries) {
        const last = days[days.length - 1];
        if (last && last.day === entry.note.noted_on) {
            last.entries.push(entry);
        } else {
            days.push({ day: entry.note.noted_on, entries: [entry] });
        }
    }
    return days;
};

/** noted_on is a bare date; parsing it as UTC would shift the lesson a day west. */
const formatDay = (isoDate: string): string => {
    const date = new Date(`${isoDate}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
        return isoDate;
    }
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
};

const formatDate = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
