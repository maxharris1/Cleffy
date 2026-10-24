import { useCallback, useEffect, useState } from 'react';

import {
    createStudio,
    fetchOwnedStudio,
    fetchStudioSeatLimit,
    fetchStudioSeatStatus,
    fetchStudioSeats,
    inviteStudioMember,
    removeStudioMember,
    setActiveStudioSeats,
    type StudioSeat,
    type StudioSeatState,
} from '@/features/billing/studiosService';
import type { EffectiveTier, EntitlementSource, StudioRow } from '@/types/database';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';
import { fieldClassName } from '@/ui/classNames';

export interface StudioSeatsProps {
    userId: string;
    tier: EffectiveTier;
    source: EntitlementSource;
    /** The signed-in teacher's own seat is past its academy's limit. */
    seatReadOnly?: boolean;
}

/**
 * The effective seat count, or null to fall back on the studio row's own: a
 * backend without the district-seats migration has no studio_seat_limit, and the
 * roster is still worth showing.
 */
const seatLimitOf = (studioId: string): Promise<number | null> => fetchStudioSeatLimit(studioId).catch(() => null);

/** Seat status, or null on a backend that cannot rank seats yet: then nobody is shown read-only. */
const seatStatusOf = (studioId: string): Promise<Map<string, StudioSeatState> | null> =>
    fetchStudioSeatStatus(studioId).catch(() => null);

interface Loaded {
    studio: StudioRow | null;
    seats: StudioSeat[];
    limit: number | null;
    status: Map<string, StudioSeatState> | null;
}

const load = async (userId: string): Promise<Loaded> => {
    const studio = await fetchOwnedStudio(userId);
    if (!studio) {
        return { studio, seats: [], limit: null, status: null };
    }
    const [seats, limit, status] = await Promise.all([
        fetchStudioSeats(studio.id),
        seatLimitOf(studio.id),
        seatStatusOf(studio.id),
    ]);
    return { studio, seats, limit, status };
};

const activeIdsOf = (status: Map<string, StudioSeatState> | null): Set<string> =>
    new Set([...(status ?? new Map<string, StudioSeatState>())].filter(([, s]) => s.active).map(([id]) => id));

/**
 * Minimal seat management for an Academy: the owner types a teacher's email and
 * they get Teacher-equivalent entitlements. The seat cap itself is a database
 * trigger, so this UI only has to report what the server said -- including a
 * district's contracted count, which is an admin override the server resolves.
 *
 * A studio can hold more teachers than its limit once a district's override is
 * lowered, cleared or lapses. The seats past the limit are read-only (the server
 * decides which: the owner's pick, then the oldest), and the owner chooses here
 * who stays active. Shown to an owner whose own plan has lapsed too, since that
 * is when the choice matters most; adding teachers still needs Academy.
 *
 * The tables and services are still named `studio` — only the tier and the copy
 * were renamed.
 */
