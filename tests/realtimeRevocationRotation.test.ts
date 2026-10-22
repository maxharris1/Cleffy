import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Access that ends must move the score's realtime topics at once
 * (20261022120000_realtime_revocation_rotation.sql): Realtime authorizes a
 * channel at join, so without a rotation a member who lost a score keeps its
 * live ink and committed marks until their token runs out.
 * tests/sql/realtime_revocation_rotation.sql proves it against a database;
 * this keeps a later migration from quietly dropping or narrowing a trigger,
 * since CI's unit job runs no SQL.
 */
const MIGRATIONS_DIR = 'supabase/migrations';

const migrations = (): string[] =>
    readdirSync(resolve(process.cwd(), MIGRATIONS_DIR))
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .reverse();

const read = (name: string): string => readFileSync(resolve(process.cwd(), MIGRATIONS_DIR, name), 'utf8');

/** The newest match of `pattern` across the migrations, newest file first. */
const latest = (pattern: RegExp, what: string): string => {
    for (const name of migrations()) {
        const match = read(name).match(pattern);
        if (match) {
            return match[0];
        }
    }
    throw new Error(`no migration defines ${what}`);
};

const latestFunction = (fn: string): string =>
    latest(new RegExp(`create or replace function public\\.${fn}\\b[\\s\\S]*?\\$\\$;`, 'i'), `public.${fn}`);

/** The newest `create [constraint] trigger <name>` statement. */
const latestTrigger = (name: string): string =>
    latest(new RegExp(`create (?:constraint )?trigger ${name}\\b[\\s\\S]*?;`, 'i'), `trigger ${name}`);

/** No migration after the one that creates `name` drops it without creating it again. */
const neverDroppedAfterCreate = (name: string): boolean => {
    for (const file of migrations()) {
        const sql = read(file);
        const created = Math.max(
            sql.lastIndexOf(`create trigger ${name}`),
            sql.lastIndexOf(`create constraint trigger ${name}`),
        );
        const dropped = sql.lastIndexOf(`drop trigger if exists ${name}`);
        if (created > -1 || dropped > -1) {
            return created > dropped;
        }
    }
    return false;
};

describe('a lost membership moves the score to fresh realtime topics', () => {
    it('rotates once per score per transaction, at commit', () => {
        const trigger = latestTrigger('document_realtime_rotation_queue_rotate');
        expect(trigger).toMatch(/after insert on public\.document_realtime_rotation_queue/);
        expect(trigger).toMatch(/deferrable initially deferred/);
        expect(neverDroppedAfterCreate('document_realtime_rotation_queue_rotate')).toBe(true);

        const rotate = latestFunction('rotate_queued_document_realtime');
        // This transaction's queue only, in a fixed order, through the takedown's rotation.
        expect(rotate).toMatch(/q\.xact = pg_current_xact_id \(\)/);
        expect(rotate).toMatch(/order by q\.document_id/);
        expect(rotate).toMatch(/perform public\.rotate_document_realtime \(v_doc\)/);

        expect(latestFunction('queue_document_realtime_rotation')).toMatch(/on conflict do nothing/);
    });

    it('queues a removed member, and an owner or editor who loses write', () => {
        const remove = latestTrigger('document_members_rotate_on_delete');
        expect(remove).toMatch(/after delete on public\.document_members/);
        expect(remove).toMatch(/document_members_queue_rotation \(\)/);

        const downgrade = latestTrigger('document_members_rotate_on_downgrade');
        expect(downgrade).toMatch(/after update of role on public\.document_members/);
        expect(downgrade).toMatch(/old\.role in \('owner', 'editor'\) and new\.role not in \('owner', 'editor'\)/);

        for (const name of ['document_members_rotate_on_delete', 'document_members_rotate_on_downgrade']) {
            expect(neverDroppedAfterCreate(name), name).toBe(true);
        }
        expect(latestFunction('document_members_queue_rotation')).toMatch(
            /queue_document_realtime_rotation \(old\.document_id\)/,
        );
    });

    it("queues every score a student is on when the student's access ends", () => {
        const trigger = latestTrigger('managed_students_rotate_on_access_end');
        expect(trigger).toMatch(/after update of archived_at, access_revoked_at on public\.managed_students/);
        expect(trigger).toMatch(/old\.archived_at is null/);
        expect(trigger).toMatch(/new\.archived_at is not null/);
        expect(trigger).toMatch(/new\.access_revoked_at is distinct from old\.access_revoked_at/);
        expect(neverDroppedAfterCreate('managed_students_rotate_on_access_end')).toBe(true);

        const queue = latestFunction('managed_students_queue_rotation');
        expect(queue).toMatch(/from public\.document_members dm where dm\.user_id = new\.student_user_id/);
        expect(queue).toMatch(/from public\.assignments a where a\.student_user_id = new\.student_user_id/);
    });
});

/**
 * 20261022120100_realtime_revocation_races.sql (Codex round 1 on #71);
 * tests/sql/realtime_revocation_race.sql proves each race between two sessions.
 */
