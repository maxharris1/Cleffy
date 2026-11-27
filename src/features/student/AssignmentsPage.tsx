import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { RequireStudent } from '@/features/auth/AuthGates';
import { displayNameOf, signOut } from '@/features/auth/session';
import { useGuardedSignOut } from '@/features/auth/useGuardedSignOut';
import { LegalLinks } from '@/features/legal/LegalLinks';
import { ScoreThumb } from '@/features/library/ScoreThumb';
import '@/features/marketing/handwriting.css';
import { parseCachedAssignments } from '@/features/student/assignmentsCache';
import { EndedSignInInkPrompt } from '@/features/student/EndedSignInInkPrompt';
import { signOutEndedStudent } from '@/features/student/endedSignIn';
import {
    fetchMyAssignments,
    fetchMyRosterProfile,
    fetchSignInStillValid,
    type AssignedScore,
} from '@/features/student/studentApi';
import { type KnownScore, useEndedSignInInkPrompt } from '@/features/student/useEndedSignInInkPrompt';
import { getDb } from '@/sync/db';
import { Badge } from '@/ui/Badge';
import { EmptyState } from '@/ui/EmptyState';
import { AssignmentsSkeleton } from '@/ui/Skeleton';
import { buttonClassName } from '@/ui/classNames';
import { ChevronRightIcon } from '@/ui/icons';
import { PageHead } from '@/ui/PageHead';
import { Wordmark } from '@/ui/Wordmark';

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
    const endedInk = useEndedSignInInkPrompt();
    const { askFirst: askAboutHeldInk } = endedInk;

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
                        // Ink a viewer could not store on this device: Export
                        // is offered first, and the sign-out waits on the
                        // student (not on an unmount: then it does not happen).
                        const known: Record<string, KnownScore> = Object.fromEntries(
                            (assigned.status === 'fulfilled' ? assigned.value : []).map(({ document }) => [
                                document.id,
                                { title: document.title, doc: document },
                            ]),
                        );
                        if (!(await askAboutHeldInk(session.user.id, roster === null, known))) {
                            return;
                        }
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
    }, [session.user.id, navigate, askAboutHeldInk]);

    const handleSignOut = async () => {
        await signOut();
        navigate('/student', { replace: true });
    };
    // Uploads (or asks about) unsynced marks first — sign-out clears them.
    const { requestSignOut, checking: savingBeforeSignOut, dialog: signOutDialog } = useGuardedSignOut(handleSignOut);

    if (endedInk.prompt) {
        return (
            <EndedSignInInkPrompt
                prompt={endedInk.prompt}
                signingOut={endedInk.signingOut}
                onSignOut={endedInk.proceed}
            />
        );
    }

    return (
        <main className="paper-page min-h-full pb-[var(--safe-bottom)]">
            <StudentInkBar name={name} saving={savingBeforeSignOut} onSignOut={() => void requestSignOut()} />

            <div className="mx-auto w-full max-w-[880px] pt-[22px] pr-[max(18px,var(--safe-right))] pb-14 pl-[max(18px,var(--safe-left))] sm:pt-9 sm:pr-[max(2.5rem,var(--safe-right))] sm:pl-[max(2.5rem,var(--safe-left))] lg:pt-11 [&>.page-head]:mb-0">
                <PageHead
                    width="home"
                    title={
                        <>
                            Your <em>pieces.</em>
                        </>
                    }
                    subtitle={
                        <p>
                            Everything your teacher has given you. New marks show up on the page{' '}
                            <span className="text-ink shadow-[inset_0_-0.52em_0_var(--color-highlighter)]">
                                as they are made
                            </span>
                            .
                        </p>
                    }
                />

                {notice ? (
                    <div className="border-b border-hairline py-4">
                        <p className="rounded-xl bg-amber-100 px-4 py-3 text-sm text-due" role="status">
                            {notice}
                        </p>
                    </div>
                ) : null}

                {loading && scores === null ? <AssignmentsSkeleton label="Finding your pieces…" /> : null}

                {scores && scores.length > 0 ? (
                    <ul>
                        {scores.map((score) => (
                            <AssignmentRow key={score.assignment.id} score={score} />
                        ))}
                    </ul>
                ) : null}

                {scores && scores.length === 0 ? (
                    <EmptyState
                        className="py-16"
                        title="Nothing here yet"
                        body="Your teacher will assign your pieces."
                    />
                ) : null}

                {/* delete-account refuses a provisioned student (their teacher
                    created and controls the account), so say where to go instead.
                    Not "ask your teacher": a teacher can only archive a student,
                    which keeps the account and its marks. */}
                <footer className="mt-7">
                    <p className="text-[13px] leading-normal text-pretty text-ink-muted">
                        Your teacher looks after this account. To have it and its data deleted, contact us.
                    </p>
                    <LegalLinks withContact className="mt-1.5" />
                </footer>
            </div>
            {signOutDialog}
        </main>
    );
};

