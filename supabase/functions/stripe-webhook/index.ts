import { claimNotice, emailOfUser, releaseNotice, sendBillingEmail, storefrontOrigin } from '../_shared/billingMail.ts';
import * as billingTerms from '../_shared/billingTerms.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import {
    type DeletedAccountStripe,
    FOREIGN_KEY_VIOLATION,
    stopDeletedAccountSubscription,
} from '../_shared/deletedAccountBilling.ts';
import { logError } from '../_shared/errorReporting.ts';
import { serviceClient } from '../_shared/rateLimit.ts';
import {
    cancelAndRefundDuplicate,
    priceTiers,
    servedModes,
    slotForPrice,
    stripeClient,
    type StripeMode,
    webhookSecretFor,
} from '../_shared/stripe.ts';
import {
    handleStripeEvent,
    STRIPE_EVENT_CLAIM_STALE_AFTER,
    STRIPE_SUBSCRIPTION_LOCK_STALE_AFTER,
    SUBSCRIPTION_MISSING,
    type StripeEventLike,
    type SubscriptionWriteOutcome,
    type WebhookStore,
} from '../_shared/stripeEvents.ts';
import { type SignatureFailure, verifyStripeSignature } from '../_shared/stripeSignature.ts';

/**
 * Stripe webhook receiver. Deployed with `verify_jwt = false` (see
 * supabase/config.toml) because Stripe has no Supabase JWT to present — the
 * request is authenticated by its signature instead, against this endpoint's
 * own signing secret.
 *
 * Both Stripe accounts post here, to the one URL this project has, and an event
 * carries no Origin to sort them by. The signature does that instead: each
 * account signs with its own endpoint secret, so whichever secret verifies IS
 * the account the event came from. That makes mode a *result* of authentication
 * rather than an input to it — nothing an unsigned caller sends can pick which
 * account its subscription lands in.
 *
 * Deliberately no rate limit: throttling here would drop Stripe's retries.
 *
 * All the decision logic lives in _shared/stripeEvents.ts so it can be unit
 * tested; this file is only I/O.
 */
/**
 * What write_subscription_under_lock answers with (migration 20261013120101).
 *
 * The duplicate-index and deleted-account cases used to be recognised here by
 * matching the constraint name inside PostgREST's error message -- neither a
 * documented contract, and a miss would have turned a real bug into an
 * acknowledged event. They are now named by the function, which reads the
 * constraint name out of Postgres's own diagnostics.
 */
