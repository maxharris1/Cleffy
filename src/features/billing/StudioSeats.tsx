import { useCallback, useEffect, useState } from 'react';

import {
    createStudio,
    fetchOwnedStudio,
    fetchStudioSeats,
    inviteStudioMember,
    removeStudioMember,
    type StudioSeat,
} from '@/features/billing/studiosService';
import type { BillingTier, EntitlementSource, StudioRow } from '@/types/database';
import { Button } from '@/ui/Button';
import { ErrorText } from '@/ui/ErrorText';
import { fieldClassName } from '@/ui/classNames';

export interface StudioSeatsProps {
    userId: string;
    tier: BillingTier;
    source: EntitlementSource;
}

/**
 * Minimal seat management: the owner types a teacher's email and they get
 * Pro-equivalent entitlements. The seat cap itself is a database trigger, so
 * this UI only has to report what the server said.
 */
export const StudioSeats = ({ userId, tier, source }: StudioSeatsProps) => {
    const [studio, setStudio] = useState<StudioRow | null>(null);
    const [seats, setSeats] = useState<StudioSeat[]>([]);
    const [email, setEmail] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isOwner = tier === 'studio' && source === 'subscription';

    const reload = useCallback(async () => {
        const owned = await fetchOwnedStudio(userId);
        setStudio(owned);
        setSeats(owned ? await fetchStudioSeats(owned.id) : []);
    }, [userId]);

    useEffect(() => {
        if (!isOwner) {
            return;
        }
        let mounted = true;
        void (async () => {
            try {
                const owned = await fetchOwnedStudio(userId);
                if (!mounted) {
                    return;
                }
                setStudio(owned);
                const roster = owned ? await fetchStudioSeats(owned.id) : [];
                if (mounted) {
                    setSeats(roster);
                }
            } catch {
                // Best-effort, like the library's favourites and tags loads.
            }
        })();
        return () => {
            mounted = false;
        };
    }, [isOwner, userId]);

    if (source === 'studio_member') {
        return (
            <section className="mt-8 border-t border-stone-300/50 pt-6">
                <h2 className="text-sm font-medium uppercase tracking-[0.08em] text-stone-600">Studio</h2>
                <p className="mt-2 text-sm text-stone-600">
                    You hold a seat in someone else&apos;s studio, so your plan is billed by its owner.
                </p>
            </section>
        );
    }

    if (!isOwner) {
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
    const seatLimit = studio?.seat_limit ?? 5;

    return (
        <section className="mt-8 border-t border-stone-300/50 pt-6">
            <h2 className="text-sm font-medium uppercase tracking-[0.08em] text-stone-600">Studio seats</h2>

            {!studio ? (
                <>
                    <p className="mt-2 text-sm text-stone-600">Name your studio to start adding teachers.</p>
                    <Button
                        size="sm"
                        className="mt-3"
                        disabled={busy}
                        onClick={() => void run(async () => void (await createStudio(userId, 'My studio')))}
                    >
                        Create studio
                    </Button>
                </>
            ) : (
                <>
                    <p className="mt-2 text-sm text-stone-500">
                        {seatsUsed} of {seatLimit} seats used — you hold one as the owner.
                    </p>

                    <ul className="mt-3 flex flex-col gap-1">
                        {seats.map((seat) => (
                            <li
                                key={seat.userId}
                                className="flex items-center justify-between gap-3 border-b border-stone-300/40 py-2 text-sm"
                            >
                                <span className="min-w-0 truncate text-stone-700">{seat.email}</span>
                                <Button
                                    size="sm"
                                    variant="dangerGhost"
                                    disabled={busy}
                                    onClick={() => void run(() => removeStudioMember(studio.id, seat.userId))}
                                >
                                    Remove
                                </Button>
                            </li>
                        ))}
                    </ul>

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
                </>
            )}

            {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}
        </section>
    );
};
