import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Read-only seats are read-only everywhere, at once (migration
 * 20261020180600_read_only_seats_enforced.sql; Codex round-2 review of PR #61,
 * major 1). tests/sql/district_read_only_seats.sql proves it against a real
 * database: a seat the clock alone made read-only, before any reconcile has
 * archived anything, can write nothing on its own score or a shared one (marks,
 * both batch RPCs, a tombstone, lesson history, live ink, a rename, a share
 * link, an assignment) while view, export, presence, an active seat and a
 * roster student's Edit are untouched. What CI holds here, without a database:
 * every one of those write paths still carries the check, as a restrictive
 * policy or a trigger keyed on the CALLER's seat.
 *
 * Resolved from the project root: the jsdom test environment gives import.meta a
 * non-file URL, so fileURLToPath cannot be used here.
 */

const read = (...segments: string[]): string => readFileSync(resolve(process.cwd(), ...segments), 'utf8');
const SQL = read('supabase/migrations', '20261020180600_read_only_seats_enforced.sql');
const PROOF = read('tests/sql', 'district_read_only_seats.sql');

const CHECK = String.raw`not \(select public\.caller_seat_read_only \(\)\)`;

describe('the read-only seat check', () => {
    it('asks resolve_entitlements(), so it is right the moment the clock or a row moves a seat', () => {
        expect(SQL).toMatch(/public\.resolve_entitlements \(p_user\) ->> 'seat_read_only'/);
    });

    it('is about the caller, never the score’s owner, so a roster student keeps Edit', () => {
        expect(SQL).toMatch(/select public\.seat_read_only \(auth\.uid\(\)\);/);
        expect(SQL).not.toMatch(/seat_read_only \([a-z_.]*owner/i);
    });

    it.each([
        ['annotations_seat_read_only_insert', 'public.annotations', 'insert'],
        ['annotations_seat_read_only_update', 'public.annotations', 'update'],
        ['annotation_snapshots_seat_read_only_insert', 'public.annotation_snapshots', 'insert'],
        ['share_links_seat_read_only_insert', 'public.share_links', 'insert'],
    ])('%s is a restrictive policy on %s %s', (name, table, command) => {
        const policy = new RegExp(
            `create policy ${name} on ${table.replace('.', '\\.')} as restrictive for ${command} to authenticated[\\s\\S]*?with check \\(${CHECK}\\);`,
        );
        expect(SQL).toMatch(policy);
    });

    it('refuses live ink on doc:{id} but not presence', () => {
        expect(SQL).toMatch(
            /create policy doc_topic_seat_read_only_broadcast on realtime\.messages as restrictive for insert to authenticated/,
        );
        expect(SQL).toMatch(/realtime\.messages\.extension is distinct from 'broadcast'/);
        expect(SQL).toMatch(/realtime\.topic \(\) not like 'doc:%'/);
    });

    it('reaches assign_score (SECURITY DEFINER) and a score’s rename or new file by trigger', () => {
        expect(SQL).toMatch(/create trigger assignments_refuse_read_only_seat before insert on public\.assignments/);
        expect(SQL).toMatch(/create trigger documents_refuse_read_only_seat before update on public\.documents/);
        expect(SQL).toMatch(
            /new\.title is distinct from old\.title or new\.content_rev is distinct from old\.content_rev/,
        );
    });

    it('never re-creates another migration’s permissive policy, so it cannot undo one', () => {
        expect(SQL).not.toMatch(
            /drop policy if exists (annotations_insert|annotations_update|doc_topic_send_broadcast)\b/,
        );
        expect(SQL).not.toMatch(/create policy \w+ on [\w.]+ for /);
    });

    it('lets the caller ask only about themself', () => {
        expect(SQL).toMatch(/grant execute on function public\.caller_seat_read_only \(\) to authenticated;/);
        expect(SQL).toMatch(/revoke all on function public\.seat_read_only \(uuid\) from authenticated;/);
        expect(SQL).not.toMatch(/grant execute on function public\.seat_read_only \(uuid\) to authenticated/);
    });
});

describe('the SQL proof', () => {
    it('makes the seat read-only by the clock alone, before anything has reconciled', () => {
        expect(PROOF).toMatch(/set local session_replication_role = replica;/);
        expect(PROOF).toMatch(/nothing has reconciled: b6''s own score is not archived/);
    });

    it.each([
        'no new mark on their own (unarchived) score',
        'no new mark on the shared score',
        'no change to an existing mark on the shared score',
        'nor through insert_annotations_batch',
        'nor through patch_annotations_batch',
        'no live ink on doc:{id}',
        'and keeps Edit on the score assigned to them',
        'b6 marks the shared score again',
    ])('checks: %s', (name) => {
        expect(PROOF).toContain(`'${name}'`);
    });
});

/**
 * The score files (migration 20261020180700_read_only_seats_storage.sql; Codex
 * round-3 review of #61): the PDF in the 'scores' bucket cannot be replaced,
 * added to or removed by a read-only seat through the Storage API, while
 * downloads and the thumbnails bucket are untouched and a deleted score's
 * files can still be cleaned up. tests/sql/district_read_only_seats.sql proves
 * it against a database and tests/live/readOnlySeatStorage.live.test.ts against
 * the Storage API.
 */
describe('the read-only seat check on Storage', () => {
    const STORAGE = read('supabase/migrations', '20261020180700_read_only_seats_storage.sql');
    const SCORES_ONLY = String.raw`bucket_id is distinct from 'scores' or ${CHECK}`;

    it.each(['insert', 'update', 'delete'])('restricts %s on score files with the same helper', (command) => {
        expect(STORAGE).toMatch(
            new RegExp(
                `drop policy if exists scores_seat_read_only_${command} on storage\\.objects;\\s*create policy scores_seat_read_only_${command} on storage\\.objects as restrictive for ${command} to authenticated`,
            ),
        );
    });

    it('checks both the row it replaces and the row it writes, so an upsert is refused', () => {
        expect(STORAGE).toMatch(new RegExp(`for insert to authenticated\\s*with check \\(${SCORES_ONLY}\\);`));
        expect(STORAGE).toMatch(
            new RegExp(`for update to authenticated\\s*using \\(${SCORES_ONLY}\\)\\s*with check \\(${SCORES_ONLY}\\);`),
        );
    });

    it('still lets a deleted score’s files be cleaned up', () => {
        expect(STORAGE).toMatch(
            new RegExp(
                `for delete to authenticated\\s*using \\(\\s*bucket_id is distinct from 'scores'\\s*or ${CHECK}\\s*or public\\.document_storage_cleanup_pending \\(\\(storage\\.foldername \\(name\\)\\)\\[1\\]\\)\\s*\\);`,
            ),
        );
    });

    it('changes no read path and no other bucket', () => {
        const code = STORAGE.replace(/--[^\n]*/g, '');
        expect(code).not.toMatch(/for select/i);
        expect(code).not.toMatch(/thumbnails/);
        expect(STORAGE).not.toMatch(/create policy \w+ on storage\.objects for /);
    });

    it.each([
        'no replacing their own PDF through Storage (upload with upsert)',
        "no new file in their own score''s folder (an import backup)",
        "no deleting their own live score''s PDF: it matches nothing",
        'but still reads (downloads) it',
        'and then its PDF, under the storage-cleanup tombstone',
        'and replaces its PDF through Storage again',
    ])('the SQL proof checks: %s', (name) => {
        expect(PROOF).toContain(`'${name}'`);
    });
});

/**
 * Live ink on a channel opened before the seat changed (migration
 * 20261020180800_read_only_seats_live_ink.sql; Codex round-3 review of #61).
 * Realtime keeps a channel's send permission from its join until the next
 * token refresh, so the change itself acts: the seat is recorded, the
 * membership hint goes to every score it can write on (the viewer re-reads its
 * seat and drops to view only, restarting its channel), and PR #63's topic
 * rotation is called when present to cut off a client that ignores it.
 * tests/sql/district_read_only_seats.sql and
 * tests/live/readOnlySeatLiveInk.live.test.ts prove it.
 */
describe('a seat change reaches live ink that is already flowing', () => {
    const LIVE = read('supabase/migrations', '20261020180800_read_only_seats_live_ink.sql');
    const fn = (name: string) => {
        const start = LIVE.indexOf(`create or replace function public.${name} (`);
        const open = LIVE.indexOf('$$', start);
        return LIVE.slice(start, LIVE.indexOf('$$', open + 2));
    };

    it('acts on the change, recorded per account, not on every sweep', () => {
        expect(fn('seat_live_ink_follow')).toMatch(
            /insert into public\.seat_read_only_since \(user_id\) values \(p_user\) on conflict \(user_id\) do nothing;\s*if found then\s*perform public\.seat_live_ink_notify \(p_user, true\);/,
        );
        expect(fn('seat_live_ink_follow')).toMatch(
            /delete from public\.seat_read_only_since s where s\.user_id = p_user;\s*if found then\s*perform public\.seat_live_ink_notify \(p_user, false\);/,
        );
    });

    it('follows every member wherever seats move, and a removed member too', () => {
        expect(fn('reconcile_studio_seats')).toMatch(/perform public\.seat_live_ink_follow \(v_member, v_read_only\);/);
        expect(fn('studio_members_release_seat')).toMatch(
            /perform public\.seat_live_ink_follow \(old\.user_id, public\.seat_read_only \(old\.user_id\)\);/,
        );
    });

    it('hints on every score the account can write on, with the payload the app already follows', () => {
        const notify = fn('seat_live_ink_notify');
        expect(notify).toMatch(/from public\.documents d where d\.owner_id = p_user/);
        expect(notify).toMatch(/dm\.role in \('owner', 'editor'\)/);
        expect(notify).toMatch(
            /jsonb_build_object\('table', 'document_members', 'document_id', v_doc, 'user_id', p_user, 'role', v_role\),\s*'membership',/,
        );
    });

    it('rotates the score’s topics through #63 when it is there, and only on the way to read-only', () => {
        const notify = fn('seat_live_ink_notify');
        expect(notify).toMatch(
            /v_rotate boolean := p_rotate and to_regprocedure\('public\.rotate_document_realtime\(uuid\)'\) is not null;/,
        );
        expect(notify).toMatch(/execute 'select public\.rotate_document_realtime \(\$1\)' using v_doc;/);
        expect(notify).toMatch(/to_regprocedure\('public\.document_live_topic\(uuid\)'\)/);
    });

    it('keeps the record and the functions from every client role', () => {
        expect(LIVE).toMatch(/alter table public\.seat_read_only_since enable row level security;/);
        for (const role of ['public', 'anon', 'authenticated']) {
            expect(LIVE).toContain(`revoke all on table public.seat_read_only_since from ${role};`);
            expect(LIVE).toContain(`revoke all on function public.seat_live_ink_notify (uuid, boolean) from ${role};`);
            expect(LIVE).toContain(`revoke all on function public.seat_live_ink_follow (uuid, boolean) from ${role};`);
        }
        expect(LIVE).not.toMatch(/grant [^;]* to (anon|authenticated)/);
    });
});

/**
 * Grace that runs out on the clock alone stops live ink at the deadline itself
 * (migration 20261020181100_read_only_seats_grace_deadline.sql; decision 26,
 * Codex round-4 review of #61, D2 partial). Realtime keeps a broadcast answer
 * until the token changes, so the answer is refused whenever the district's
 * grace ends before the token does. tests/sql/district_read_only_seats.sql and
 * tests/live/readOnlySeatGraceDeadline.live.test.ts prove it; CI holds the shape.
 */
describe('live ink cannot outlive a grace deadline', () => {
    const GRACE = read('supabase/migrations', '20261020181100_read_only_seats_grace_deadline.sql');

    it('is a restrictive broadcast policy on doc:{id}, presence untouched', () => {
        expect(GRACE).toMatch(
            /create policy doc_topic_seat_grace_broadcast on realtime\.messages as restrictive for insert to authenticated/,
        );
        expect(GRACE).toMatch(/realtime\.messages\.extension is distinct from 'broadcast'/);
        expect(GRACE).toMatch(/realtime\.topic \(\) not like 'doc:%'/);
        expect(GRACE).toMatch(/or not \(select public\.caller_seat_grace_ends_before_token \(\)\)/);
    });

    it('compares the stored grace deadline with the token Realtime is authorizing (no exp: never expires)', () => {
        expect(GRACE).toMatch(
            /public\.seat_grace_deadline \(auth\.uid\(\)\)\s*<= coalesce\(to_timestamp\(nullif\(auth\.jwt \(\) ->> 'exp', ''\)::double precision\), 'infinity'::timestamptz\)/,
        );
        expect(GRACE).toMatch(/min\(public\.district_grace_ends_at \(s\.stripe_subscription_id, s\.past_due_since\)\)/);
        expect(GRACE).toMatch(/and public\.subscription_is_live \(s\)/);
    });

    it('keeps the deadline lookup from every client role', () => {
        for (const role of ['public', 'anon', 'authenticated']) {
            expect(GRACE).toContain(`revoke all on function public.seat_grace_deadline (uuid) from ${role};`);
        }
        expect(GRACE).not.toMatch(/grant [^;]* public\.seat_grace_deadline [^;]* to (anon|authenticated)/);
    });
});
