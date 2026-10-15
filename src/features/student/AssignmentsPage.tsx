import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { RequireStudent } from '@/features/auth/AuthGates';
import { displayNameOf, signOut } from '@/features/auth/session';
import { useGuardedSignOut } from '@/features/auth/useGuardedSignOut';
import { LegalLinks } from '@/features/legal/LegalLinks';
import { parseCachedAssignments } from '@/features/student/assignmentsCache';
import { signOutEndedStudent } from '@/features/student/endedSignIn';
import {
    fetchMyAssignments,
    fetchMyRosterProfile,
    fetchSignInStillValid,
    type AssignedScore,
} from '@/features/student/studentApi';
import { getDb } from '@/sync/db';
import { Badge } from '@/ui/Badge';
import { EmptyState } from '@/ui/EmptyState';
import { AssignmentsSkeleton } from '@/ui/Skeleton';
import { buttonClassName } from '@/ui/classNames';

/**
 * The whole student app: the pieces their teacher assigned, and a way out.
 *
 * No library chrome, no nav, no billing — a provisioned student owns nothing to
 * manage and is never gated, so every control the teacher's shell carries would
 * be noise here. Tapping a piece opens the ordinary viewer; the membership the
 * assignment created is what makes that work, so nothing on this page has to
 * teach the viewer about students.
 */
/**
 * How often an open list re-reads itself. Assignments are not pushed to the
 * student (there is no realtime topic for them), so a teacher assigning a piece
 * mid-lesson shows up within a minute, or at once when the student comes back
 * to the tab.
 */
export const ASSIGNMENTS_REFRESH_MS = 60_000;

export const AssignmentsPage = () => (
    <RequireStudent>{(session) => <AssignmentsView session={session} />}</RequireStudent>
);

const AssignmentsView = ({ session }: { session: Session }) => {
    const navigate = useNavigate();
    // Seeded from the session so the header is never blank, then upgraded to the
    // teacher's spelling from the roster row when that arrives.
    const [name, setName] = useState(() => displayNameOf(session));
    const [scores, setScores] = useState<AssignedScore[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [notice, setNotice] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;
        let inFlight = false;
        let hasScores = false;

        /**
         * One read of the list. The first paints the cached list while the
         * network answers; later ones (focus, coming back to the tab, the timer)
         * replace it quietly, so an assignment made since the page opened turns
         * up without a reload.
         */
        const load = async (first: boolean) => {
            if (inFlight) {
                return;
            }
            inFlight = true;
            try {
                let firstResolved = false;
                const assignedP = fetchMyAssignments();
                const profileP = fetchMyRosterProfile();
                // Alongside the reads rather than after them, so asking costs no
                // extra round trip before the list shows.
                const validP = fetchSignInStillValid(null).catch(() => null);
                assignedP.then(
                    () => {
                        firstResolved = true;
                    },
                    () => undefined,
                );
                const cachedRow = first
                    ? await getDb()
                          .assignmentsCache.get(session.user.id)
                          .catch(() => undefined)
                    : undefined;
                const cached = parseCachedAssignments(cachedRow);
                if (cachedRow && !cached) {
                    // Unreadable: never painted, and gone, so the network
                    // answer (written back below) is all the next load sees.
                    void getDb()
                        .assignmentsCache.delete(session.user.id)
                        .catch(() => undefined);
                }
                if (first) {
                    await Promise.resolve();
                    if (mounted && !firstResolved && cached && cached.length > 0) {
                        hasScores = true;
                        setScores(cached);
                        setLoading(false);
                    }
                }

                const [assigned, profile] = await Promise.allSettled([assignedP, profileP]);
                if (!mounted) {
                    return;
                }
                const roster = profile.status === 'fulfilled' ? profile.value : null;
                // Before the list is trusted: a sign-in the teacher has ended
                // reads back as an empty list, which is not "nothing assigned".
                if (assigned.status === 'fulfilled' && profile.status === 'fulfilled') {
                    const stillValid = roster?.archived_at ? false : await validP;
                    if (!mounted) {
                        return;
                    }
                    if (stillValid === false) {
                        mounted = false;
                        // A roster row means the account is still there (reset,
                        // or archived until restored): what it queued on this
                        // device stays for its next sign-in here, as the roster
                        // promises. No row: it was deleted with its teacher,
                        // and nothing it queued can ever upload. (The viewer
                        // asks the same of the server: fetchAccountDeleted.)
                        const state = await signOutEndedStudent(roster === null);
                        navigate('/student', { replace: true, state });
                        return;
                    }
                }
                if (assigned.status === 'fulfilled') {
                    hasScores = true;
                    setScores(assigned.value);
                    setNotice(null);
                    void getDb()
                        .assignmentsCache.put({
                            userId: session.user.id,
                            scores: assigned.value,
                            cachedAt: new Date().toISOString(),
                        })
                        .catch(() => undefined);
                } else if (!hasScores) {
                    // Leave `scores` null so the empty state cannot claim nothing is
                    // assigned when the truth is that nothing loaded.
                    setNotice('Could not load your pieces. Check the internet connection and try again.');
                } else {
                    // The list on screen stays up, but say it is a snapshot — a new
                    // assignment made since the last sync would be missing from it.
                    setNotice('Could not refresh — showing your pieces from the last sync.');
                }
                // Best effort: the name from the session is already a fine answer.
                if (roster) {
                    setName(roster.display_name);
                }
                setLoading(false);
            } finally {
                inFlight = false;
            }
        };

        void load(true);

        const refresh = () => {
            if (document.visibilityState === 'visible') {
                void load(false);
            }
        };
        const timer = window.setInterval(refresh, ASSIGNMENTS_REFRESH_MS);
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('focus', refresh);
        return () => {
            mounted = false;
            window.clearInterval(timer);
            document.removeEventListener('visibilitychange', refresh);
            window.removeEventListener('focus', refresh);
        };
    }, [session.user.id, navigate]);

    const handleSignOut = async () => {
        await signOut();
        navigate('/student', { replace: true });
    };
    // Uploads (or asks about) unsynced marks first — sign-out clears them.
    const { requestSignOut, checking: savingBeforeSignOut, dialog: signOutDialog } = useGuardedSignOut(handleSignOut);

    return (
        <main className="paper-page min-h-full">
            <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">
                <header className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <p className="landing-brand font-display text-2xl font-semibold sm:text-3xl">Cleffy</p>
                        <p className="mt-1 truncate text-sm text-stone-500">{name}</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void requestSignOut()}
                        disabled={savingBeforeSignOut}
                        className={buttonClassName('ghost', 'sm', 'shrink-0')}
                    >
                        {savingBeforeSignOut ? 'Saving changes…' : 'Sign out'}
                    </button>
                </header>

                <h1 className="mt-8 font-display text-2xl font-semibold tracking-tight text-stone-800 sm:mt-10">
                    Your pieces
                </h1>

                {notice ? (
                    <p className="mt-5 text-sm text-amber-800" role="status">
                        {notice}
                    </p>
                ) : null}

                {loading && scores === null ? <AssignmentsSkeleton label="Finding your pieces…" /> : null}

                {scores && scores.length > 0 ? (
                    <ul className="mt-6 space-y-3">
                        {scores.map((score) => (
                            <AssignmentCard key={score.assignment.id} score={score} />
                        ))}
                    </ul>
                ) : null}

                {scores && scores.length === 0 ? (
                    <EmptyState
                        className="mt-16"
                        title="Nothing here yet"
                        body="Your teacher will assign your pieces."
                    />
                ) : null}

                {/* delete-account refuses a provisioned student (their teacher
                    created and controls the account), so say where to go instead.
                    Not "ask your teacher": a teacher can only archive a student,
                    which keeps the account and its marks. */}
                <footer className="mt-16 border-t border-stone-300/50 pt-4">
                    <p className="text-xs text-stone-500">
                        Your teacher looks after this account. To have it and its data deleted, contact us.
                    </p>
                    <LegalLinks withContact className="mt-2" />
                </footer>
            </div>
            {signOutDialog}
        </main>
    );
};

