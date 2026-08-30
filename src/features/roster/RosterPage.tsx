import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router';

import { LimitReachedNotice } from '@/features/billing/LimitReachedNotice';
import { LimitReachedError, isLimitReachedError } from '@/features/billing/limitErrors';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { StudentCodeCard } from '@/features/roster/StudentCodeCard';
import {
    archiveStudent,
    assignScore,
    fetchStudentTimeline,
    listAssignmentsForStudents,
    listRoster,
    provisionStudent,
    resetStudentAccess,
    restoreStudent,
    unassignScore,
    type ProvisionOptions,
    type RosterAssignment,
    type TimelineEntry,
} from '@/features/roster/rosterService';
import { getDb } from '@/sync/db';
import type { AssignmentAccess, AssignmentRow, EffectiveTier, ManagedStudentRow } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Dialog } from '@/ui/Dialog';
import { EmptyState } from '@/ui/EmptyState';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { TextField } from '@/ui/TextField';
import { fieldLabelClassName } from '@/ui/classNames';
import { MoreVerticalIcon } from '@/ui/icons';

/** A code, held only long enough to show and print it. */
interface CodeCard {
    displayName: string;
    loginCode: string;
    /** Only on a reset for a student who already claimed one. */
    username: string | null;
}

/**
 * The identifier a student actually types, or null while there is nothing to
 * type yet — an unclaimed code student has a card and no username.
 */
const identifierOf = (student: ManagedStudentRow): string | null => {
    if (student.auth_method === 'email') {
        return student.student_email;
    }
    return student.username ? `@${student.username}` : null;
};

/**
 * What "fix their access" is called for this row.
 *
 * One action underneath, three names: replacing a card that never got used, and
 * taking a password away from someone who has been signing in with it, are the
 * same call and very different things to do to a child. The label has to say
 * which one the teacher is about to do.
 */
const resetLabelFor = (student: ManagedStudentRow): string => {
    if (student.auth_method === 'email') {
        return 'Email a new sign-in link…';
    }
    return student.claimed_at === null ? 'New setup code…' : 'Reset access…';
};

const resetPromptFor = (student: ManagedStudentRow): { title: string; body: string; confirmLabel: string } => {
    if (student.auth_method === 'email') {
        return {
            title: 'Email a new sign-in link?',
            body: `${student.display_name}’s current password stops working straight away, and the link lets them choose a new one. Their scores, annotations and notes are untouched.`,
            confirmLabel: 'Send link',
        };
    }
    if (student.claimed_at === null) {
        return {
            title: 'Issue a new setup code?',
            body: `${student.display_name} has not set up their account yet. The code on their old card stops working straight away, so the new card has to reach them before their next lesson.`,
            confirmLabel: 'New code',
        };
    }
    return {
        title: 'Reset this student’s access?',
        body: `${student.display_name}’s password stops working straight away, and the new setup code is how they choose another one. They keep their username, and their scores, annotations and notes are untouched.`,
        confirmLabel: 'Reset access',
    };
};

/**
 * The refusal the server would give, said before it is asked.
 *
 * A teacher who downgrades keeps every student they provisioned, so the rows stay
 * reachable — but the plan behind them no longer carries a roster, and the
 * sentence saying so is already written, for the 402 an add comes back with.
 * Borrowing it leaves one wording where two could drift apart.
 */
const noRosterOnThisPlan = (tier: EffectiveTier): LimitReachedError =>
    new LimitReachedError({
        code: 'limit_reached',
        metric: 'students',
        limit: 0,
        // 'student' is provisioned rather than bought, so it is no BillingTier;
        // one who lands here is spending the free plan's limits.
        tier: tier === 'student' ? 'free' : tier,
    });

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
 * and for them the nav drops this page and the add form goes with it, because
 * the server would refuse every submission.
 *
 * It does not take the roster itself away. A downgrade bans nobody: the students
 * already provisioned keep signing in, and archiving one is how a teacher stops
 * that — which student-provision allows on any plan, archiving being what hands a
 * seat back rather than claims one. Hiding those rows would leave live student
 * sign-ins with no control left anywhere that could turn them off.
 */
