import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router';

import { initialsOf } from '@/features/account/initials';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { ScoreThumb } from '@/features/library/ScoreThumb';
import { NotFoundPage } from '@/features/marketing/NotFoundPage';
import { persistAssignmentCount } from '@/features/roster/rosterCache';
import {
    assignScore,
    documentThumbRevs,
    listAssignmentsForStudent,
    listRoster,
    unassignScore,
    type RosterAssignment,
    type ThumbRevs,
} from '@/features/roster/rosterService';
import type { AssignmentAccess, AssignmentRow, ManagedStudentRow } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { Segmented } from '@/ui/Segmented';
import { buttonClassName } from '@/ui/classNames';
import { ArrowLeftIcon, PlusIcon } from '@/ui/icons';

type Loaded = {
    status: 'ready';
    student: ManagedStudentRow;
    assignments: RosterAssignment[];
    thumbs: Map<string, ThumbRevs>;
};

type PageState = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'missing' } | Loaded;

const ACCESS_OPTIONS = [
    { value: 'edit', label: 'Edit' },
    { value: 'view', label: 'View' },
] as const;

const formatDue = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

/** The earliest due date from today on; a due date already behind them is not "next". */
const nextDueOf = (assignments: RosterAssignment[]): string | null => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const upcoming = assignments
        .map(({ assignment }) => assignment.due_at)
        .filter((due): due is string => due !== null && new Date(due).getTime() >= startOfToday.getTime())
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    return upcoming[0] ?? null;
};

const possessive = (name: string): string => `${name}’s`;

/**
 * Only this teacher's roster is readable (managed_students' policy), so an id
 * that names nobody and an id that names another teacher's student both come
 * back absent, and both render the same not-found page.
 */
const loadStudent = async (studentId: string): Promise<Loaded | null> => {
    const student = (await listRoster()).find((row) => row.id === studentId);
    if (!student) {
        return null;
    }
    const assignments = await listAssignmentsForStudent(student.student_user_id);
    const thumbs = await documentThumbRevs(assignments.map(({ assignment }) => assignment.document_id)).catch(
        () => new Map<string, ThumbRevs>(),
    );
    return { status: 'ready', student, assignments, thumbs };
};

export const StudentDetailPage = () => {
    const { studentId = '' } = useParams();
    return <StudentPage key={studentId} studentId={studentId} />;
};

const StudentPage = ({ studentId }: { studentId: string }) => {
    const { userId } = useOutletContext<LibraryOutletContext>();
    const [state, setState] = useState<PageState>({ status: 'loading' });
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;
        loadStudent(studentId).then(
            (loaded) => {
                if (mounted) {
                    setState(loaded ?? { status: 'missing' });
                }
            },
            (err: unknown) => {
                if (mounted) {
                    setState({
                        status: 'failed',
                        message: err instanceof Error ? err.message : 'Could not load this student.',
                    });
                }
            },
        );
        return () => {
            mounted = false;
        };
    }, [studentId]);

    const commitThenRefresh = async (
        action: () => Promise<unknown>,
        apply: (rows: RosterAssignment[]) => RosterAssignment[],
    ) => {
        if (state.status !== 'ready') {
            return;
        }
        const studentUserId = state.student.student_user_id;
        setActionError(null);
        setBusy(true);
        try {
            await action();
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Something went wrong.');
            setBusy(false);
            return;
        }
        const applied = apply(state.assignments);
        setState({ ...state, assignments: applied });
        void persistAssignmentCount(userId, studentUserId, applied.length);
        try {
            const loaded = await loadStudent(studentId);
            setState(loaded ?? { status: 'missing' });
            if (loaded) {
                void persistAssignmentCount(userId, studentUserId, loaded.assignments.length);
            }
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Something went wrong.');
        } finally {
            setBusy(false);
        }
    };

    /**
     * Flipping access re-runs the assignment, which overwrites everything it is
     * given, so the note and due date go back in unchanged.
     */
    const setAccess = (assignment: AssignmentRow, access: AssignmentAccess) =>
        commitThenRefresh(
            () =>
                assignScore(
                    assignment.document_id,
                    assignment.student_user_id,
                    access,
                    assignment.note,
                    assignment.due_at,
                ),
            (rows) =>
                rows.map((row) =>
                    row.assignment.id === assignment.id ? { ...row, assignment: { ...row.assignment, access } } : row,
                ),
        );

    const unassign = (assignment: AssignmentRow) =>
        commitThenRefresh(
            () => unassignScore(assignment.document_id, assignment.student_user_id),
            (rows) => rows.filter((row) => row.assignment.id !== assignment.id),
        );

    if (state.status === 'missing') {
        return <NotFoundPage landmark="div" />;
    }

    return (
        <div className="mx-auto w-full max-w-[1200px]">
            <p className="-mt-[18px] mb-3.5 max-sm:mt-0">
                <Link
                    to="/students"
                    className="inline-flex min-h-11 items-center gap-1.5 text-[15px] font-medium text-ink-muted transition-colors hover:text-ink"
                >
                    <ArrowLeftIcon size={18} strokeWidth={1.7} />
                    Students
                </Link>
            </p>

            {state.status === 'loading' ? (
                <LoadingText className="mt-6">Loading student…</LoadingText>
            ) : state.status === 'failed' ? (
                <ErrorText className="mt-6">{state.message}</ErrorText>
            ) : state.status === 'ready' ? (
                <StudentDetail
                    {...state}
                    busy={busy}
                    actionError={actionError}
                    onSetAccess={(assignment, access) => void setAccess(assignment, access)}
                    onUnassign={(assignment) => void unassign(assignment)}
                />
            ) : null}
        </div>
    );
};

