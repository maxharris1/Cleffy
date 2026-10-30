import { afterEach, describe, expect, it, vi } from 'vitest';

import * as snapshotService from '@/features/viewer/history/snapshotService';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb, type PendingOp, type PendingOpType } from '@/sync/db';
import {
    SyncEngine,
    type AnnotationPatchRow,
    type AnnotationsApi,
    type ApiError,
    type PatchResult,
    type SyncRejection,
} from '@/sync/syncEngine';
import type { AnnotationInsert, AnnotationRow, AnnotationUpdate } from '@/types/database';
import type { Annotation, TextPayload } from '@/types/models';

/**
 * QA C1, checked a second way (qa4 integration review), independently of the
 * C1 block in syncEngine.test.ts. That one races a single edit against one
 * reconcile read. Here A runs a random script of erases, Undos, Redos and
 * text edits over two notes across a dropped connection — at a person's
 * pace, with the sync engine running beside every step — while B's erase or
 * edit of each note reaches the server before A is back. Reads are held through the outage, as
 * postgrest-js retries a GET inside the one call; writes fail at once and
 * back off. Every request, every day-snapshot check and every outbox commit
 * takes a random number of yields.
 *
 * The verdict is taken from what A's store queued — every op, in outbox
 * order — not from the engine's own reasoning. However the run interleaved:
 *  - nothing is left queued or refused, and A shows what the server holds;
 *  - a note A last erased is gone;
 *  - against B's erase, an edit A made after bringing the note back (Undo or
 *    Redo of an erase) stands with A's text — the C1 guarantee — while a
 *    plain edit with no restore before it yields to the erase;
 *  - against B's edit, a note A last edited carries A's text;
 *  - with B idle, the server holds exactly what A last did.
 * An Undo of an erase with no edit after it may go either way against B's
 * erase (whose tombstone the restore names decides it), so only convergence
 * is checked there.
 *
 * Against the engine before C1's fix this fails in about one run in fifteen,
 * QA's way: delete, restore, update queued, B's tombstone kept. It also found
 * a pull, sent beside the drain on reconnect, putting back a mark as it was
 * before A's own push had landed — see "a pull read before this device's
 * push" in syncEngine.test.ts.
 */

const USER = 'user-a';
const THEIRS = '2026-09-09T09:09:09.000Z';
const MARKS = ['note-1', 'note-2'] as const;
type MarkId = (typeof MARKS)[number];

type Random = () => number;

/** xorshift32: deterministic, so a failing run replays from its seed. */
const xorshift = (seed: number): Random => {
    let state = seed >>> 0 || 0x9e3779b9;
    return () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state / 4294967296;
    };
};

/** Up to `max` yields, each a microtask, a timer or an immediate (fake-indexeddb settles on the last two). */
const pause = async (random: Random, max: number): Promise<void> => {
    const n = Math.floor(random() * (max + 1));
    for (let i = 0; i < n; i++) {
        const pick = random();
        await new Promise<void>((resolve) => {
            if (pick < 0.34) {
                queueMicrotask(resolve);
            } else if (pick < 0.67) {
                setTimeout(resolve, 0);
            } else {
                setImmediate(resolve);
            }
        });
    }
};

const textOf = (payload: unknown): string => (payload as TextPayload).text;

