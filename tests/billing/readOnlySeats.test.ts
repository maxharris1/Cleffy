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