const StudentDetail = ({
    student,
    assignments,
    thumbs,
    busy,
    actionError,
    onSetAccess,
    onUnassign,
}: Loaded & {
    busy: boolean;
    actionError: string | null;
    onSetAccess: (assignment: AssignmentRow, access: AssignmentAccess) => void;
    onUnassign: (assignment: AssignmentRow) => void;
}) => {
    const archived = student.archived_at !== null;
    const nextDue = nextDueOf(assignments);
    const count = assignments.length;

    return (
        <>
            <header className="flex flex-wrap items-center justify-between gap-x-8 gap-y-[18px] border-b border-hairline pb-8">
                <div className="flex min-w-0 items-center gap-5 max-sm:gap-4">
                    <span
                        aria-hidden="true"
                        className="grid size-20 shrink-0 place-items-center rounded-full bg-blue-600 text-[28px] font-semibold text-white shadow-[0_0_0_2px_var(--color-paper)]"
                    >
                        {initialsOf(student.display_name)}
                    </span>
                    <div className="min-w-0 [overflow-wrap:anywhere]">
                        <h1 className="display-opsz text-balance font-display text-[44px] font-semibold leading-[1.02] tracking-[-0.02em] text-ink sm:text-[60px]">
                            {student.display_name}
                        </h1>
                        <p className="mt-3 text-base text-ink-soft">
                            {[
                                student.username ? `@${student.username}` : null,
                                `${count} ${count === 1 ? 'score' : 'scores'}`,
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                            {nextDue ? (
                                <>
                                    {' · next due '}
                                    <span className="text-ink shadow-[inset_0_-0.52em_0_var(--color-highlighter)]">
                                        {formatDue(nextDue)}
                                    </span>
                                </>
                            ) : null}
                        </p>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2.5">
                    <Link to="/library" className={buttonClassName('primary')}>
                        <PlusIcon size={17} strokeWidth={1.7} />
                        Assign a score
                    </Link>
                </div>
            </header>

            <section className="mt-10 min-w-0 lg:max-w-[796px]">
                <h2 className="display-opsz text-balance font-display text-[30px] font-semibold leading-[1.15] tracking-[-0.01em] text-ink">
                    {possessive(student.display_name)} scores
                </h2>
                {actionError ? <ErrorText className="mt-4">{actionError}</ErrorText> : null}
                {count === 0 ? (
                    <p className="mt-4 text-sm text-ink-muted">
                        Nothing assigned yet. Open a score’s menu in your library and pick “Assign to student…”.
                    </p>
                ) : (
                    <ul className="mt-[18px] border-b border-hairline">
                        {assignments.map(({ assignment, documentTitle }) => (
                            <AssignmentItem
                                key={assignment.id}
                                assignment={assignment}
                                title={documentTitle}
                                thumb={thumbs.get(assignment.document_id)}
                                disabled={busy || archived}
                                busy={busy}
                                onSetAccess={onSetAccess}
                                onUnassign={onUnassign}
                            />
                        ))}
                    </ul>
                )}
            </section>
        </>
    );
};

const AssignmentItem = ({
    assignment,
    title,
    thumb,
    disabled,
    busy,
    onSetAccess,
    onUnassign,
}: {
    assignment: AssignmentRow;
    title: string;
    thumb: ThumbRevs | undefined;
    disabled: boolean;
    busy: boolean;
    onSetAccess: (assignment: AssignmentRow, access: AssignmentAccess) => void;
    onUnassign: (assignment: AssignmentRow) => void;
}) => {
    const href = `/doc/${assignment.document_id}`;
    return (
        <li className="flex flex-wrap items-center gap-x-5 gap-y-3.5 border-t border-hairline py-4">
            <Link to={href} tabIndex={-1} aria-hidden="true" className="block w-[72px] shrink-0">
                <ScoreThumb
                    docId={assignment.document_id}
                    contentRev={thumb?.contentRev ?? 0}
                    thumbRev={thumb?.thumbRev ?? null}
                    frameClassName="aspect-[1275/1650] w-[72px] rounded-[3px] shadow-[0_0_0_1px_rgb(28_25_23/0.1)]"
                />
            </Link>
            <div className="min-w-0 flex-[1_1_260px]">
                <Link
                    to={href}
                    className="text-[17px] font-semibold text-ink [overflow-wrap:anywhere] transition-colors hover:text-accent-hover max-sm:inline-flex max-sm:min-h-11 max-sm:items-center pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                >
                    {title}
                </Link>
                {assignment.due_at ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <Badge tone="warn">Due {formatDue(assignment.due_at)}</Badge>
                    </div>
                ) : null}
                {assignment.note ? (
                    <p className="mt-2 text-sm leading-[1.45] text-ink-soft [overflow-wrap:anywhere]">
                        {assignment.note}
                    </p>
                ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <fieldset disabled={disabled} className="contents disabled:[&_button]:opacity-50">
                    <Segmented
                        label={`Access for ${title}`}
                        value={assignment.access}
                        options={ACCESS_OPTIONS}
                        onChange={(access) => onSetAccess(assignment, access)}
                    />
                </fieldset>
                <Link to={href} className={buttonClassName('secondary')}>
                    Open
                </Link>
                <Button variant="dangerGhost" disabled={busy} onClick={() => onUnassign(assignment)}>
                    Unassign
                </Button>
            </div>
        </li>
    );
};
