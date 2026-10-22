import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';

import {
    CancelError,
    confirmCancel,
    peekCancel,
    requestCancelLink,
    type CancelResult,
    type CancelSummary,
} from '@/features/billing/cancelApi';
import { BrandShell } from '@/ui/BrandShell';
import { Button } from '@/ui/Button';
import { linkClassName } from '@/ui/classNames';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { TextField } from '@/ui/TextField';

import { REFUND_WINDOW_DAYS, TRADER } from '../../../supabase/functions/_shared/billingTerms';

/** `20 November 2026, 20:00` in the reader's own zone and locale. */
const formatWhen = (iso: string | null): string | null => {
    if (!iso) {
        return null;
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? null
        : date.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
};

const SupportLine = () => (
    <p className="mt-6 text-center text-xs text-stone-500">
        Stuck? Email{' '}
        <a href={`mailto:${TRADER.supportEmail}`} className={linkClassName}>
            {TRADER.supportEmail}
        </a>{' '}
        and we will cancel it for you.
    </p>
);

/** Step 1: the email lookup. Says the same thing whatever the address. */
const RequestLink = ({ notice }: { notice?: string }) => {
    const [email, setEmail] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sentTo, setSentTo] = useState<string | null>(null);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await requestCancelLink(email);
            setSentTo(email.trim());
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not send the link. Please try again.');
        } finally {
            setBusy(false);
        }
    };

    if (sentTo) {
        return (
            <BrandShell
                title="Check your email"
                subtitle={`If ${sentTo} has a Cleffy subscription, we’ve sent it a link to cancel. It works once and expires in an hour.`}
            >
                <p className="text-center text-sm text-stone-600">
                    Nothing after a few minutes? Check your spam folder, or try again.
                </p>
                <SupportLine />
            </BrandShell>
        );
    }

    return (
        <BrandShell
            title="Cancel your subscription"
            subtitle="No need to sign in. Enter the email address you use for Cleffy and we’ll email you a link to cancel."
        >
            {notice ? <ErrorText className="mb-4">{notice}</ErrorText> : null}
            <form onSubmit={(event) => void submit(event)} noValidate>
                <TextField
                    id="cancel-email"
                    label="Email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                />
                {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}
                <Button type="submit" className="mt-5 w-full" disabled={busy || email.trim() === ''}>
                    {busy ? 'Sending…' : 'Email me a cancel link'}
                </Button>
            </form>
            <p className="mt-6 text-center text-sm text-stone-600">
                Signed in? You can also cancel from{' '}
                <Link to="/account" className={linkClassName}>
                    your Account page
                </Link>
                .
            </p>
            <SupportLine />
        </BrandShell>
    );
};

/** What became of the refund request, if one was asked for. */
const RefundOutcome = ({ result }: { result: CancelResult }) => (
    <>
        {result.refundRequested ? (
            <p className="mt-3 text-center text-sm text-stone-700">
                We’ve passed your refund request to our support team, who will reply by email.
            </p>
        ) : null}
        {result.refundRequestFailed ? (
            <ErrorText className="mt-3 text-center">
                We could not send your refund request. Please email {TRADER.supportEmail} to ask for it.
            </ErrorText>
        ) : null}
    </>
);

/** Answers after which the link is no use, so the page asks for a new one (cancelFlow.ts CANCEL_ERRORS). */
const LINK_DONE = new Set(['link_invalid', 'nothing_to_cancel', 'not_cancelled']);