const note = (docId: string, id: string): Annotation => ({
    id,
    docId,
    page: 0,
    kind: 'text',
    color: '#222222',
    payload: { x: 0.1, y: 0.2, text: `${id} original`, size: 0.02 },
    createdBy: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

/**
 * The server as A's device meets it. Offline, a read waits for the
 * reconnect and is then answered from the rows as they are at that moment;
 * a write fails at once. Online, the server takes a random while to handle
 * each request and another before the answer is back.
 */
class FlakyServer implements AnnotationsApi {
    rows = new Map<string, AnnotationRow>();
    inFlight = 0;
    private seq = 1;
    private gate: Promise<void> | null = null;
    private open: (() => void) | null = null;

    constructor(private random: Random) {}

    goOffline(): void {
        this.gate = new Promise((resolve) => (this.open = resolve));
    }

    reconnect(): void {
        this.open?.();
        this.gate = null;
        this.open = null;
    }

    /** B's change, straight onto the server. */
    collaborator(id: string, patch: AnnotationUpdate): void {
        const row = this.rows.get(id)!;
        this.rows.set(id, { ...row, ...patch, updated_at: new Date().toISOString(), seq: this.seq++ });
    }

    private async read<T>(answer: () => T): Promise<T> {
        this.inFlight += 1;
        try {
            await pause(this.random, 3);
            while (this.gate) {
                await this.gate;
            }
            await pause(this.random, 6);
            const result = answer();
            await pause(this.random, 6);
            return result;
        } finally {
            this.inFlight -= 1;
        }
    }

    private async write<T>(offline: T, apply: () => T): Promise<T> {
        this.inFlight += 1;
        try {
            await pause(this.random, 3);
            if (this.gate) {
                return offline;
            }
            await pause(this.random, 6);
            const result = apply();
            await pause(this.random, 6);
            return result;
        } finally {
            this.inFlight -= 1;
        }
    }

    private static readonly DOWN: ApiError = { message: 'Failed to fetch', kind: 'retry' };

    private patchRow(id: string, patch: AnnotationUpdate): boolean {
        const row = this.rows.get(id);
        if (!row) {
            return false;
        }
        const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        this.rows.set(id, { ...row, ...defined, updated_at: new Date().toISOString(), seq: this.seq++ });
        return true;
    }

    insertIgnoreDuplicates(row: AnnotationInsert) {
        return this.insertMany([row]);
    }

    insertMany(rows: AnnotationInsert[]) {
        return this.write<{ error: ApiError | null }>({ error: FlakyServer.DOWN }, () => {
            for (const row of rows) {
                if (!this.rows.has(row.id)) {
                    this.rows.set(row.id, {
                        ...row,
                        created_at: row.created_at ?? new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                        deleted_at: row.deleted_at ?? null,
                        seq: this.seq++,
                    });
                }
            }
            return { error: null };
        });
    }

    update(id: string, docId: string, patch: AnnotationUpdate): Promise<PatchResult> {
        return this.updateMany([{ id, document_id: docId, ...patch }]);
    }

    updateMany(patches: AnnotationPatchRow[]): Promise<PatchResult> {
        return this.write<PatchResult>({ error: FlakyServer.DOWN, updatedIds: null }, () => ({
            error: null,
            updatedIds: patches
                .filter(({ id, document_id: _doc, ...patch }) => this.patchRow(id, patch))
                .map((p) => p.id),
        }));
    }

    fetchOne(id: string) {
        return this.read(() => ({ data: this.rows.get(id) ?? null, error: null }));
    }

    fetchMany(docId: string, ids: string[]) {
        return this.read(() => ({
            data: ids.map((id) => this.rows.get(id)).filter((r): r is AnnotationRow => r?.document_id === docId),
            error: null,
        }));
    }

    fetchSince(docId: string, afterSeq: number, limit: number) {
        return this.read(() => ({
            data: [...this.rows.values()]
                .filter((r) => r.document_id === docId && r.seq > afterSeq)
                .sort((a, b) => a.seq - b.seq)
                .slice(0, limit),
            error: null,
        }));
    }

    fetchDocumentArchived() {
        return this.read(() => ({ archived: false, error: null }));
    }
}

type Collaborator = 'erase' | 'edit' | 'none';

interface Queued {
    type: PendingOpType;
    annotationId: string;
    text: string;
    live: boolean;
}

interface Trial {
    ok: boolean;
    report: string;
    /** The C1 rule decided at least one note: B erased it, A edited it after a restore. */
    c1: boolean;
    /** An edit was begun on a note that was gone by the time it was saved. */
    editRefused: boolean;
}

/** The verdict for one note, from its queued ops; null when the run's outcome is free. */
const expectedFor = (
    ops: Queued[],
    collaborator: Collaborator,
    original: string,
): { live: boolean; text: string | null; c1: boolean } | null => {
    const last = ops[ops.length - 1];
    if (!last) {
        return collaborator === 'erase'
            ? { live: false, text: null, c1: false }
            : { live: true, text: collaborator === 'edit' ? 'B edit' : original, c1: false };
    }
    if (last.type === 'delete') {
        return { live: false, text: null, c1: false };
    }
    const firstRestore = ops.findIndex((op) => op.type === 'restore');
    const editAfterRestore = firstRestore >= 0 && ops.slice(firstRestore + 1).some((op) => op.type === 'update');
    switch (collaborator) {
        case 'none':
            return { live: true, text: last.text, c1: false };
        case 'edit':
            return { live: true, text: last.type === 'update' ? last.text : null, c1: false };
        case 'erase':
            if (editAfterRestore) {
                return { live: true, text: last.text, c1: true };
            }
            if (last.type === 'update') {
                // A plain edit, never brought back from an erase: B's erase stands.
                return { live: false, text: null, c1: false };
            }
            return null;
    }
};

const trial = async (random: Random): Promise<Trial> => {
    const docId = crypto.randomUUID();
    const db = new ScribblerDb(`c1-interleave-${docId}`);
    const store = new AnnotationStore(db, docId);
    store.setAuthor(USER);
    const server = new FlakyServer(random);
    const refused: SyncRejection[] = [];
    const engine = new SyncEngine({
        db,
        store,
        api: server,
        docId,
        getUserId: () => USER,
        onRejected: (rejection) => refused.push(rejection),
    });
    const internals = engine as unknown as { flushing: boolean; pulling: boolean; retryTimer: unknown };
    // The outbox commit is not over the moment its rows are in: the
    // continuation that releases the edit waits on IndexedDB's answer.
    const writes = store as unknown as { writeMany(...args: unknown[]): Promise<void> };
    const write = writes.writeMany.bind(store);
    writes.writeMany = async (...args) => {
        await write(...args);
        await pause(random, 4);
    };

    const log: Queued[] = [];
    let recording = false;
    db.ops.hook('creating', (_key, op: PendingOp) => {
        // Only the store adds ops; reconcile rewrites existing ones by key.
        if (recording && op.opId === undefined) {
            log.push({
                type: op.type,
                annotationId: op.annotationId,
                text: textOf(op.annotation.payload),
                live: !op.annotation.deletedAt,
            });
        }
    });

    /** Until nothing is in flight; the backoff timer is run early rather than waited for. */
    const settle = async (): Promise<string | null> => {
        let idleWithQueue = 0;
        for (let i = 0; i < 20_000; i++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (internals.flushing || internals.pulling || server.inFlight > 0) {
                idleWithQueue = 0;
                continue;
            }
            if (internals.retryTimer) {
                engine.takeScheduledRetry();
                void engine.sync();
                continue;
            }
            if ((await db.ops.count()) === 0) {
                return null;
            }
            // Ops queued, nothing running and no retry due: the flush that
            // should have taken them was lost.
            if (++idleWithQueue > 200) {
                return `stranded: ${await db.ops.count()} op(s) queued with no flush or retry pending`;
            }
        }
        return 'stuck: still busy after 20000 turns';
    };

    const plan = Object.fromEntries(
        MARKS.map((id) => {
            const pick = random();
            return [id, (pick < 0.6 ? 'erase' : pick < 0.8 ? 'edit' : 'none') as Collaborator];
        }),
    ) as Record<MarkId, Collaborator>;
    const steps = 2 + Math.floor(random() * 7);
    const reconnectAt = Math.floor(random() * (steps + 1));
    const collaboratorAt = Math.floor(random() * (reconnectAt + 1));
    // QA's C1 script, in most runs: A erases a note, Undoes, edits it — and
    // B has erased that note.
    const c1Mark = random() < 0.6 ? MARKS[Math.floor(random() * MARKS.length)]! : null;
    if (c1Mark) {
        plan[c1Mark] = 'erase';
    }
    const script: string[] = [];
    const pending: Promise<unknown>[] = [];
    let edits = 0;
    let editRefused = false;
    let collaborated = false;
    let reconnected = false;

    const collaborate = () => {
        if (collaborated) {
            return;
        }
        collaborated = true;
        for (const id of MARKS) {
            if (plan[id] === 'erase') {
                server.collaborator(id, { deleted_at: THEIRS });
            } else if (plan[id] === 'edit') {
                const row = server.rows.get(id)!;
                server.collaborator(id, { payload: { ...(row.payload as TextPayload), text: 'B edit' } });
            }
        }
        script.push('B');
    };
    const reconnect = () => {
        collaborate();
        reconnected = true;
        server.reconnect();
        window.dispatchEvent(new Event('online'));
        script.push('online');
    };
    const visible = (id: string) => store.getPage(0).has(id);
    /**
     * One user action, at a person's pace: over (drawn and queued, or
     * refused) before the next one starts, while the network, reconcile and
     * drain run on beside it. Actions on one note cannot overlap in the UI —
     * the eraser cannot reach a note whose editor is open — and a store op
     * is built from the mark as it is when the action starts.
     */
    const act = (kind: string, id: string): Promise<unknown> => {
        if ((kind === 'erase' || kind === 'edit') && !visible(id)) {
            kind = random() < 0.5 ? 'undo' : 'redo';
        }
        script.push(kind === 'undo' || kind === 'redo' ? kind : `${kind} ${id}`);
        let action: Promise<unknown>;
        switch (kind) {
            case 'erase':
                action = store.delete(id);
                break;
            case 'undo':
                action = store.undoLast();
                break;
            case 'redo':
                action = store.redoLast();
                break;
            default: {
                const text = `A edit ${++edits}`;
                action = (async () => {
                    await pause(random, 15); // the note's editor is open; Done is pressed after
                    const current = store.get(id);
                    const before = log.length;
                    await store.update(id, {
                        payload: { ...((current?.payload ?? {}) as TextPayload), text },
                    });
                    if (!log.slice(before).some((op) => op.type === 'update' && op.text === text)) {
                        editRefused = true;
                    }
                })();
            }
        }
        pending.push(action);
        return action;
    };

    try {
        engine.start();
        for (const id of MARKS) {
            await store.create(note(docId, id));
        }
        const setup = await settle();
        if (setup) {
            return { ok: false, report: `setup ${setup}`, c1: false, editRefused: false };
        }
        recording = true;
        server.goOffline();

        for (let step = 0; step < steps; step++) {
            if (step === collaboratorAt) {
                collaborate();
            }
            if (step === reconnectAt) {
                reconnect();
            }
            if (c1Mark && step < 3) {
                await act(['erase', 'undo', 'edit'][step]!, c1Mark);
            } else {
                const pick = random();
                const id = MARKS[Math.floor(random() * MARKS.length)]!;
                await act(pick < 0.3 ? 'erase' : pick < 0.55 ? 'undo' : pick < 0.7 ? 'redo' : 'edit', id);
            }
            await pause(random, 10);
        }
        if (!reconnected) {
            reconnect();
        }
        await Promise.all(pending);
        const quiet = await settle();
        recording = false;
        // What a later pull would bring: A must then show the server's rows.
        await engine.sync();
        await engine.sync();

        const problems: string[] = quiet ? [quiet] : [];
        if ((await db.ops.count()) > 0) {
            problems.push(`${await db.ops.count()} op(s) still queued`);
        }
        if (refused.length > 0) {
            problems.push(`refused: ${JSON.stringify(refused)}`);
        }
        let c1 = false;
        const lines: string[] = [];
        for (const id of MARKS) {
            const row = server.rows.get(id)!;
            const shown = store.get(id);
            const serverLive = row.deleted_at === null;
            const ops = log.filter((op) => op.annotationId === id);
            lines.push(
                `${id}: B ${plan[id]}; queued ${ops.map((op) => `${op.type}${op.type === 'update' ? `(${op.text})` : ''}`).join(',') || '-'}; server ${serverLive ? `live "${textOf(row.payload)}"` : `gone@${row.deleted_at}`}; A ${shown && !shown.deletedAt ? `live "${textOf(shown.payload)}"` : 'gone'}`,
            );
            if (!shown || !!shown.deletedAt === serverLive || textOf(shown.payload) !== textOf(row.payload)) {
                problems.push(`${id}: A shows something other than the server`);
            }
            const expected = expectedFor(ops, plan[id], `${id} original`);
            if (!expected) {
                continue;
            }
            c1 ||= expected.c1;
            if (expected.live !== serverLive) {
                problems.push(`${id}: expected ${expected.live ? 'live' : 'gone'} on the server`);
            } else if (expected.live && expected.text !== null && expected.text !== textOf(row.payload)) {
                problems.push(`${id}: expected "${expected.text}" on the server`);
            }
        }
        const report = `script [${script.join(', ')}]\n    ${lines.join('\n    ')}${problems.length ? `\n    PROBLEMS: ${problems.join('; ')}` : ''}`;
        return { ok: problems.length === 0, report, c1, editRefused };
    } finally {
        engine.stop();
        await Promise.allSettled(pending);
        db.close();
        await db.delete();
    }
};

describe('Reconcile under randomized interleavings (QA C1, integration review)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('converges, and keeps every post-restore edit against a collaborator’s erase, in 150 random runs', async () => {
        const seed = Number(process.env['C1_INTERLEAVE_SEED'] ?? Math.floor(Math.random() * 2 ** 31));
        const runs = Number(process.env['C1_INTERLEAVE_RUNS'] ?? 150);
        const random = xorshift(seed);
        const snapshot = snapshotService.ensureDayStartingSnapshot;
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockImplementation(async (...args) => {
            await pause(random, 6);
            return snapshot(...args);
        });

        const failures: string[] = [];
        let c1Runs = 0;
        let refusedEdits = 0;
        for (let run = 0; run < runs; run++) {
            const result = await trial(random);
            c1Runs += result.c1 ? 1 : 0;
            refusedEdits += result.editRefused ? 1 : 0;
            if (!result.ok) {
                failures.push(`run ${run}: ${result.report}`);
            }
        }
        const summary = `seed ${seed}: ${runs} runs, ${c1Runs} decided by the C1 rule, ${refusedEdits} with an edit begun on a note that was gone by Done`;
        expect(failures, summary).toEqual([]);
        // Not vacuous: the C1 rule decided a fair share of runs, and edits
        // also met notes that had gone by the time they were saved.
        expect(c1Runs, summary).toBeGreaterThanOrEqual(runs / 10);
        expect(refusedEdits, summary).toBeGreaterThan(0);
    }, 240_000);
});