export const RosterPage = () => {
    const { userId, canManageStudents, tier, openPricing } = useOutletContext<LibraryOutletContext>();

    const [students, setStudents] = useState<ManagedStudentRow[] | null>(null);
    const [assignments, setAssignments] = useState<Map<string, RosterAssignment[]>>(new Map());
    /**
     * Counts from the Dexie snapshot, shown until the network's assignments
     * arrive (then null). Without them every cached row would read "No scores"
     * — an affirmative claim the cache can't back.
     */
    const [cachedCounts, setCachedCounts] = useState<Map<string, number> | null>(null);
    /**
     * Whether `assignments` reflects the server. While 'loading' a row with a
     * snapshot count shows a spinner in its panel; after 'failed' it must show
     * a terminal notice instead — nothing on this mount will fill the panel.
     */
    const [assignmentsStatus, setAssignmentsStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
    const [loadError, setLoadError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [limit, setLimit] = useState<LimitReachedError | null>(null);
    const [codeCard, setCodeCard] = useState<CodeCard | null>(null);
    const [invitedEmail, setInvitedEmail] = useState<string | null>(null);
    const [resetTarget, setResetTarget] = useState<ManagedStudentRow | null>(null);
    const [archiveTarget, setArchiveTarget] = useState<ManagedStudentRow | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let mounted = true;
        void (async () => {
            // Names first — assignment counts fill in with the network response.
            const cached = await getDb().rosterCache.get(userId).catch(() => undefined);
            if (mounted && cached && cached.students.length > 0) {
                setStudents(cached.students);
                setCachedCounts(new Map(cached.assignmentCounts));
            }

            try {
                // null, not an empty map, on failure: an empty map is a claim
                // ("no assignments") the page would repeat in every row.
                const [roster, grouped] = await Promise.all([
                    listRoster(),
                    listAssignmentsForStudents().catch(() => null),
                ]);
                if (!mounted) {
                    return;
                }
                setStudents(roster);
                setAssignments(grouped ?? new Map());
                setAssignmentsStatus(grouped ? 'ready' : 'failed');
                if (grouped) {
                    setCachedCounts(null);
                }
                setLoadError(null);
                const assignmentCounts: Array<[string, number]> = grouped
                    ? [...grouped.entries()].map(([id, rows]) => [id, rows.length])
                    : (cached?.assignmentCounts ?? []);
                void getDb()
                    .rosterCache.put({
                        userId,
                        students: roster,
                        assignmentCounts,
                        cachedAt: new Date().toISOString(),
                    })
                    .catch(() => undefined);
            } catch (err) {
                if (mounted) {
                    setStudents((prev) => prev ?? []);
                    setAssignmentsStatus('failed');
                    setLoadError(err instanceof Error ? err.message : 'Could not load your roster.');
                }
            }
        })();
        return () => {
            mounted = false;
        };
    }, [userId]);

    const reloadRoster = async () => setStudents(await listRoster());
    const reloadAssignments = async () => {
        setAssignments(await listAssignmentsForStudents());
        setAssignmentsStatus('ready');
        setCachedCounts(null);
    };

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
    const addStudent = async (displayName: string, opts: ProvisionOptions): Promise<boolean> => {
        setActionError(null);
        setLimit(null);
        setBusy(true);
        try {
            const result = await provisionStudent(displayName, opts);
            if ('loginCode' in result) {
                setCodeCard({ displayName: result.student.displayName, loginCode: result.loginCode, username: null });
            } else {
                setInvitedEmail(result.studentEmail);
            }
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

    /**
     * Reload after a reset, not just after a create: the row that comes back is
     * Invited again, and a badge still reading Active would be describing a
     * password that stopped working a second ago.
     */
    const confirmReset = async () => {
        const target = resetTarget;
        if (!target) {
            return;
        }
        await run(async () => {
            const result = await resetStudentAccess(target.id);
            // Take the confirmation down in the same commit the card goes up,
            // rather than after the reload below. Dialog neither portals nor
            // ranks its scrims, so while both are mounted the confirmation is
            // painted over the code — and Escape, which Dialog routes to the
            // last dialog pushed, reaches the card the teacher cannot see and
            // discards a code nothing can read back. React batches this with the
            // setState below, so there is no frame in which both are open.
            setResetTarget(null);
            if ('loginCode' in result) {
                setCodeCard({
                    displayName: target.display_name,
                    loginCode: result.loginCode,
                    username: result.username,
                });
            } else {
                setInvitedEmail(result.studentEmail);
            }
            await reloadRoster();
        });
        // Still the close for the throw path: run() turns a failure into red text
        // on the page behind, which the confirmation would otherwise cover.
        setResetTarget(null);
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
                    Each student gets their own sign-in: a printed setup code they turn into a username, or an email
                    invite if they have an address. Assign scores from your library and their markings stay theirs.
                </p>
            ) : null}

            {/*
              The nav hides this page on a plan without a roster, but a bookmark
              or a typed URL still lands here. The add form goes — the server
              refuses every submission — while the rows stay, because they are the
              only place a teacher can archive a student, and archiving is what
              stops that student signing in.
            */}
            {canManageStudents ? <AddStudentForm busy={busy} onAdd={addStudent} /> : null}

            {limit ? <LimitReachedNotice limit={limit} onUpgrade={openPricing} className="mt-5" /> : null}
            {actionError ? <ErrorText className="mt-4">{actionError}</ErrorText> : null}

            {students === null ? (
                <LoadingText className="mt-10">Loading your roster…</LoadingText>
            ) : loadError && students.length === 0 ? (
                <ErrorText className="mt-8">{loadError}</ErrorText>
            ) : students.length === 0 ? (
                canManageStudents ? (
                    <p className="mt-10 text-sm text-stone-500">
                        No students yet — add one above to print their setup card or send their invite.
                    </p>
                ) : (
                    <EmptyState
                        className="mt-10"
                        title="Your plan doesn’t include students"
                        body="Teacher and Academy add a roster: each student gets their own sign-in, and you assign scores straight from your library."
                    >
                        <Button onClick={openPricing}>See plans</Button>
                    </EmptyState>
                )
            ) : (
                <section className="mt-8">
                    {/* Above the list, not instead of it: the cached roster the
                        effect just painted is exactly what a teacher on a bad
                        connection came for. */}
                    {loadError ? <ErrorText className="mb-4">{loadError}</ErrorText> : null}
                    {/* Nothing in the list is taken away with the form: archive and
                        reset ask student-provision for no seat, and restore — which
                        does — comes back 402 into the notice above.

                        Which is why `limit` stands this one down. METRIC_COPY.students
                        interpolates neither the limit nor the tier, so the refusal
                        renders the same sentence this notice already shows: leaving
                        both up stacks two identical amber boxes, announces two
                        `status` regions, and makes a refused Restore look like a
                        button that did nothing. One notice at a time, and the 402
                        moving it is the evidence the click landed. */}
                    {canManageStudents || limit ? null : (
                        <LimitReachedNotice limit={noRosterOnThisPlan(tier)} onUpgrade={openPricing} className="mb-6" />
                    )}
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
                                cachedCount={cachedCounts?.get(student.student_user_id)}
                                assignmentsStatus={assignmentsStatus}
                                expanded={expandedId === student.id}
                                busy={busy}
                                onToggle={() => setExpandedId((id) => (id === student.id ? null : student.id))}
                                onReset={() => setResetTarget(student)}
                                onArchive={() => setArchiveTarget(student)}
                                onRestore={() => void restore(student)}
                                onSetAccess={setAccess}
                                onUnassign={unassign}
                            />
                        ))}
                    </ul>
                </section>
            )}

            {codeCard ? (
                <Dialog label="Setup card" onClose={() => setCodeCard(null)}>
                    <p className="text-sm leading-relaxed text-stone-600">
                        Print this now or write it down. The code is stored as a hash, so nothing can read it back — a
                        lost card is replaced by resetting their access, never recovered. It works once: the student
                        spends it choosing their username and password.
                    </p>
                    <StudentCodeCard
                        displayName={codeCard.displayName}
                        loginCode={codeCard.loginCode}
                        username={codeCard.username}
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

            {invitedEmail ? (
                <Dialog label="Invite sent" onClose={() => setInvitedEmail(null)}>
                    <p className="text-sm leading-relaxed text-stone-600">Invite sent to</p>
                    {/* Large on purpose. This is the teacher's second look at an
                        address they typed once, and a typo here does not bounce
                        back to them — it silently mails a stranger a link into a
                        child's account, so the address gets read, not skimmed. */}
                    <p className="mt-1 break-words font-display text-xl font-semibold text-stone-800">{invitedEmail}</p>
                    <p className="mt-3 text-sm leading-relaxed text-stone-500">
                        The link lets them choose a password. Wrong address? Archive this student and add them again.
                    </p>
                    <div className="mt-5 flex justify-end">
                        <Button size="sm" onClick={() => setInvitedEmail(null)}>
                            Done
                        </Button>
                    </div>
                </Dialog>
            ) : null}

            {resetTarget ? (
                <ConfirmDialog
                    {...resetPromptFor(resetTarget)}
                    busy={busy}
                    onConfirm={() => void confirmReset()}
                    onCancel={() => setResetTarget(null)}
                />
            ) : null}

            {archiveTarget ? (
                <ConfirmDialog
                    title={`Archive ${archiveTarget.display_name}?`}
                    body="Their seat frees up for another student and their sign-in stops working. Nothing is deleted — assignments, annotations and practice notes all stay, and restoring them brings it back exactly as it was."
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
const SIGN_IN_METHODS: ReadonlyArray<{ value: 'code' | 'email'; label: string; hint: string }> = [
    { value: 'code', label: 'Setup code', hint: 'No email needed — best for younger students' },
    { value: 'email', label: 'Email invite', hint: 'They’ll get a link to set their password' },
];

const AddStudentForm = ({
    busy,
    onAdd,
}: {
    busy: boolean;
    onAdd: (displayName: string, opts: ProvisionOptions) => Promise<boolean>;
}) => {
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [method, setMethod] = useState<'code' | 'email'>('code');
    const [studentEmail, setStudentEmail] = useState('');
    const [error, setError] = useState<string | null>(null);
    // Separate from `busy`, which is every roster action at once. Disabling this
    // form while an archive runs is right — two mutations should not overlap —
    // but captioning the button "Adding…" for one is a plain lie about what the
    // page is doing. The disable stays shared; only the word is ours.
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
        const displayName = name.trim();
        if (!displayName) {
            setError('Enter the student’s name.');
            return;
        }
        const trimmedStudentEmail = studentEmail.trim();
        if (method === 'email' && !trimmedStudentEmail.includes('@')) {
            setError('Enter the student’s email address.');
            return;
        }
        setError(null);
        const parentEmail = email.trim() || undefined;
        setSubmitting(true);
        try {
            const opts: ProvisionOptions =
                method === 'email'
                    ? { parentEmail, method: 'email', studentEmail: trimmedStudentEmail }
                    : { parentEmail, method: 'code' };
            if (await onAdd(displayName, opts)) {
                setName('');
                setEmail('');
                setStudentEmail('');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not add that student.');
        } finally {
            setSubmitting(false);
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

            {/* Native radios: this is one choice out of two, the browser already
                knows how to say that, and arrow keys move between them for free. */}
            <fieldset className="mt-4">
                <legend className={fieldLabelClassName}>How will they sign in?</legend>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {SIGN_IN_METHODS.map((option) => (
                        <label
                            key={option.value}
                            className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition ${
                                method === option.value
                                    ? 'border-accent/60 bg-accent-soft/50'
                                    : 'border-stone-300/90 bg-white/70 hover:border-stone-400/90'
                            }`}
                        >
                            <input
                                type="radio"
                                name="roster-method"
                                value={option.value}
                                checked={method === option.value}
                                disabled={busy}
                                onChange={() => setMethod(option.value)}
                                className="mt-0.5 accent-accent"
                            />
                            <span>
                                <span className="block text-sm font-medium text-stone-800">{option.label}</span>
                                <span className="mt-0.5 block text-xs text-stone-500">{option.hint}</span>
                            </span>
                        </label>
                    ))}
                </div>
            </fieldset>

            {method === 'email' ? (
                <div className="mt-4 sm:max-w-sm">
                    <TextField
                        id="roster-student-email"
                        label="Student email"
                        size="sm"
                        type="email"
                        value={studentEmail}
                        placeholder="student@example.com"
                        disabled={busy}
                        onChange={(event) => setStudentEmail(event.target.value)}
                    />
                </div>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-stone-500">
                    Parent email is for your records and for sending the card home — it is never a sign-in.
                </p>
                <Button type="submit" size="sm" disabled={busy}>
                    {submitting ? 'Adding…' : 'Add student'}
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
    cachedCount,
    assignmentsStatus,
    expanded,
    busy,
    onToggle,
    onReset,
    onArchive,
    onRestore,
    onSetAccess,
    onUnassign,
}: {
    student: ManagedStudentRow;
    index: number;
    assignments: RosterAssignment[];
    /** Snapshot count while the network's assignments are still out (else undefined). */
    cachedCount?: number;
    assignmentsStatus: 'loading' | 'ready' | 'failed';
    expanded: boolean;
    busy: boolean;
    onToggle: () => void;
    onReset: () => void;
    onArchive: () => void;
    onRestore: () => void;
    onSetAccess: (assignment: AssignmentRow, access: AssignmentAccess) => void;
    onUnassign: (assignment: AssignmentRow) => void;
}) => {
    const archived = student.archived_at !== null;
    const detailId = `student-detail-${student.id}`;
    const identifier = identifierOf(student);
    const count = assignments.length > 0 ? assignments.length : (cachedCount ?? 0);
    /** The badge shows a snapshot count whose rows haven't arrived (yet, or at all). */
    const detailsMissing = assignments.length === 0 && (cachedCount ?? 0) > 0;

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
                        {/* What they type to get in, beside the name the teacher
                            typed — the two are different strings on both paths. */}
                        {identifier ? <span className="truncate text-xs text-stone-500">{identifier}</span> : null}
                        {student.claimed_at === null && !archived ? <Badge tone="warn">Invited</Badge> : null}
                        {archived ? <Badge>Archived</Badge> : null}
                    </button>
                    <span className="shrink-0 px-2 text-xs text-stone-500">
                        {count === 0 ? 'No scores' : `${count} ${count === 1 ? 'score' : 'scores'}`}
                    </span>
                    <RosterRowMenu
                        archived={archived}
                        busy={busy}
                        resetLabel={resetLabelFor(student)}
                        onReset={onReset}
                        onArchive={onArchive}
                        onRestore={onRestore}
                    />
                </div>

                {expanded ? (
                    <div id={detailId} className="pb-5 pl-5">
                        <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-stone-500">
                            Assigned scores
                        </h3>
                        {detailsMissing && assignmentsStatus === 'loading' ? (
                            <LoadingText className="mt-2">Loading assignments…</LoadingText>
                        ) : detailsMissing ? (
                            // Terminal, not a spinner: nothing on this mount will
                            // fill the panel once the load has failed.
                            <p className="mt-2 text-sm text-stone-500">
                                The assignment list couldn’t be loaded — the count is from the last sync.
                            </p>
                        ) : assignments.length === 0 ? (
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
    resetLabel,
    onReset,
    onArchive,
    onRestore,
}: {
    archived: boolean;
    busy: boolean;
    resetLabel: string;
    onReset: () => void;
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
                    className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
                >
                    {archived ? (
                        <MenuItem label="Restore" onClick={() => pick(onRestore)} />
                    ) : (
                        <>
                            <MenuItem label={resetLabel} onClick={() => pick(onReset)} />
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