/** Step 2: the emailed link -- what it would cancel, and "Cancel now". */
const ConfirmCancel = ({ token }: { token: string }) => {
    const [summary, setSummary] = useState<CancelSummary | null>(null);
    const [failure, setFailure] = useState<CancelError | null>(null);
    const [refund, setRefund] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<CancelResult | null>(null);
    const refundId = useId();

    useEffect(() => {
        let live = true;
        peekCancel(token)
            .then((answer) => live && setSummary(answer))
            .catch((err: unknown) => {
                if (live) {
                    setFailure(err instanceof CancelError ? err : new CancelError('Something went wrong.', 'unknown'));
                }
            });
        return () => {
            live = false;
        };
    }, [token]);

    const cancel = async (requestRefund = refund) => {
        setBusy(true);
        setError(null);
        try {
            setResult(await confirmCancel(token, requestRefund));
        } catch (err) {
            // A link that ran out or was spent -- even by this press, when
            // Stripe then failed -- cannot be tried again: offer a new one.
            if (err instanceof CancelError && LINK_DONE.has(err.code)) {
                setFailure(err);
                return;
            }
            setError(err instanceof Error ? err.message : 'Could not cancel. Please try again.');
            setBusy(false);
        }
    };

    if (failure) {
        if (LINK_DONE.has(failure.code)) {
            return <RequestLink notice={failure.message} />;
        }
        return (
            <BrandShell title="Cancel your subscription" subtitle={failure.message}>
                <SupportLine />
            </BrandShell>
        );
    }

    if (result && !result.cancelled) {
        return (
            <BrandShell
                title="Your account is being deleted"
                subtitle="Deleting your account cancels your subscription, so nothing was changed here."
            >
                <RefundOutcome result={result} />
                <p className="mt-3 text-center text-sm text-stone-600">
                    If the deletion does not go through, use this link again, or ask for a new one, to cancel.
                </p>
                <SupportLine />
            </BrandShell>
        );
    }

    if (result) {
        const ends = formatWhen(result.endsAt);
        return (
            <BrandShell
                title="Your subscription is cancelled"
                subtitle={`Cancelled ${formatWhen(result.cancelledAt) ?? 'just now'}. You won’t be charged again.`}
            >
                {ends ? <p className="text-center text-sm text-stone-700">You keep full access until {ends}.</p> : null}
                <RefundOutcome result={result} />
                <p className="mt-3 text-center text-sm text-stone-600">
                    A confirmation is on its way to your email. Changed your mind? Resume from your Account page before
                    then.
                </p>
                <SupportLine />
            </BrandShell>
        );
    }

    if (!summary) {
        return (
            <BrandShell title="Cancel your subscription">
                <LoadingText>Checking your link…</LoadingText>
            </BrandShell>
        );
    }

    const periodEnd = formatWhen(summary.periodEnd);
    const plan = summary.plan ? `Cleffy ${summary.plan}` : 'Your Cleffy subscription';
    if (summary.deletionPending) {
        // Launch-fix item 16: the deletion cancels the subscription itself, so
        // the only thing left to ask for here is the refund.
        return (
            <BrandShell title="Cancel your subscription" subtitle={summary.email ? `For ${summary.email}` : undefined}>
                <section className="rounded-2xl border border-stone-200 bg-white p-4 text-sm text-stone-700">
                    <p className="font-medium text-stone-900">{plan}</p>
                    <p className="mt-1">
                        This account is being deleted. Deleting it cancels this subscription, so there is nothing to
                        cancel here.
                    </p>
                </section>
                {summary.refundEligible ? (
                    <>
                        <p className="mt-4 text-sm text-stone-700">
                            You are within {REFUND_WINDOW_DAYS} days of your first purchase, so you can still ask for a
                            full refund.
                        </p>
                        {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}
                        <Button
                            variant="danger"
                            className="mt-5 w-full"
                            disabled={busy}
                            onClick={() => void cancel(true)}
                        >
                            {busy ? 'Sending…' : 'Request a full refund'}
                        </Button>
                    </>
                ) : null}
                <SupportLine />
            </BrandShell>
        );
    }
    return (
        <BrandShell title="Cancel your subscription" subtitle={summary.email ? `For ${summary.email}` : undefined}>
            <section className="rounded-2xl border border-stone-200 bg-white p-4 text-sm text-stone-700">
                <p className="font-medium text-stone-900">{plan}</p>
                {summary.alreadyCancelling ? (
                    <p className="mt-1">Already set to end{periodEnd ? ` on ${periodEnd}` : ''}. It will not renew.</p>
                ) : (
                    <p className="mt-1">
                        {periodEnd ? `Renews on ${periodEnd}. ` : ''}Cancelling stops the renewal; you keep access until
                        the end of the period you have paid for.
                    </p>
                )}
            </section>

            {summary.refundEligible ? (
                <label htmlFor={refundId} className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-stone-700">
                    <input
                        id={refundId}
                        type="checkbox"
                        checked={refund}
                        onChange={(event) => setRefund(event.target.checked)}
                        className="mt-0.5 size-4 shrink-0 accent-accent"
                    />
                    <span>
                        Also request a full refund — you are within {REFUND_WINDOW_DAYS} days of your first purchase.
                    </span>
                </label>
            ) : null}

            {error ? <ErrorText className="mt-3">{error}</ErrorText> : null}

            <Button variant="danger" className="mt-5 w-full" disabled={busy} onClick={() => void cancel()}>
                {busy ? 'Cancelling…' : summary.alreadyCancelling ? 'Confirm cancellation' : 'Cancel now'}
            </Button>
            <SupportLine />
        </BrandShell>
    );
};

/**
 * /cancel -- reachable from every footer, signed in or not (launch packet item
 * 19; CA BPC §17602(d), NY GBL §527-a). Without a token it is the email
 * lookup; with the token from the emailed link it is the "Cancel now" page.
 */
export const CancelPage = () => {
    const [params] = useSearchParams();
    const token = params.get('token');
    return token ? <ConfirmCancel token={token} /> : <RequestLink />;
};
