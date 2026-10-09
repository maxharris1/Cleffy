import { isCloudDocId } from '@/features/library/documentsService';
import { AnnotationStore } from '@/sync/annotationStore';
import type { ScribblerDb } from '@/sync/db';
import { activeEngineFor, docsOpenInViewers, SyncEngine, type AnnotationsApi } from '@/sync/syncEngine';

/**
 * Background upload of queued annotation changes.
 *
 * A score's outbox used to drain only while that score was open (its viewer
 * runs the SyncEngine) or at sign-out. Marks drawn offline on the bus stayed on
 * the device until the teacher happened to reopen the score online — and a
 * student opening it meanwhile saw nothing. This drains every cloud score's
 * outbox from wherever the app is (library, account, another score) whenever
 * the browser is online and someone is signed in:
 *
 * - The same SyncEngine flush, so the same rules apply: ops leave the outbox
 *   only when the server accepted them or refused them for good (rolled back
 *   from server truth); offline, throttling and server faults keep them; an
 *   archived score's marks are held, not dropped. Undo/redo pairs collapse.
 * - Headless: no realtime channel and no pull. Committed rows reach the open
 *   viewers through the database broadcast as usual; rows it rewrites from
 *   server truth (an undo/redo pair beaten by a collaborator's delete, a
 *   refused change rolled back) reach them as a mirror repair (see
 *   SyncEngine.announce), with the refusal notice.
 * - A score whose viewer is open — in this tab or another — is left to that
 *   viewer's engine. The outbox lock (withOutboxLock) serializes the two if
 *   the viewer opens mid-drain, and the repair keeps its screen honest.
 * - Bounded: at most `concurrency` scores upload at once.
 * - Backoff per score is the engine's own (Retry-After honoured), rescheduled
 *   here rather than by the engine's timer so a held or failing score does
 *   not occupy a slot while it waits. Coming back online resets it.
 *
 * Lesson-history day snapshots that failed to upload are retried on the same
 * clock (and on reconnect), with their own backoff, instead of only when a
 * score is reopened.
 */

export interface BackgroundDrainDeps {
    db: ScribblerDb;
    api: AnnotationsApi;
    /** The signed-in account; the drain is torn down when it changes. */
    userId: string;
    /** Upload pending lesson-history snapshots (snapshotService.retryPendingSnapshots). */
    retrySnapshots?: () => Promise<void>;
    /** How many snapshots are still waiting (snapshotService.countPendingSnapshots). */
    countPendingSnapshots?: () => Promise<number>;
    /** Scores drained at the same time. */
    concurrency?: number;
    /** How often the outboxes are looked at when nothing else wakes the drain. */
    intervalMs?: number;
    /**
     * Wait before the first look. The app starting on a score page should let
     * that score's viewer register its engine first rather than race it.
     */
    startDelayMs?: number;
}

export const BACKGROUND_DRAIN_INTERVAL_MS = 30_000;
const DEFAULT_CONCURRENCY = 2;
const SNAPSHOT_RETRY_MIN_MS = 30_000;
const SNAPSHOT_RETRY_MAX_MS = 10 * 60_000;

export interface BackgroundDrain {
    /** Look at the outboxes now (also what the timer and 'online' do). */
    poke(): Promise<void>;
    stop(): void;
}

/** Every drain running in this tab — sign-out stops them before it clears the outbox. */
const running = new Set<BackgroundDrain>();

/**
 * Stop every background drain at once. Sign-out calls this before it clears
 * the annotation tables: a drain mid-flush would otherwise write a synced row
 * back into Dexie after the clear, for the next account on the device to find.
 */
export const stopAllBackgroundDrains = (): void => {
    for (const drain of [...running]) {
        drain.stop();
    }
};

