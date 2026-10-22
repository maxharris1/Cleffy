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
