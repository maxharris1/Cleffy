import { useEffect, useState } from 'react';

import {
    LINK_GUEST_RETENTION_CHOICES,
    getLinkGuestRetention,
    setLinkGuestRetention,
} from '@/features/share/shareService';
import { ErrorText } from '@/ui/ErrorText';
import { fieldClassName } from '@/ui/classNames';

/**
 * D8: how long a guest who joined one of this owner's scores by link is kept
 * without a visit. One setting per owner, kept on the server.
 */
export const LinkGuestRetentionRow = () => {
    const [days, setDays] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        let current = true;
        getLinkGuestRetention()
            .then((value) => current && setDays(value))
            .catch((err: unknown) => current && setError(err instanceof Error ? err.message : 'Could not load.'));
        return () => {
            current = false;
        };
    }, []);

    const choose = async (next: number) => {
        const previous = days;
        setDays(next);
        setBusy(true);
        setError(null);
        setSaved(false);
        try {
            setDays(await setLinkGuestRetention(next));
            setSaved(true);
        } catch (err) {
            setDays(previous);
            setError(err instanceof Error ? err.message : 'Could not save that setting.');
        } finally {
            setBusy(false);
        }
    };

    const choices: readonly number[] =
        days === null || (LINK_GUEST_RETENTION_CHOICES as readonly number[]).includes(days)
            ? LINK_GUEST_RETENTION_CHOICES
            : [...LINK_GUEST_RETENTION_CHOICES, days].sort((a, b) => a - b);

    return (
        <section className="mt-5">
            <label className="flex flex-wrap items-center gap-1.5 text-sm text-stone-600">
                Remove link guests on your scores after
                <select
                    aria-label="Remove idle link guests after"
                    value={days ?? ''}
                    disabled={days === null || busy}
                    onChange={(e) => void choose(Number(e.target.value))}
                    className={fieldClassName('sm', 'shrink-0 py-1.5', { width: 'auto' })}
                >
                    {days === null ? <option value="">…</option> : null}
                    {choices.map((choice) => (
                        <option key={choice} value={choice}>
                            {choice} days
                        </option>
                    ))}
                </select>
                without a visit
            </label>
            {saved ? (
                <p role="status" className="mt-1 text-xs text-stone-500">
                    Saved.
                </p>
            ) : null}
            {error ? <ErrorText className="mt-2">{error}</ErrorText> : null}
        </section>
    );
};
