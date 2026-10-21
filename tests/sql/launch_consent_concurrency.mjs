#!/usr/bin/env node
/**
 * Launch consent: the races a single-transaction SQL proof cannot show.
 *
 * launch_consent.sql runs in one transaction, so it can never put a second
 * writer between two statements of a purge or a deletion. This drives two or
 * three real psql sessions against the LOCAL stack and orders them with locks,
 * not sleeps: a step that must wait is sent, and the driver polls
 * pg_stat_activity until that session is blocked on a lock before it moves the
 * other one on.
 *
 *   node tests/sql/launch_consent_concurrency.mjs
 *   LC_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54422/postgres node …
 *
 * Local stack only (npm run cloud:up). Never hosted dev or production: unlike
 * the .sql proofs this COMMITS its fixtures (other sessions have to see them),
 * and removes them again at the end, pass or fail. Every fixture id starts with
 * a per-run prefix, and the purges are only ever called with an age no seeded
 * or hand-made local row has (13+ months archived, 300+ days idle).
 *
 * Prints one line per check and exits non-zero if any failed.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const DB = process.env.LC_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres';
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) {
    console.error('launch_consent_concurrency: refusing a database that is not on localhost');
    process.exit(2);
}

const RUN = randomBytes(3).toString('hex');
// uuid v4 shape with the run in the middle, so cleanup can find every fixture.
const id = (tag) => `1c0c${RUN.slice(0, 4)}-${RUN.slice(4, 6)}00-4000-8000-${tag.padStart(12, '0')}`;

const results = [];
const check = (name, passed, detail = '') => {
    results.push({ name, passed });
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

/** One psql process, fed statements on stdin, each followed by a marker. */
class Session {
    constructor(name) {
        this.name = `lc-${RUN}-${name}`;
        this.out = '';
        this.seq = 0;
        this.proc = spawn('psql', [DB, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=0'], {
            env: { ...process.env, PGAPPNAME: this.name },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc.stdout.on('data', (d) => (this.out += d));
        this.proc.stderr.on('data', (d) => (this.out += d));
    }

    /** Sends `sql`; the promise resolves with its output and final SQLSTATE. */
    send(sql) {
        const marker = `__lc_done_${++this.seq}_${RUN}__`;
        const start = this.out.length;
        // Terminated, or psql would run the \echo before sending the statement.
        const statement = sql.trim().endsWith(';') ? sql : `${sql};`;
        this.proc.stdin.write(`${statement}\n\\echo ${marker} :SQLSTATE\n`);
        return new Promise((resolve) => {
            const deadline = Date.now() + 30_000;
            const poll = () => {
                const at = this.out.indexOf(marker, start);
                if (at >= 0) {
                    const state = this.out
                        .slice(at + marker.length)
                        .trim()
                        .split(/\s/)[0];
                    resolve({ output: this.out.slice(start, at).trim(), state });
                } else if (Date.now() > deadline) {
                    // Resolved, not rejected: a step sent without being awaited
                    // yet must not crash the run before cleanup.
                    console.error(`${this.name}: no answer to ${sql.slice(0, 80)}`);
                    resolve({ output: this.out.slice(start).trim(), state: 'TIMEOUT' });
                } else {
                    setTimeout(poll, 20);
                }
            };
            poll();
        });
    }

    close() {
        this.proc.stdin.end('\\q\n');
    }
}

const control = new Session('control');

const query = async (sql) => {
    const { output, state } = await control.send(sql);
    if (state !== '00000') {
        throw new Error(`control: ${state} ${output}`);
    }
    return output;
};

/** Resolves once `session` is waiting on a lock. */
const blockedOnLock = async (session) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const n = await query(
            `select count(*) from pg_stat_activity where application_name = '${session.name}' and wait_event_type = 'Lock'`,
        );
        if (n === '1') {
            return;
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${session.name} never blocked on a lock`);
};

const asService = `set local role service_role; select set_config('request.jwt.claims', '{"role":"service_role"}', true);`;
const asStudent = (uid) =>
    `set local role authenticated; select set_config('request.jwt.claims', '${JSON.stringify({
        sub: uid,
        role: 'authenticated',
        // Issued a minute ago: before any revocation this run makes.
        iat: Math.floor(Date.now() / 1000) - 60,
        app_metadata: { user_type: 'student' },
    })}', true);`;

const T = id('a1');
const DOC = id('d1');
const students = {
    // Finding 1: deletion vs. a mark in flight, and a mark arriving mid-deletion.
    s1: { uid: id('b1'), row: id('5b1'), archived: null },
    s2: { uid: id('b2'), row: id('5b2'), archived: null },
    // Finding 2: the purge's first candidate (held up), and one restored meanwhile.
    s3: { uid: id('b3'), row: id('5b3'), archived: "now() - interval '15 months'" },
    s4: { uid: id('b4'), row: id('5b4'), archived: "now() - interval '14 months'" },
};
const guests = { g1: id('c1'), g2: id('c2') };

const mark = (markId, author, text) =>
    `insert into public.annotations (id, document_id, page, kind, color, payload, created_by) values ('${markId}', '${DOC}', 0, 'text', '#112233', '{"x":0.3,"y":0.3,"size":0.02,"text":"${text}"}', '${author}')`;

const setup = async () => {
    const users = [
        `('${T}', 'authenticated', 'authenticated', 'lc-${RUN}-t@example.invalid', '{}', false, now(), now())`,
        ...Object.entries(students).map(
            ([k, s]) =>
                `('${s.uid}', 'authenticated', 'authenticated', 'lc-${RUN}-${k}@students.cleffy.app', '{"user_type":"student"}', false, now(), now())`,
        ),
        ...Object.values(guests).map(
            (g) =>
                `('${g}', 'authenticated', 'authenticated', null, '{}', true, now() - interval '400 days', now() - interval '400 days')`,
        ),
    ];
    await query(`insert into auth.users (id, aud, role, email, raw_app_meta_data, is_anonymous, created_at, updated_at)
        values ${users.join(',\n')}`);
    await query(`insert into public.managed_students (id, teacher_id, student_user_id, display_name, login_code_hash, auth_method, username, claimed_at, archived_at)
        values ${Object.entries(students)
            .map(
                ([k, s]) =>
                    `('${s.row}', '${T}', '${s.uid}', '${k}', null, 'code', 'lc${RUN}${k}', now(), ${s.archived ?? 'null'})`,
            )
            .join(',\n')}`);
    await query(
        `insert into public.documents (id, owner_id, title, storage_path) values ('${DOC}', '${T}', 'lc', '${DOC}/original.pdf')`,
    );
    await query(`insert into public.document_members (document_id, user_id, role)
        values ${Object.values(students)
            .map((s) => `('${DOC}', '${s.uid}', 'editor')`)
            .join(', ')}, ('${DOC}', '${guests.g1}', 'viewer')
        on conflict do nothing`);
};

const cleanup = async () => {
    // By the run's prefix, so a fixture a scenario created on its own goes too.
    const mine = `like '${id('').slice(0, 13)}%'`;
    // A scenario that failed half-way can leave a session holding locks.
    await query(
        `select count(pg_terminate_backend(pid)) from pg_stat_activity where application_name like 'lc-${RUN}-%' and application_name <> '${control.name}'`,
    );
    await query(`delete from public.annotations where document_id = '${DOC}'`);
    await query(`delete from public.annotation_snapshots where document_id = '${DOC}'`);
    await query(`delete from public.document_members where document_id = '${DOC}'`);
    await query(`delete from public.documents where id = '${DOC}'`);
    await query(`delete from public.managed_students where id::text ${mine}`);
    await query(`delete from auth.users where id::text ${mine}`);
};

// ---------------------------------------------------------------------------
// Finding 1: Delete student cannot miss a mark written while it runs
// ---------------------------------------------------------------------------
const deleteVersusWrites = async () => {
    const writer = new Session('writer');
    const deleter = new Session('deleter');
    try {
        // (a) The student's write holds the roster lock first and commits while
        //     the deletion waits for it: the scrub must find that mark.
        const m1 = id('a0001');
        await writer.send(`begin; ${asStudent(students.s1.uid)}`);
        const w1 = await writer.send(mark(m1, students.s1.uid, 'drawn during delete'));
        check('delete (a): the student writes a mark, not yet committed', w1.state === '00000', w1.output);
        const d1 = deleter.send(
            `begin; ${asService} select public.revoke_and_scrub_student ('${students.s1.uid}'); commit;`,
        );
        await blockedOnLock(deleter);
        check('delete (a): the deletion waits for the write', true);
        await writer.send('commit;');
        const d1r = await d1;
        check('delete (a): the deletion then completes', d1r.state === '00000', d1r.output);
        const a = await query(
            `select deleted_at is not null and payload ->> 'text' = '' from public.annotations where id = '${m1}'`,
        );
        check('delete (a): the mark committed in flight is tombstoned and emptied', a === 't', a);

        // (b) The deletion holds the roster lock first; the student's write
        //     arrives meanwhile, waits, and is refused once it commits.
        const m2 = id('a0002');
        await deleter.send(`begin; ${asService} select public.revoke_and_scrub_student ('${students.s2.uid}');`);
        await writer.send(`begin; ${asStudent(students.s2.uid)}`);
        const w2 = writer.send(mark(m2, students.s2.uid, 'drawn mid delete'));
        await blockedOnLock(writer);
        check('delete (b): a write arriving mid-deletion waits for it', true);
        await deleter.send('commit;');
        const w2r = await w2;
        check('delete (b): and is refused (42501) once it commits', w2r.state === '42501', w2r.state);
        await writer.send('rollback;');
        const b = await query(`select count(*) from public.annotations where id = '${m2}'`);
        check('delete (b): no mark escaped the scrub', b === '0', b);
        const after = await query(
            `select archived_at is not null and access_revoked_at is not null from public.managed_students where student_user_id = '${students.s2.uid}'`,
        );
        check('delete (b): the student is archived and their sessions ended', after === 't', after);

        // (c) Afterwards, before the account is even deleted, a write is refused
        //     outright rather than slipping in.
        await writer.send(`begin; ${asStudent(students.s2.uid)}`);
        const w3 = await writer.send(mark(id('a0003'), students.s2.uid, 'after delete'));
        await writer.send('rollback;');
        check('delete (c): every later write by the student is refused', w3.state === '42501', w3.state);
    } finally {
        writer.close();
        deleter.close();
    }
};

// ---------------------------------------------------------------------------
// Finding 2: the purge re-checks each candidate under its lock
// ---------------------------------------------------------------------------
const purgeVersusRestore = async () => {
    const holder = new Session('holder');
    const purger = new Session('purger');
    try {
        // s3 is the purge's oldest candidate. Holding a key-share lock on its
        // account stalls the purge mid-batch, AFTER it has listed s4 as a
        // candidate too. s4 is restored in that gap.
        await holder.send(`begin; select 1 from auth.users where id = '${students.s3.uid}' for key share;`);
        const p = purger.send(`select public.retention_purge_archived_students (interval '13 months', 10);`);
        await blockedOnLock(purger);
        check('purge: stalls on its first candidate, with the second already listed', true);
        await query(`update public.managed_students set archived_at = null where id = '${students.s4.row}'`);
        await holder.send('rollback;');
        const pr = await p;
        check('purge: completes', pr.state === '00000', `${pr.state} ${pr.output}`);
        const s3 = await query(`select count(*) from auth.users where id = '${students.s3.uid}'`);
        check('purge: the first candidate is purged', s3 === '0', s3);
        const s4 = await query(
            `select count(*) from public.managed_students m join auth.users u on u.id = m.student_user_id where m.id = '${students.s4.row}' and m.archived_at is null`,
        );
        check('purge: a student restored after the candidates were listed is kept', s4 === '1', s4);

        // Guests: g1 stalls the purge (its membership row, which the account's
        // deletion cascades to, is held); g2 signs in meanwhile and must survive.
        await holder.send(`begin; select 1 from public.document_members where user_id = '${guests.g1}' for update;`);
        const g = purger.send(`select public.retention_purge_stale_guests (interval '300 days', 10);`);
        await blockedOnLock(purger);
        await query(`update auth.users set last_sign_in_at = now() where id = '${guests.g2}'`);
        await holder.send('rollback;');
        const gr = await g;
        check('guest purge: completes', gr.state === '00000', `${gr.state} ${gr.output}`);
        const g1 = await query(`select count(*) from auth.users where id = '${guests.g1}'`);
        const g2 = await query(`select count(*) from auth.users where id = '${guests.g2}'`);
        check('guest purge: the idle guest is purged', g1 === '0', g1);
        check('guest purge: a guest active again after the candidates were listed is kept', g2 === '1', g2);

        // A restore that already holds the roster row is skipped, not waited on.
        await query(
            `update public.managed_students set archived_at = now() - interval '14 months' where id = '${students.s4.row}'`,
        );
        await holder.send(
            `begin; update public.managed_students set archived_at = null where id = '${students.s4.row}';`,
        );
        const q = await purger.send(`select public.retention_purge_archived_students (interval '13 months', 10);`);
        check(
            'purge: a row a restore is writing is skipped (SKIP LOCKED), not waited on',
            q.state === '00000' && q.output === '0',
            `${q.state} ${q.output}`,
        );
        await holder.send('commit;');
        const s4b = await query(
            `select count(*) from public.managed_students where id = '${students.s4.row}' and archived_at is null`,
        );
        check('purge: and that restore lands', s4b === '1', s4b);
    } finally {
        holder.close();
        purger.close();
    }
};

const only = process.argv[2];
let failed = false;
try {
    await query('select 1');
    await setup();
    if (!only || only === 'delete') {
        await deleteVersusWrites();
    }
    if (!only || only === 'purge') {
        await purgeVersusRestore();
    }
} catch (err) {
    failed = true;
    console.error(err);
} finally {
    try {
        await cleanup();
    } catch (err) {
        failed = true;
        console.error('cleanup failed:', err);
    }
    control.close();
}

const bad = results.filter((r) => !r.passed).length;
console.log(
    failed
        ? `ABORTED after ${results.length} checks (${bad} failed)`
        : bad
          ? `${bad} OF ${results.length} CHECKS FAILED`
          : `ALL ${results.length} CHECKS PASSED`,
);
process.exit(bad || failed ? 1 : 0);