const AssignmentCard = ({ score: { assignment, document: doc } }: { score: AssignedScore }) => {
    const due = formatDue(assignment.due_at);

    return (
        <li>
            <Link
                to={`/doc/${assignment.document_id}`}
                className="block rounded-xl border border-stone-300/60 bg-white/70 px-4 py-3.5 transition hover:border-accent/50 hover:bg-white"
            >
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                    {/* Two lines before it ellipsizes — a long catalogue title
                        ("Sonata in C major, K 545: I. Allegro") is told apart
                        by its end — and the whole title on hover. The 14rem
                        basis lets the badges wrap below it on a phone rather
                        than squeeze it to a word or two; they wrap together. */}
                    <span
                        title={doc.title}
                        className="line-clamp-2 min-w-0 grow basis-56 text-lg font-medium break-words text-stone-800"
                    >
                        {doc.title}
                    </span>
                    {due || assignment.access === 'view' ? (
                        <span className="flex max-w-full flex-wrap items-center gap-x-2.5 gap-y-1.5">
                            {due ? <Badge>Due {due}</Badge> : null}
                            {assignment.access === 'view' ? <Badge>View only</Badge> : null}
                        </span>
                    ) : null}
                </div>
                {assignment.note ? (
                    <p className="mt-1.5 text-sm leading-relaxed [overflow-wrap:anywhere] text-stone-600">
                        {assignment.note}
                    </p>
                ) : null}
            </Link>
        </li>
    );
};

/**
 * Local date, no time: due_at is a day to a student, and the timestamp behind it
 * is the teacher's business. The year only appears when it is not this one, so
 * the common case stays as short as a date on a lesson plan.
 */
const formatDue = (dueAt: string | null): string | null => {
    if (!dueAt) {
        return null;
    }
    const date = new Date(dueAt);
    if (Number.isNaN(date.getTime())) {
        return null;
    }
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' }),
    });
};