export const StudentInkBar = ({
    name,
    saving,
    onSignOut,
}: {
    name: string;
    saving: boolean;
    onSignOut: () => void;
}) => (
    <header className="bg-ink pt-[var(--safe-top)] text-paper [--focus-ring:var(--color-ink-rule)]">
        <div
            className={`mx-auto flex min-h-16 w-full max-w-[880px] items-center justify-between gap-3 py-2.5 pr-[max(18px,var(--safe-right))] pl-[max(18px,var(--safe-left))] sm:gap-4 sm:py-0 sm:pr-[max(2.5rem,var(--safe-right))] sm:pl-[max(2.5rem,var(--safe-left))] ${saving ? 'max-sm:flex-wrap' : ''}`}
        >
            <Wordmark tone="ink" className="shrink-0 text-[22px] min-[360px]:text-[26px] sm:text-[28px]" />
            <div
                className={`flex min-w-0 items-center justify-end gap-2 sm:gap-3.5 ${saving ? 'max-sm:basis-full' : ''}`}
            >
                <span className="inline-flex h-[30px] min-w-[5.5rem] items-center gap-2 rounded-full bg-paper/10 pr-3 pl-2.5 text-[13px] font-semibold text-paper shadow-[0_0_0_1px_rgb(247_245_239/0.24)]">
                    <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-[#2563eb]" />
                    <span className="truncate">{name}</span>
                </span>
                <button
                    type="button"
                    onClick={onSignOut}
                    disabled={saving}
                    className={buttonClassName('inkGhost', 'sm', 'shrink-0 hover:text-paper')}
                >
                    {saving ? 'Saving changes…' : 'Sign out'}
                </button>
            </div>
        </div>
    </header>
);

const AssignmentRow = ({ score: { assignment, document: doc } }: { score: AssignedScore }) => {
    const due = formatDue(assignment.due_at);

    return (
        <li className="border-b border-hairline">
            <Link
                to={`/doc/${assignment.document_id}`}
                className="flex items-start gap-3.5 py-4 text-ink sm:flex-wrap sm:items-center sm:gap-x-7 sm:gap-y-4 sm:px-1 sm:py-6"
            >
                <ScoreThumb
                    docId={doc.id}
                    contentRev={doc.content_rev ?? 0}
                    thumbRev={doc.thumb_rev ?? null}
                    frameClassName="aspect-[1275/1650] w-16 rounded-[3px] shadow-[0_0_0_1px_rgb(28_25_23/0.1)] sm:w-24 sm:shadow-[0_0_0_1px_rgb(28_25_23/0.1),0_16px_30px_-20px_rgb(28_25_23/0.5)]"
                />
                <span className="block min-w-0 grow sm:basis-[280px]">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        {/* Two lines before it ellipsizes: a long catalogue title
                            ("Sonata in C major, K 545: I. Allegro") is told apart
                            by its end, and the whole title shows on hover. */}
                        <span
                            title={doc.title}
                            className="display-opsz line-clamp-2 w-full min-w-0 font-display text-[21px] leading-[1.15] font-semibold break-words sm:w-auto sm:text-[30px]"
                        >
                            {doc.title}
                        </span>
                        {assignment.access === 'view' ? (
                            <Badge>View only</Badge>
                        ) : (
                            <Badge tone="accent">Can edit</Badge>
                        )}
                        {due ? <Badge tone="warn">Due {due}</Badge> : null}
                    </span>
                    {assignment.note ? (
                        <span className="mt-2 block max-w-[520px] sm:mt-3">
                            <span className="inline-block -rotate-1 font-hand text-[21px] leading-[1.1] font-bold [overflow-wrap:anywhere] text-[#b91c1c] sm:text-[25px]">
                                {assignment.note}
                            </span>
                        </span>
                    ) : null}
                </span>
                <span className="hidden shrink-0 items-center gap-1.5 text-[15px] font-semibold text-accent sm:inline-flex">
                    Open
                    <ChevronRightIcon size={18} />
                </span>
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
