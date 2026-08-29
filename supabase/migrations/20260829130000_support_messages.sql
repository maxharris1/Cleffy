-- Inbound support mail, as received by Resend.
--
-- The endpoint that fills this table (`resend-inbound`) forwards each message on
-- to a human mailbox, but forwarding is delivery, not storage: a forward that
-- bounces is gone, and a mailbox is a poor thing to query. This table is the
-- durable record — the one an agentic triage pass reads from later, rather than
-- re-parsing email.
--
-- `resend_email_id` is UNIQUE and that is load-bearing, exactly as
-- `stripe_events.id` is: Svix retries a delivery until it gets a 2xx, so the
-- same message arrives more than once as a matter of routine, and the insert is
-- what makes the second arrival a no-op instead of a second forwarded email.
--
-- No RLS policy is declared, deliberately. RLS is enabled and every grant is
-- revoked, so the table is reachable only by the service role — i.e. only from
-- an Edge Function. Support mail is written by strangers and can contain
-- anything a customer chose to type: an account number, a password they should
-- not have sent, a complaint about another user. None of it belongs in a
-- browser, so no client role can read it at all.
create table public.support_messages (
    id uuid primary key default gen_random_uuid(),
    -- Resend's id for the received email; the idempotency key.
    resend_email_id text not null unique,
    -- The sending mail system's Message-ID, kept for threading a reply later.
    message_id text,
    from_address text not null,
    to_addresses text[] not null default '{}',
    -- Which of our addresses actually accepted it. With a catch-all domain this
    -- is how triage tells support@ from billing@ without parsing `to`.
    received_for text[] not null default '{}',
    subject text,
    text_body text,
    html_body text,
    -- Metadata only. Attachment bytes stay in Resend; storing them here would
    -- put unscanned stranger-supplied files in our own bucket.
    attachments jsonb not null default '[]'::jsonb,
    -- Null until the forward succeeds. A row with received_at set and
    -- forwarded_at null is precisely the "arrived but nobody was told" case,
    -- which is the one worth alerting on.
    forwarded_at timestamptz,
    forward_error text,
    received_at timestamptz not null,
    created_at timestamptz not null default now()
);

create index support_messages_received on public.support_messages (received_at desc);

-- Finds the arrived-but-not-forwarded rows without scanning the table.
create index support_messages_unforwarded on public.support_messages (received_at desc) where forwarded_at is null;

alter table public.support_messages enable row level security;

revoke all on table public.support_messages from public;

revoke all on table public.support_messages from anon;

revoke all on table public.support_messages from authenticated;

grant all on table public.support_messages to service_role;
