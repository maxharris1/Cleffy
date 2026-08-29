import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { serviceClient } from '../_shared/rateLimit.ts';
import { type SvixFailure, verifySvixSignature } from '../_shared/svixSignature.ts';

/**
 * Inbound support mail, delivered by Resend as an `email.received` webhook.
 *
 * Deployed with `verify_jwt = false` (see supabase/config.toml) for the same
 * structural reason `stripe-webhook` is: the caller has no Supabase JWT to
 * present. The Svix signature is the whole of the authentication, so a failure
 * to verify has to be a refusal rather than a warning.
 *
 * Deliberately no rate limit: throttling here would drop Svix's retries, and a
 * dropped retry is a support request nobody ever sees.
 *
 * The webhook carries metadata only — Resend's docs are explicit that the body,
 * headers and attachments are not in it — so the message itself is fetched from
 * the Received Emails API before anything is stored or forwarded.
 *
 * Order matters: **persist, then forward.** Storing first means a forward that
 * fails leaves a row with `forwarded_at` null, which is a visible, replayable
 * "arrived but nobody was told". Forwarding first and failing to store would
 * lose the message entirely on a retry that then no-ops.
 */

interface ReceivedEvent {
    type?: string;
    data?: {
        email_id?: string;
        created_at?: string;
        from?: string;
        to?: string[];
        received_for?: string[];
        message_id?: string;
        subject?: string;
        attachments?: unknown[];
    };
}

interface FetchedEmail {
    from?: string;
    to?: string[];
    subject?: string;
    text?: string;
    html?: string;
}

const RESEND_API = 'https://api.resend.com';

/** Where forwarded mail lands. Unset means store-only, which is a valid mode. */
const forwardTo = (): string | null => Deno.env.get('SUPPORT_FORWARD_TO') ?? null;

/**
 * The address forwards are sent FROM. It must be on a domain verified for
 * sending — `send.cleffy.io` is, the apex is not — and it must NOT be an address
 * this endpoint also receives at, or a forward would arrive back here and loop.
 */
const forwardFrom = (): string => Deno.env.get('SUPPORT_FORWARD_FROM') ?? 'Cleffy support <support@send.cleffy.io>';

const truncate = (value: string | undefined, max = 100_000): string | null => {
    if (!value) {
        return null;
    }
    return value.length > max ? `${value.slice(0, max)}\n\n[truncated]` : value;
};

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const signingSecret = Deno.env.get('RESEND_WEBHOOK_SECRET');
    const apiKey = Deno.env.get('RESEND_API_KEY');
    if (!signingSecret || !apiKey) {
        // 500 so Svix retries once we are configured again.
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // The RAW body — verification is over the exact bytes Svix signed, so this
    // must be read before (and instead of) any JSON parsing.
    const rawBody = await req.text();
    const check = await verifySvixSignature(
        rawBody,
        {
            id: req.headers.get('svix-id'),
            timestamp: req.headers.get('svix-timestamp'),
            signature: req.headers.get('svix-signature'),
        },
        signingSecret,
        Math.floor(Date.now() / 1000),
    );
    if (!check.ok) {
        // 400, not 401: Svix treats 4xx as "do not retry", which is right for a
        // signature that will never become valid.
        return jsonResponse({ error: 'Invalid signature', code: check.reason satisfies SvixFailure }, 400);
    }

    let event: ReceivedEvent;
    try {
        event = JSON.parse(rawBody) as ReceivedEvent;
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    // Resend sends other event types to the same endpoint if it is subscribed to
    // them; acknowledge and ignore rather than 4xx, which would look like a
    // delivery failure on their side.
    if (event.type !== 'email.received') {
        return jsonResponse({ ignored: event.type ?? 'unknown' }, 200);
    }

    const emailId = event.data?.email_id;
    if (!emailId) {
        return jsonResponse({ error: 'Malformed event' }, 400);
    }

    const admin = serviceClient();
    if (!admin) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // Claim first. A duplicate delivery loses the insert and returns here, which
    // is what stops a retry sending a second copy of the same email.
    const { data: claimed, error: claimError } = await admin
        .from('support_messages')
        .upsert(
            {
                resend_email_id: emailId,
                message_id: event.data?.message_id ?? null,
                from_address: event.data?.from ?? 'unknown',
                to_addresses: event.data?.to ?? [],
                received_for: event.data?.received_for ?? [],
                subject: event.data?.subject ?? null,
                attachments: event.data?.attachments ?? [],
                received_at: event.data?.created_at ?? new Date().toISOString(),
            },
            { onConflict: 'resend_email_id', ignoreDuplicates: true },
        )
        .select('id');
    if (claimError) {
        return jsonResponse({ error: `could not record ${emailId}: ${claimError.message}` }, 500);
    }
    const rowId = claimed?.[0]?.id;
    if (!rowId) {
        console.log(`duplicate inbound email ${emailId} ignored`);
        return jsonResponse({ duplicate: true }, 200);
    }

    // The body lives behind a second call; the webhook carries metadata only.
    let email: FetchedEmail = {};
    try {
        const res = await fetch(`${RESEND_API}/emails/received/${emailId}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (res.ok) {
            email = (await res.json()) as FetchedEmail;
        } else {
            console.error(`fetching inbound email ${emailId} returned ${res.status}`);
        }
    } catch (err) {
        console.error(`fetching inbound email ${emailId} failed: ${String(err)}`);
    }

    const text = truncate(email.text);
    const html = truncate(email.html);
    if (text || html) {
        await admin.from('support_messages').update({ text_body: text, html_body: html }).eq('id', rowId);
    }

    const to = forwardTo();
    if (!to) {
        // Store-only is a deliberate mode, not a failure: the row is the record.
        return jsonResponse({ stored: rowId, forwarded: false }, 200);
    }

    const from = event.data?.from ?? 'unknown sender';
    const subject = event.data?.subject ?? '(no subject)';
    try {
        const res = await fetch(`${RESEND_API}/emails`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: forwardFrom(),
                to: [to],
                // Replying goes to the person who wrote in, not to our own relay.
                reply_to: from,
                subject: `[cleffy support] ${subject}`,
                text: text ?? undefined,
                html: html ?? undefined,
                headers: { 'X-Cleffy-Inbound-Id': emailId },
            }),
        });
        if (!res.ok) {
            const detail = `${res.status} ${await res.text()}`.slice(0, 500);
            await admin.from('support_messages').update({ forward_error: detail }).eq('id', rowId);
            console.error(`forwarding ${emailId} failed: ${detail}`);
            // 200 on purpose: the message IS stored, so a Svix retry would only
            // hit the duplicate path and never retry the forward. The null
            // forwarded_at is the durable signal instead.
            return jsonResponse({ stored: rowId, forwarded: false }, 200);
        }
        await admin
            .from('support_messages')
            .update({ forwarded_at: new Date().toISOString(), forward_error: null })
            .eq('id', rowId);
        return jsonResponse({ stored: rowId, forwarded: true }, 200);
    } catch (err) {
        const detail = String(err).slice(0, 500);
        await admin.from('support_messages').update({ forward_error: detail }).eq('id', rowId);
        return jsonResponse({ stored: rowId, forwarded: false }, 200);
    }
});
