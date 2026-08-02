import { useState } from 'react';

import { getSupabase } from '@/lib/supabase';
import { CloseIcon } from '@/ui/icons';

type BannerState = 'collapsed' | 'editing' | 'sent' | 'dismissed';

/**
 * Anonymous identities live in this browser's storage only — evicted storage
 * silently orphans a student's work. Nudge guests to attach an email
 * (same user id, memberships and annotations untouched — plan §auth).
 */
export const UpgradeBanner = () => {
    const [state, setState] = useState<BannerState>('collapsed');
    const [email, setEmail] = useState('');
    const [error, setError] = useState<string | null>(null);

    if (state === 'dismissed') {
        return null;
    }

    const submit = async () => {
        if (!email.includes('@')) {
            setError('Enter a valid email address.');
            return;
        }
        setError(null);
        try {
            const { error: updateError } = await getSupabase().auth.updateUser({ email: email.trim() });
            if (updateError) {
                throw updateError;
            }
            setState('sent');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not send the confirmation email.');
        }
    };

    return (
        <div data-ui-overlay className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-900">
            {state === 'sent' ? (
                <p>
                    Check <span className="font-medium">{email}</span> to confirm — your work will then follow you to
                    any device.
                </p>
            ) : state === 'editing' ? (
                <div className="flex flex-wrap items-center gap-2">
                    <input
                        type="email"
                        value={email}
                        autoFocus
                        placeholder="you@example.com"
                        onChange={(e) => setEmail(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                void submit();
                            }
                        }}
                        className="min-w-48 flex-1 rounded border border-amber-300 bg-white px-2 py-1 outline-none focus:border-amber-500"
                    />
                    <button
                        type="button"
                        onClick={() => void submit()}
                        className="rounded bg-amber-600 px-3 py-1 font-medium text-white hover:bg-amber-500"
                    >
                        Save my work
                    </button>
                    <button type="button" onClick={() => setState('collapsed')} className="text-amber-700 underline">
                        Cancel
                    </button>
                    {error ? (
                        <span role="status" className="text-danger">
                            {error}
                        </span>
                    ) : null}
                </div>
            ) : (
                <div className="flex items-center justify-between gap-2">
                    <p>
                        You&apos;re annotating as a guest — this work lives only in this browser.{' '}
                        <button type="button" onClick={() => setState('editing')} className="font-medium underline">
                            Add your email to keep it
                        </button>
                    </p>
                    <button
                        type="button"
                        aria-label="Dismiss"
                        onClick={() => setState('dismissed')}
                        className="rounded p-1 text-amber-700 transition hover:text-amber-900"
                    >
                        <CloseIcon size={16} />
                    </button>
                </div>
            )}
        </div>
    );
};
