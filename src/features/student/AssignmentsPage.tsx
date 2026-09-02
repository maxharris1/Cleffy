import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { RequireStudent } from '@/features/auth/AuthGates';
import { displayNameOf, signOut } from '@/features/auth/session';
import { fetchMyAssignments, fetchMyRosterProfile, type AssignedScore } from '@/features/student/studentApi';
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
        void (async () => {
            const cached = await getDb()
                .assignmentsCache.get(session.user.id)
                .catch(() => undefined);
            if (mounted && cached && cached.scores.length > 0) {
                setScores(cached.scores);
                setLoading(false);
            }

            const [assigned, profile] = await Promise.allSettled([fetchMyAssignments(), fetchMyRosterProfile()]);
            if (!mounted) {
                return;
            }
            if (assigned.status === 'fulfilled') {
                setScores(assigned.value);
                void getDb()
                    .assignmentsCache.put({
                        userId: session.user.id,
                        scores: assigned.value,
                        cachedAt: new Date().toISOString(),
                    })
                    .catch(() => undefined);
            } else if (!cached?.scores.length) {
                // Leave `scores` null so the empty state cannot claim nothing is
                // assigned when the truth is that nothing loaded.
                setNotice('Could not load your pieces. Check the internet connection and try again.');
            } else {
                // The cached paint stays up, but say it is a snapshot — a new
                // assignment made since the last sync would be missing from it.
                setNotice('Could not refresh — showing your pieces from the last sync.');
            }
            // Best effort: the name from the session is already a fine answer.
            if (profile.status === 'fulfilled' && profile.value) {
                setName(profile.value.display_name);
            }
            setLoading(false);
        })();
        return () => {
            mounted = false;
        };
    }, [session.user.id]);

    const handleSignOut = async () => {
        await signOut();
        navigate('/student', { replace: true });
    };

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
                        onClick={() => void handleSignOut()}
                        className={buttonClassName('ghost', 'sm', 'shrink-0')}
                    >
                        Sign out
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
            </div>
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
                    <span className="min-w-0 flex-1 truncate text-lg font-medium text-stone-800">{doc.title}</span>
                    {due ? <Badge>Due {due}</Badge> : null}
                    {assignment.access === 'view' ? <Badge>View only</Badge> : null}
                </div>
                {assignment.note ? (
                    <p className="mt-1.5 text-sm leading-relaxed text-stone-600">{assignment.note}</p>
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
