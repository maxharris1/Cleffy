import { INK_LIMITS, type InkProgressMsg } from '@/sync/wire';

export interface RemoteLiveStroke {
    userId: string;
    strokeId: string;
    page: number;
    kind: 'stroke' | 'highlight';
    color: string;
    w: number;
    pts: number[];
    /** When the first batch arrived: the absolute lifetime counts from here. */
    startedMs: number;
    lastUpdateMs: number;
    /** Final batch received — kept until the committed row lands (no flicker). */
    done: boolean;
}

/** Buffers dropped after this long without updates (network death mid-stroke). */
const TTL_MS = 10_000;

/**
 * Bounds on what a collaborator can make this tab hold. Live ink comes from
 * any member's websocket, so a peer that keeps a stroke alive forever, never
 * finishes one, or opens hundreds at once must not grow memory without end.
 * Committed annotations do not pass through here and are not affected.
 */
export const REMOTE_INK_LIMITS = {
    /** Numbers kept per stroke (x, y, p per point): later points are ignored. */
    maxStrokeValues: INK_LIMITS.maxStrokePoints * 3,
    /** In-flight strokes per peer; a new one evicts that peer's oldest. */
    maxStrokesPerPeer: 8,
    /** In-flight strokes across every peer; a new one evicts the oldest. */
    maxStrokes: 64,
    /** A stroke is dropped this long after its first batch, however busy. */
    maxLifetimeMs: 60_000,
    /** Retired stroke keys remembered, so a late batch cannot revive one. */
    maxRetired: 256,
} as const;

/**
 * Accumulates collaborators' in-flight strokes, keyed (userId, strokeId).
 * Pure data structure (injectable clock) — rendering happens in InkController.
 */
export class RemoteInkBuffers {
    private buffers = new Map<string, RemoteLiveStroke>();
    /** Strokes past their lifetime or evicted: further batches are ignored. */
    private retired = new Set<string>();
    /** Pages of evicted strokes, repainted by the next expire(). */
    private evictedPages = new Set<number>();

    constructor(private now: () => number = () => Date.now()) {}

    /** Apply a streamed batch; returns the affected page, or null when a no-op. */
    apply(msg: InkProgressMsg): number | null {
        const key = `${msg.userId}:${msg.strokeId}`;
        if (msg.cancel) {
            const existing = this.buffers.get(key);
            this.buffers.delete(key);
            return existing?.page ?? null;
        }
        if (this.retired.has(key)) {
            return null;
        }
        const now = this.now();
        let buffer = this.buffers.get(key);
        if (buffer && now - buffer.startedMs > REMOTE_INK_LIMITS.maxLifetimeMs) {
            this.retire(key);
            return buffer.page;
        }
        if (!buffer) {
            this.makeRoomFor(msg.userId);
            buffer = {
                userId: msg.userId,
                strokeId: msg.strokeId,
                page: msg.page,
                kind: msg.kind,
                color: msg.color,
                w: msg.w,
                pts: [],
                startedMs: now,
                lastUpdateMs: now,
                done: false,
            };
            this.buffers.set(key, buffer);
        }
        // Append by index, never by spread: a spread passes every number as a
        // call argument, and a large batch would overflow the stack.
        const room = REMOTE_INK_LIMITS.maxStrokeValues - buffer.pts.length;
        const take = Math.max(0, Math.min(room, msg.pts.length));
        for (let i = 0; i < take; i += 1) {
            buffer.pts.push(msg.pts[i] as number);
        }
        buffer.lastUpdateMs = now;
        if (msg.done) {
            buffer.done = true;
        }
        return buffer.page;
    }

    /** The committed annotation arrived — drop its live preview. */
    removeByStrokeId(strokeId: string): number | null {
        for (const [key, buffer] of this.buffers) {
            if (buffer.strokeId === strokeId) {
                this.buffers.delete(key);
                return buffer.page;
            }
        }
        return null;
    }

    forPage(page: number): RemoteLiveStroke[] {
        return [...this.buffers.values()].filter((b) => b.page === page);
    }

    /** Drop stale and over-age buffers; returns pages needing a repaint. */
    expire(): number[] {
        const now = this.now();
        const cutoff = now - TTL_MS;
        const pages = new Set(this.evictedPages);
        this.evictedPages.clear();
        for (const [key, buffer] of this.buffers) {
            if (now - buffer.startedMs > REMOTE_INK_LIMITS.maxLifetimeMs) {
                this.retire(key);
                pages.add(buffer.page);
            } else if (buffer.lastUpdateMs < cutoff) {
                this.buffers.delete(key);
                pages.add(buffer.page);
            }
        }
        return [...pages];
    }

    /** Drop everything (reconnect) — returns pages needing a repaint. */
    clear(): number[] {
        const pages = new Set([...this.buffers.values()].map((b) => b.page));
        for (const page of this.evictedPages) {
            pages.add(page);
        }
        this.buffers.clear();
        this.retired.clear();
        this.evictedPages.clear();
        return [...pages];
    }

    get size(): number {
        return this.buffers.size;
    }

    /** Evict the oldest strokes until a new one from `userId` fits both caps. */
    private makeRoomFor(userId: string): void {
        const own = [...this.buffers.entries()].filter(([, b]) => b.userId === userId);
        if (own.length >= REMOTE_INK_LIMITS.maxStrokesPerPeer) {
            this.evictOldest(own);
        }
        if (this.buffers.size >= REMOTE_INK_LIMITS.maxStrokes) {
            this.evictOldest([...this.buffers.entries()]);
        }
    }

    private evictOldest(entries: Array<[string, RemoteLiveStroke]>): void {
        let oldest: [string, RemoteLiveStroke] | undefined;
        for (const entry of entries) {
            if (!oldest || entry[1].startedMs < oldest[1].startedMs) {
                oldest = entry;
            }
        }
        if (oldest) {
            this.retire(oldest[0]);
            this.evictedPages.add(oldest[1].page);
        }
    }

    /** Drop a stroke and ignore any batch for it from now on. */
    private retire(key: string): void {
        this.buffers.delete(key);
        this.retired.add(key);
        if (this.retired.size > REMOTE_INK_LIMITS.maxRetired) {
            // Sets iterate in insertion order: forget the longest-retired.
            const first = this.retired.values().next();
            if (!first.done) {
                this.retired.delete(first.value);
            }
        }
    }
}