export const StudioSeats = ({ userId, tier, source, seatReadOnly = false }: StudioSeatsProps) => {
    const [studio, setStudio] = useState<StudioRow | null>(null);
    const [seats, setSeats] = useState<StudioSeat[]>([]);
    const [effectiveLimit, setEffectiveLimit] = useState<number | null>(null);
    const [status, setStatus] = useState<Map<string, StudioSeatState> | null>(null);
    const [picked, setPicked] = useState<Set<string>>(new Set());
    const [email, setEmail] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isOwner = tier === 'academy' && source === 'subscription';
    // A district owner past their grace period resolves to free but still owns
    // the studio; other plans never held one worth asking about.
    const mayOwn = isOwner || (tier === 'free' && source === 'none');

    const apply = (loaded: Loaded) => {
        setStudio(loaded.studio);
        setSeats(loaded.seats);
        setEffectiveLimit(loaded.limit);
        setStatus(loaded.status);
        setPicked(activeIdsOf(loaded.status));
    };

    const reload = useCallback(async () => apply(await load(userId)), [userId]);

    useEffect(() => {
        if (!mayOwn) {
            return;
        }
        let mounted = true;
        void (async () => {
            try {
                const loaded = await load(userId);
                if (mounted) {
                    apply(loaded);
                }
            } catch {
                // Best-effort, like the library's favourites and tags loads.
            }
        })();
        return () => {
            mounted = false;
        };
    }, [mayOwn, userId]);

    if (source === 'studio_member') {
        return (
            <section className="mt-8 border-t border-stone-300/50 pt-6">
                <h2 className="text-sm font-medium uppercase tracking-[0.08em] text-stone-600">Academy</h2>
                {seatReadOnly ? (
                    <p className="mt-2 text-sm text-amber-800">
                        Your academy has more teachers than its plan covers, so your seat is read-only. You can still
                        open and export your scores, but not edit them or add new ones. Ask your academy&apos;s owner to
                        keep your seat active, or choose a plan of your own.
                    </p>
                ) : (
                    <p className="mt-2 text-sm text-stone-600">
                        You hold a seat in someone else&apos;s academy, so your plan is billed by its owner.
                    </p>
                )}
            </section>
        );
    }

    // Only an Academy owner can start one; anyone else is shown a studio they
    // already own and nothing otherwise.
    if (!isOwner && (!mayOwn || !studio)) {
        return null;
    }

    const run = async (action: () => Promise<void>) => {
        setError(null);
        setBusy(true);
        try {
            await action();
            await reload();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Something went wrong.');
        } finally {
            setBusy(false);
        }
    };

    const seatsUsed = seats.length + 1; // the owner holds one
    const seatLimit = effectiveLimit ?? studio?.seat_limit ?? 5;
    const readOnlyCount = seats.filter((seat) => status?.get(seat.userId)?.active === false).length;
    const choosing = readOnlyCount > 0;
    const slots = Math.max(seatLimit - 1, 0);
    const activeNow = activeIdsOf(status);
    const pickChanged = picked.size !== activeNow.size || [...picked].some((id) => !activeNow.has(id));

    const togglePick = (id: string) =>
        setPicked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });

    return (
        <section className="mt-8 border-t border-stone-300/50 pt-6">
            <h2 className="text-sm font-medium uppercase tracking-[0.08em] text-stone-600">Academy seats</h2>

            {!studio ? (
                <>
                    <p className="mt-2 text-sm text-stone-600">Name your academy to start adding teachers.</p>
                    <Button
                        size="sm"
                        className="mt-3"
                        disabled={busy}
                        onClick={() => void run(async () => void (await createStudio(userId, 'My academy')))}
                    >
                        Create academy
                    </Button>
                </>
            ) : (
                <>
                    <p className="mt-2 text-sm text-stone-500">
                        {seatsUsed} of {seatLimit} seats used — you hold one as the owner.
                    </p>

                    {choosing ? (
                        <p className="mt-2 text-sm text-amber-800">
                            {readOnlyCount === 1 ? '1 teacher is' : `${readOnlyCount} teachers are`} read-only: your
                            academy has more teachers than its {seatLimit} seats. Read-only teachers can still open and
                            export their scores, but not edit them. Tick up to {slots} to keep active. Nothing is
                            deleted, and every seat comes back when the plan covers it again.
                        </p>
                    ) : null}

                    <ul className="mt-3 flex flex-col gap-1">
                        {seats.map((seat) => {
                            const readOnly = status?.get(seat.userId)?.active === false;
                            const pickId = `studio-seat-keep-${seat.userId}`;
                            return (
                                <li
                                    key={seat.userId}
                                    className="flex items-center justify-between gap-3 border-b border-stone-300/40 py-2 text-sm"
                                >
                                    <span className="flex min-w-0 items-center gap-2">
                                        {choosing ? (
                                            <input
                                                id={pickId}
                                                type="checkbox"
                                                className="size-4 shrink-0"
                                                checked={picked.has(seat.userId)}
                                                disabled={busy}
                                                onChange={() => togglePick(seat.userId)}
                                                aria-label={`Keep ${seat.email} active`}
                                            />
                                        ) : null}
                                        {choosing ? (
                                            // The whole address toggles the pick: the box alone is a small target on a phone.
                                            <label
                                                htmlFor={pickId}
                                                className="min-w-0 cursor-pointer truncate text-stone-700"
                                            >
                                                {seat.email}
                                            </label>
                                        ) : (
                                            <span className="min-w-0 truncate text-stone-700">{seat.email}</span>
                                        )}
                                        {readOnly ? (
                                            <Badge tone="warn" className="shrink-0 whitespace-nowrap">
                                                Read-only
                                            </Badge>
                                        ) : null}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="dangerGhost"
                                        disabled={busy}
                                        onClick={() => void run(() => removeStudioMember(studio.id, seat.userId))}
                                    >
                                        Remove
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>

                    {choosing ? (
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                            <Button
                                size="sm"
                                disabled={busy || !pickChanged || picked.size > slots}
                                onClick={() => void run(() => setActiveStudioSeats(studio.id, [...picked]))}
                            >
                                Save active seats
                            </Button>
                            <span className="text-sm text-stone-500" aria-live="polite">
                                {picked.size} of {slots} ticked
                            </span>
                        </div>
                    ) : null}

                    {isOwner ? (
                        <form
                            className="mt-4 flex flex-wrap items-end gap-2"
                            onSubmit={(event) => {
                                event.preventDefault();
                                const trimmed = email.trim();
                                if (!trimmed) {
                                    return;
                                }
                                void run(async () => {
                                    await inviteStudioMember(studio.id, trimmed);
                                    setEmail('');
                                });
                            }}
                        >
                            <label className="sr-only" htmlFor="studio-invite-email">
                                Teacher email
                            </label>
                            <input
                                id="studio-invite-email"
                                type="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                placeholder="teacher@example.com"
                                className={fieldClassName('sm', 'sm:max-w-xs')}
                            />
                            <Button size="sm" type="submit" disabled={busy || seatsUsed >= seatLimit}>
                                Add teacher
                            </Button>
                        </form>
                    ) : (
                        <p className="mt-4 text-sm text-stone-500">
                            Your Academy plan isn&apos;t active, so no teachers can be added until it is.
                        </p>
                    )}
                </>
            )}

            {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}
        </section>
    );
};
