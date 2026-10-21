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