export const startBackgroundDrain = (deps: BackgroundDrainDeps): BackgroundDrain => {
    const { db, api, userId } = deps;
    const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    const intervalMs = deps.intervalMs ?? BACKGROUND_DRAIN_INTERVAL_MS;

    let stopped = false;
    /** One headless engine per score with work left; it carries that score's backoff. */
    const engines = new Map<string, { engine: SyncEngine; nextAt: number }>();
    const draining = new Set<string>();
    let wakeTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotNextAt = 0;
    let snapshotBackoffMs = SNAPSHOT_RETRY_MIN_MS;
    let snapshotsInFlight = false;
    let scanning: Promise<void> | null = null;

    const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

    const dropEngine = (docId: string) => {
        engines.get(docId)?.engine.stop();
        engines.delete(docId);
    };

    /** Wake again when the soonest backoff expires, or at the interval. */
    const scheduleWake = () => {
        if (stopped) {
            return;
        }
        if (wakeTimer) {
            clearTimeout(wakeTimer);
        }
        const now = Date.now();
        let at = now + intervalMs;
        for (const { nextAt } of engines.values()) {
            at = Math.min(at, Math.max(nextAt, now + 1000));
        }
        wakeTimer = setTimeout(() => {
            wakeTimer = null;
            void drain.poke();
        }, at - now);
    };

    const drainDoc = async (docId: string): Promise<void> => {
        draining.add(docId);
        try {
            let entry = engines.get(docId);
            if (!entry) {
                entry = {
                    engine: new SyncEngine({
                        db,
                        store: new AnnotationStore(db, docId),
                        api,
                        docId,
                        getUserId: () => userId,
                    }),
                    nextAt: 0,
                };
                engines.set(docId, entry);
            }
            await entry.engine.flush();
            if (stopped) {
                return;
            }
            // The engine scheduled its own retry if the drain stopped short;
            // take it over so the wait does not hold a slot.
            const retryIn = entry.engine.takeScheduledRetry();
            if (retryIn !== null) {
                entry.nextAt = Date.now() + retryIn;
                return;
            }
            const left = await db.ops.where('docId').equals(docId).count();
            if (left === 0) {
                dropEngine(docId);
            }
        } catch (err) {
            console.warn('Background sync failed for a score; will retry', err);
            const entry = engines.get(docId);
            if (entry) {
                entry.nextAt = Date.now() + intervalMs;
            }
        } finally {
            draining.delete(docId);
        }
    };

    const retrySnapshots = async (): Promise<void> => {
        if (!deps.retrySnapshots || snapshotsInFlight || Date.now() < snapshotNextAt) {
            return;
        }
        snapshotsInFlight = true;
        try {
            const before = deps.countPendingSnapshots ? await deps.countPendingSnapshots() : 1;
            if (before === 0) {
                return;
            }
            await deps.retrySnapshots();
            const after = deps.countPendingSnapshots ? await deps.countPendingSnapshots() : 0;
            if (after > 0) {
                snapshotNextAt = Date.now() + snapshotBackoffMs;
                snapshotBackoffMs = Math.min(snapshotBackoffMs * 2, SNAPSHOT_RETRY_MAX_MS);
            } else {
                snapshotBackoffMs = SNAPSHOT_RETRY_MIN_MS;
            }
        } catch {
            snapshotNextAt = Date.now() + snapshotBackoffMs;
        } finally {
            snapshotsInFlight = false;
        }
    };

    const scan = async (): Promise<void> => {
        if (stopped || isOffline()) {
            return;
        }
        void retrySnapshots();
        const pendingDocs = ((await db.ops.orderBy('docId').uniqueKeys()) as string[]).filter(isCloudDocId);
        if (stopped) {
            return;
        }
        const pending = new Set(pendingDocs);
        const viewed = pendingDocs.length > 0 ? await docsOpenInViewers() : new Set<string>();
        if (stopped) {
            return;
        }
        const isViewed = (docId: string) => viewed.has(docId) || !!activeEngineFor(docId);
        for (const docId of [...engines.keys()]) {
            // Drained elsewhere (the viewer, sign-out, another tab), or now the
            // open viewer's to drain.
            if (!draining.has(docId) && (!pending.has(docId) || isViewed(docId))) {
                dropEngine(docId);
            }
        }
        const now = Date.now();
        const work: Promise<void>[] = [];
        for (const docId of pendingDocs) {
            if (draining.size >= concurrency) {
                break;
            }
            if (draining.has(docId) || isViewed(docId) || (engines.get(docId)?.nextAt ?? 0) > now) {
                continue;
            }
            work.push(drainDoc(docId));
        }
        if (work.length > 0) {
            await Promise.all(work);
            if (!stopped) {
                // A slot freed up: others may be waiting for it.
                await scan();
            }
        }
    };

    const onOnline = () => {
        for (const entry of engines.values()) {
            entry.engine.resetBackoff();
            entry.nextAt = 0;
        }
        snapshotNextAt = 0;
        snapshotBackoffMs = SNAPSHOT_RETRY_MIN_MS;
        void drain.poke();
    };

    const drain: BackgroundDrain = {
        async poke() {
            if (stopped) {
                return;
            }
            // One scan at a time; a poke during one waits for it and runs again.
            while (scanning) {
                await scanning;
            }
            scanning = scan()
                .catch((err: unknown) => console.warn('Background sync scan failed', err))
                .finally(() => {
                    scanning = null;
                    scheduleWake();
                });
            await scanning;
        },
        stop() {
            if (stopped) {
                return;
            }
            stopped = true;
            running.delete(drain);
            window.removeEventListener('online', onOnline);
            if (wakeTimer) {
                clearTimeout(wakeTimer);
                wakeTimer = null;
            }
            // Stopped engines bail before writing again, mid-flush included.
            for (const docId of [...engines.keys()]) {
                dropEngine(docId);
            }
        },
    };

    running.add(drain);
    window.addEventListener('online', onOnline);
    const startDelayMs = deps.startDelayMs ?? 0;
    if (startDelayMs > 0) {
        wakeTimer = setTimeout(() => {
            wakeTimer = null;
            void drain.poke();
        }, startDelayMs);
    } else {
        void drain.poke();
    }
    return drain;
};