type SubscriptionWriteAnswer = 'written' | 'lost_lock' | 'duplicate' | 'missing_user';

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    // Only the accounts this deployment serves. Production serves live alone, so
    // a sandbox event that still reaches it — the sandbox endpoint pointed here
    // for as long as dev shared this backend — verifies against nothing and is
    // refused rather than writing a test-mode row into the production database.
    const secrets: Array<[StripeMode, string]> = [];
    for (const candidate of servedModes()) {
        const secret = webhookSecretFor(candidate);
        if (secret) {
            secrets.push([candidate, secret]);
        }
    }
    if (secrets.length === 0) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // The RAW body — verification is over the exact bytes Stripe signed, so this
    // must be read before (and instead of) any JSON parsing.
    const rawBody = await req.text();
    const signature = req.headers.get('Stripe-Signature');
    const now = Math.floor(Date.now() / 1000);

    let mode: StripeMode | null = null;
    // A missing or malformed header fails identically against every secret, so
    // keep that structural reason rather than the mismatch it degrades into —
    // otherwise every misconfiguration reports as a bad signature.
    let failure: SignatureFailure = 'signature_mismatch';
    for (const [candidate, secret] of secrets) {
        const check = await verifyStripeSignature(rawBody, signature, secret, now);
        if (check.ok) {
            mode = candidate;
            break;
        }
        if (check.reason !== 'signature_mismatch') {
            failure = check.reason;
        }
    }
    if (!mode) {
        // 400, not 401: Stripe treats 4xx as "do not retry", which is right for a
        // signature that will never become valid.
        return jsonResponse({ error: 'Invalid signature', code: failure }, 400);
    }

    let event: StripeEventLike;
    try {
        event = JSON.parse(rawBody) as StripeEventLike;
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    if (!event?.id || typeof event.type !== 'string') {
        return jsonResponse({ error: 'Malformed event' }, 400);
    }
    // Belt and braces: the event's own livemode flag must agree with the secret
    // that verified it. Disagreement should be impossible, and writing a live
    // subscription row out of a sandbox event is not a way to find out.
    if (typeof event.livemode === 'boolean' && event.livemode !== (mode === 'live')) {
        return jsonResponse({ error: 'Event livemode disagrees with its signing secret' }, 400);
    }

    const admin = serviceClient();
    const stripe = stripeClient(mode);
    if (!admin || !stripe) {
        // 500 so Stripe retries once we are configured again.
        return jsonResponse({ error: 'Billing is not configured' }, 500);
    }

    // For a subscription whose user was deleted (see deletedAccountBilling.ts).
    const deletedAccountStripe: DeletedAccountStripe = {
        retrieveStatus: async (subscriptionId) => {
            try {
                return (await stripe.subscriptions.retrieve(subscriptionId)).status;
            } catch (err) {
                if ((err as { code?: string } | null)?.code === 'resource_missing') {
                    return null;
                }
                throw err;
            }
        },
        cancel: async (subscriptionId) => {
            await stripe.subscriptions.cancel(subscriptionId);
        },
    };

    /**
     * The subscription already recorded as entitling for this user and account —
     * the other half of the duplicate, for the alert. Best effort: the alert is
     * worth sending even if this read fails, and it is the only thing that
     * reads it.
     */
    const entitlingSubscriptionId = async (userId: string): Promise<string | null> => {
        const { data } = await admin
            .from('subscriptions')
            .select('stripe_subscription_id')
            .eq('user_id', userId)
            .eq('mode', mode)
            .in('status', ['active', 'trialing'])
            .maybeSingle();
        return data?.stripe_subscription_id ?? null;
    };

    /**
     * The stamp on the claim this invocation holds, so finishing and releasing
     * can both say "only while it is still mine". Null until the claim is taken,
     * and null again for a delivery that lost the claim to another one. Per
     * request, because this store is.
     */
    let claimedAt: string | null = null;

    const store: WebhookStore = {
        claimEvent: async (id, type) => {
            // One statement, so two concurrent deliveries of the same event
            // cannot both win -- and one that can also take over a claim whose
            // isolate died before it finished, which an upsert cannot express
            // (claim_stripe_event, migrations 20261012120101 and 120104). The
            // claim used to be an unconditional insert, so a death between
            // claiming and applying made every Stripe retry answer `200
            // duplicate`: for a checkout, a customer charged and never entitled.
            const { data, error } = await admin.rpc('claim_stripe_event', {
                p_id: id,
                p_type: type,
                p_stale_after: STRIPE_EVENT_CLAIM_STALE_AFTER,
            });
            if (error) {
                throw new Error(`could not claim event ${id}: ${error.message}`);
            }
            const row = (data as Array<{ state?: string; claimed_at?: string | null }> | null)?.[0];
            claimedAt = row?.state === 'claimed' ? (row.claimed_at ?? null) : null;
            if (claimedAt !== null) {
                return 'claimed';
            }
            // Anything that is not 'done' has not been applied by anyone: a live
            // claim, a stale one another delivery is about to take over, or a row
            // that vanished between the two statements. All of them want Stripe
            // to deliver again rather than to forget the event (QA round 4, D2
            // follow-up).
            return row?.state === 'done' ? 'done' : 'in_flight';
        },
        markEventDone: async (id) => {
            if (!claimedAt) {
                return;
            }
            // Scoped to our own claim: if ours went stale and another delivery
            // took it over, that delivery's claim is the live one and marking it
            // done would tell it its work had already landed.
            const { error } = await admin
                .from('stripe_events')
                .update({ status: 'done', processed_at: new Date().toISOString() })
                .eq('id', id)
                .eq('claimed_at', claimedAt);
            if (error) {
                // Thrown, so the caller releases the claim and asks Stripe to
                // retry: a claim left `processing` would be re-processed when it
                // went stale anyway, but an event whose outcome we are unsure of
                // is better re-run than left to a timer.
                throw new Error(`could not finish event ${id}: ${error.message}`);
            }
        },
        // The three lookups below are all filtered by mode as well as by the
        // Stripe id (QA round 4, D4). Stripe ids are globally unique, so no
        // deployment is exposed today -- but "globally unique" is a property of
        // Stripe's id space, not an invariant of this table, and every
        // ENFORCEMENT path (get_entitlements, entitling_billing_modes) is
        // already mode-filtered, so an unfiltered lookup here is the one place
        // a live event could have resolved its user through a test-mode row.
        //
        // What the filter changes is the fall-through: a row that exists only in
        // the OTHER mode now resolves to no user, and the handler answers 200
        // `unknown_user` with a log line rather than attributing the event to
        // whoever that row names. That is the right answer -- a live
        // subscription must not be recorded off a sandbox mapping -- and for a
        // deployment serving one account (production serves live alone) every
        // row carries that account's mode, so nothing changes at all.
        userIdForCustomer: async (customerId) => {
            const { data } = await admin
                .from('billing_customers')
                .select('user_id')
                .eq('stripe_customer_id', customerId)
                .eq('mode', mode)
                .maybeSingle();
            return data?.user_id ?? null;
        },
        linkCustomer: async (customerId, userId) => {
            const { error } = await admin
                .from('billing_customers')
                .upsert({ user_id: userId, mode, stripe_customer_id: customerId }, { onConflict: 'user_id,mode' });
            if (error) {
                // The user was deleted while their Checkout was open. Nothing to
                // link; the subscription write that follows hits the same FK and
                // cancels whatever the checkout started.
                if (error.code === FOREIGN_KEY_VIOLATION) {
                    console.log(`customer ${customerId} belongs to a deleted account; not linked`);
                    return;
                }
                throw new Error(`could not link customer ${customerId}: ${error.message}`);
            }
        },
        // The row is written by an RPC rather than by PostgREST's upsert because
        // the write has to be CONDITIONAL on this delivery still holding the
        // subscription's write lease, in the same statement (QA round 4 review of
        // #56, finding 3). Before, only the release checked whose lease it was,
        // so a delivery whose lease had gone stale -- a Stripe read slower than
        // the lease, which is shorter than an invocation may run -- still wrote
        // the state it had read minutes earlier, over the newer state the
        // delivery that took the lease over had just written.
        upsertSubscription: async (row, holder): Promise<SubscriptionWriteOutcome> => {
            const { data, error } = await admin.rpc('write_subscription_under_lock', {
                p_holder: holder,
                p_subscription_id: row.stripe_subscription_id,
                p_user: row.user_id,
                p_mode: mode,
                p_tier: row.tier,
                p_status: row.status,
                p_price_id: row.price_id,
                p_current_period_end: row.current_period_end,
                p_cancel_at_period_end: row.cancel_at_period_end,
                p_last_event_created_at: row.last_event_created_at,
            });
            if (error) {
                // 23503 on the only FK here (user_id → auth.users) is answered by
                // the function as `missing_user`, so an error that still carries
                // it is one raised somewhere this does not model. Everything else
                // is a failure the caller turns into a released claim and a 500.
                throw new Error(`could not write subscription ${row.stripe_subscription_id}: ${error.message}`);
            }
            switch (data as SubscriptionWriteAnswer) {
                case 'written':
                    return { outcome: 'written' };
                case 'lost_lock':
                    return { outcome: 'lost_lock' };
                case 'duplicate':
                    // This user already holds an entitling subscription in this
                    // account, so the double charge D1 describes has happened in
                    // Stripe even though no row records it.
                    return { outcome: 'duplicate', otherSubscriptionId: await entitlingSubscriptionId(row.user_id) };
                case 'missing_user':
                    // The account was deleted. Usually this is delete-account's
                    // own cancellation being reported; if the subscription can
                    // still bill, it is cancelled now. Either way there is no row
                    // to write, and the event is finished with.
                    await stopDeletedAccountSubscription(
                        row.stripe_subscription_id,
                        row.status,
                        deletedAccountStripe,
                        (message) => console.log(message),
                    );
                    return { outcome: 'written' };
                default:
                    throw new Error(
                        `write_subscription_under_lock answered ${String(data)} for ${row.stripe_subscription_id}`,
                    );
            }
        },
        fetchSubscription: async (subscriptionId) => {
            try {
                return await stripe.subscriptions.retrieve(subscriptionId);
            } catch (err) {
                console.error(`could not retrieve subscription ${subscriptionId}:`, err);
                // Stripe answered, and the answer is "no such subscription": a
                // retry cannot change that, so the handler acknowledges it
                // instead of collecting days of 500s. Everything else -- a
                // connection failure, a rate limit, a Stripe 5xx, even a bad
                // key -- may heal, so it becomes a released claim and a 500.
                const stripeError = err as { type?: unknown; code?: unknown } | null;
                if (stripeError?.type === 'StripeInvalidRequestError' && stripeError.code === 'resource_missing') {
                    return SUBSCRIPTION_MISSING;
                }
                return null;
            }
        },
        userIdForSubscription: async (subscriptionId) => {
            const { data } = await admin
                .from('subscriptions')
                .select('user_id')
                .eq('stripe_subscription_id', subscriptionId)
                .eq('mode', mode)
                .maybeSingle();
            return data?.user_id ?? null;
        },
        storedStatusOf: async (subscriptionId) => {
            const { data } = await admin
                .from('subscriptions')
                .select('status')
                .eq('stripe_subscription_id', subscriptionId)
                .eq('mode', mode)
                .maybeSingle();
            return data?.status ?? null;
        },
        applyFreeTierArchival: async (userId) => {
            const { data, error } = await admin.rpc('apply_free_tier_archival', { p_user: userId });
            if (error) {
                throw new Error(`could not archive past the free cap for ${userId}: ${error.message}`);
            }
            console.log(`archived ${data ?? 0} score(s) past the free cap for ${userId}`);
        },
        restorePlanArchivedScores: async (userId) => {
            const { data, error } = await admin.rpc('restore_plan_archived_scores', { p_user: userId });
            if (error) {
                throw new Error(`could not restore lapse-archived scores for ${userId}: ${error.message}`);
            }
            if (data) {
                console.log(`restored ${data} lapse-archived score(s) for ${userId}`);
            }
        },
        // The per-subscription write lock (migration 20261012120105): the Stripe
        // read-back and the row it writes are one step, so two deliveries about
        // the same subscription cannot land in the order they READ in rather
        // than the order they wrote in (QA round 4, D3 follow-up).
        lockSubscription: async (subscriptionId) => {
            const { data, error } = await admin.rpc('claim_subscription_write', {
                p_subscription_id: subscriptionId,
                p_stale_after: STRIPE_SUBSCRIPTION_LOCK_STALE_AFTER,
            });
            if (error) {
                throw new Error(`could not lock subscription ${subscriptionId}: ${error.message}`);
            }
            return typeof data === 'string' ? data : null;
        },
        unlockSubscription: async (subscriptionId, holder) => {
            const { error } = await admin.rpc('release_subscription_write', {
                p_subscription_id: subscriptionId,
                p_holder: holder,
            });
            if (error) {
                // Not thrown: the work is done, the answer is already decided,
                // and the lease goes stale on its own. Loud, because until it
                // does, every event about this subscription is refused.
                console.error(`could not unlock subscription ${subscriptionId}: ${error.message}`);
            }
        },
        cancelDuplicateSubscription: (subscriptionId) => cancelAndRefundDuplicate(stripe, subscriptionId),
        // The duplicate-undo ledger (migration 20261013120102). What it is for:
        // a refund that fails asks Stripe to redeliver, but by then the cancel
        // has succeeded, so the redelivery reads the subscription back as
        // `canceled`, the duplicate index has nothing to refuse, and the refund
        // is never attempted again -- with nothing left recording that it was
        // owed (QA round 4 review of #56, finding 2).
        pendingDuplicateUndo: async (subscriptionId) => {
            const { data, error } = await admin.rpc('pending_duplicate_refund', {
                p_subscription_id: subscriptionId,
                p_mode: mode,
            });
            if (error) {
                // Thrown rather than treated as "nothing owed": a read we could
                // not make is not an answer, and the caller turns this into a
                // released claim and a 500, so the next delivery asks again.
                throw new Error(`could not read the duplicate-refund ledger for ${subscriptionId}: ${error.message}`);
            }
            const row = (data as Array<{ user_id?: string | null }> | null)?.[0];
            return row ? { userId: row.user_id ?? null } : null;
        },
        recordPendingDuplicateUndo: async (subscriptionId, userId) => {
            const { error } = await admin.rpc('record_duplicate_refund', {
                p_subscription_id: subscriptionId,
                p_mode: mode,
                p_user: userId,
            });
            if (error) {
                // Before the Stripe calls, and loudly: a duplicate we cannot
                // write down is one we would lose track of the moment this
                // invocation ends, which is the whole failure being fixed.
                throw new Error(`could not record the duplicate refund owed on ${subscriptionId}: ${error.message}`);
            }
        },
        settleDuplicateUndo: async (subscriptionId, state, undone) => {
            const { error } = await admin.rpc('settle_duplicate_refund', {
                p_subscription_id: subscriptionId,
                p_mode: mode,
                p_state: state,
                p_stopped: undone.stopped,
                p_refund: undone.refund,
                p_detail: undone.detail,
            });
            if (error) {
                // NOT thrown. The Stripe half is already done; a ledger row left
                // `pending` is retried by the next delivery, and both halves are
                // safe to repeat. Throwing would instead lose the 200 that says
                // the duplicate was dealt with.
                console.error(`could not settle the duplicate refund on ${subscriptionId}: ${error.message}`);
            }
        },
        releaseEvent: async (id) => {
            if (!claimedAt) {
                return;
            }
            const { error } = await admin.from('stripe_events').delete().eq('id', id).eq('claimed_at', claimedAt);
            if (error) {
                // Nothing more to do from here: the retry will read as a
                // duplicate. Loud, because that is a lost billing event.
                console.error(`could not release claim on ${id}: ${error.message}`);
            }
        },
        notifyPurchase: async (notice) => {
            // The consent record first: it is the half with legal weight, and it
            // is idempotent, so a redelivery that gets this far again only
            // rewrites the same values. Matched by the id stripe-checkout put in
            // the session metadata, or failing that by the session itself.
            const completion = {
                stripe_subscription_id: notice.subscriptionId,
                checkout_session_id: notice.sessionId,
                billing_country: notice.billingCountry,
                completed_at: notice.purchasedAt,
            };
            const linked = notice.consentId
                ? await admin.from('checkout_consents').update(completion).eq('id', notice.consentId)
                : await admin.from('checkout_consents').update(completion).eq('checkout_session_id', notice.sessionId);
            if (linked.error) {
                console.log(`ALERT could not complete the consent for ${notice.sessionId}: ${linked.error.message}`);
            }

            if (!(await claimNotice('purchase_confirmation', notice.sessionId))) {
                return;
            }
            const email = await emailOfUser(notice.userId);
            const slot = notice.priceId ? slotForPrice(notice.priceId) : null;
            const currency = (billingTerms.CURRENCIES as readonly string[]).includes(notice.currency ?? '')
                ? (notice.currency as billingTerms.Currency)
                : null;
            if (!email || !slot || !currency || notice.amountTotalMinor === null) {
                await releaseNotice('purchase_confirmation', notice.sessionId);
                throw new Error(
                    `purchase confirmation for ${notice.sessionId} lacks ` +
                        [!email && 'an email', !slot && 'a known price', !currency && 'a known currency']
                            .filter(Boolean)
                            .join(', '),
                );
            }
            const message = billingTerms.purchaseConfirmationEmail({
                planName: billingTerms.PLAN_NAMES[slot],
                interval: billingTerms.PLAN_INTERVALS[slot],
                currency,
                amountTotalMinor: notice.amountTotalMinor,
                amountTaxMinor: notice.amountTaxMinor,
                renewsAtMs: notice.renewsAt ? Date.parse(notice.renewsAt) : null,
                purchasedAtMs: Date.parse(notice.purchasedAt),
                origin: storefrontOrigin(mode),
                termsVersion: billingTerms.LEGAL_VERSIONS.terms,
                refundsVersion: billingTerms.LEGAL_VERSIONS.refunds,
            });
            const sent = await sendBillingEmail(email, message, { tag: 'purchase_confirmation' });
            if (sent !== 'sent') {
                await releaseNotice('purchase_confirmation', notice.sessionId);
                throw new Error(`purchase confirmation for ${notice.sessionId}: ${sent}`);
            }
        },
        notifyCancellation: async (notice) => {
            const key = `${notice.subscriptionId}:${notice.endsAt ?? 'open'}`;
            if (!(await claimNotice('cancellation_confirmation', key))) {
                return;
            }
            const email = await emailOfUser(notice.userId);
            if (!email) {
                await releaseNotice('cancellation_confirmation', key);
                throw new Error(`cancellation confirmation for ${notice.subscriptionId} has no address`);
            }
            const slot = notice.priceId ? slotForPrice(notice.priceId) : null;
            const message = billingTerms.cancellationConfirmationEmail({
                planName: slot ? billingTerms.PLAN_NAMES[slot] : null,
                cancelledAtMs: Date.parse(notice.cancelledAt),
                endsAtMs: notice.endsAt ? Date.parse(notice.endsAt) : null,
                origin: storefrontOrigin(mode),
            });
            const sent = await sendBillingEmail(email, message, { tag: 'cancellation_confirmation' });
            if (sent !== 'sent') {
                await releaseNotice('cancellation_confirmation', key);
                throw new Error(`cancellation confirmation for ${notice.subscriptionId}: ${sent}`);
            }
        },
        log: (message) => console.log(message),
    };

    try {
        const result = await handleStripeEvent(event, store, priceTiers(mode));
        return jsonResponse(result.body, result.status);
    } catch (err) {
        // The claim is committed the moment it succeeds, so a failure downstream
        // of it would make Stripe's retry look like a duplicate and silently drop
        // the event. Release the claim first, then ask for the retry with a 500.
        // Re-running is safe: every store write is an upsert or is idempotent.
        await store.releaseEvent(event.id);
        logError('stripe-webhook', err, { code: 'event_failed', eventId: event.id, eventType: event.type, mode });
        return jsonResponse({ error: err instanceof Error ? err.message : 'Webhook handling failed' }, 500);
    }
});