describe('revocation rotation under concurrency', () => {
    it('makes every grant take the student’s roster lock, and refuses an archived student’s assignment under it', () => {
        expect(latestFunction('lock_student_for_grant')).toMatch(
            /from public\.managed_students ms\s+where ms\.student_user_id = p_user\s+for share;/,
        );
        const assignments = latestTrigger('assignments_lock_student');
        expect(assignments).toMatch(/before insert on public\.assignments/);
        expect(latestFunction('assignments_lock_student')).toMatch(
            /if public\.lock_student_for_grant \(new\.student_user_id\) then\s+raise exception 'not on your roster' using errcode = 'P0002'/,
        );
        const members = latestTrigger('document_members_lock_student');
        expect(members).toMatch(/before insert on public\.document_members/);
        expect(latestFunction('document_members_lock_student')).toMatch(/lock_student_for_grant \(new\.user_id\)/);
        for (const name of ['assignments_lock_student', 'document_members_lock_student']) {
            expect(neverDroppedAfterCreate(name), name).toBe(true);
        }
    });

    it('never waits on the score at commit, and still forgets a deleted score’s generation', () => {
        const rotate = latestFunction('rotate_queued_document_realtime');
        expect(rotate).not.toMatch(/for (key )?share/i);
        expect(rotate).toMatch(/if exists \(select 1 from public\.documents d where d\.id = v_doc\) then/);
        expect(
            latest(/alter table public\.document_realtime_epochs\s+drop constraint[^;]*;/i, 'the dropped key'),
        ).toMatch(/document_realtime_epochs_document_id_fkey/);
        expect(latestTrigger('documents_forget_realtime_epoch')).toMatch(/after delete on public\.documents/);
        expect(neverDroppedAfterCreate('documents_forget_realtime_epoch')).toBe(true);
        expect(latestFunction('documents_forget_realtime_epoch')).toMatch(
            /delete from public\.document_realtime_epochs e where e\.document_id = old\.id/,
        );
    });

    it('announces each rotation on the generation it replaced', () => {
        const rotate = latestFunction('rotate_document_realtime');
        expect(rotate.indexOf('returning e.epoch into v_epoch')).toBeLessThan(rotate.indexOf('realtime.send'));
        expect(rotate).not.toMatch(/document_live_topic|document_db_topic/);
        // The same names the app builds (docTopic / docDbTopic).
        expect(latestFunction('document_topic_at')).toMatch(
            /p_prefix \|\| ':' \|\| doc::text \|\| case when p_epoch = 0 then '' else ':' \|\| p_epoch::text end/,
        );
    });

    it('gives an archived score no realtime, and moves it when it is archived', () => {
        for (const fn of ['topic_document_role', 'db_topic_document_role']) {
            expect(latestFunction(fn), fn).toMatch(
                /if doc is null or public\.document_is_archived \(doc\) then\s+return null;/,
            );
        }
        expect(latestFunction('realtime_topic_epoch')).toMatch(
            /public\.document_role \(p_document\) is not null and not public\.document_is_archived \(p_document\)/,
        );
        const archive = latestTrigger('documents_rotate_on_archive');
        expect(archive).toMatch(/after update of archived_at on public\.documents/);
        expect(archive).toMatch(/old\.archived_at is null and new\.archived_at is not null/);
        expect(neverDroppedAfterCreate('documents_rotate_on_archive')).toBe(true);
        expect(latestFunction('documents_queue_rotation_on_archive')).toMatch(
            /queue_document_realtime_rotation \(new\.id\)/,
        );
    });

    it('tells a member of an archived score to wait, apart from a lost score (20261022120200)', () => {
        const access = latestFunction('realtime_topic_access');
        // Null first, for anyone document_role() refuses: no reason leaks.
        const denied = access.indexOf('when public.document_role (p_document) is null then null');
        const archived = access.indexOf(
            "when public.document_is_archived (p_document) then jsonb_build_object('status', 'archived')",
        );
        expect(denied).toBeGreaterThan(-1);
        expect(archived).toBeGreaterThan(denied);
        expect(access).toMatch(
            /else jsonb_build_object\('status', 'open', 'epoch', public\.document_realtime_epoch \(p_document\)\)/,
        );
        // Restoring still rotates nothing: the waiting members join the current generation.
        expect(latestTrigger('documents_rotate_on_archive')).toMatch(
            /old\.archived_at is null and new\.archived_at is not null/,
        );
    });

    it('redeems a share link with the roster row locked before the membership (20261022120200)', () => {
        const redeem = latestFunction('redeem_share_link');
        const roster = redeem.indexOf('perform public.lock_student_for_grant (v_uid);');
        expect(roster).toBeGreaterThan(-1);
        expect(roster).toBeLessThan(redeem.indexOf('for update;'));
        expect(roster).toBeLessThan(redeem.indexOf('insert into public.document_members'));
    });
});
