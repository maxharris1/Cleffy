import type { InkProgressMsg } from '@/sync/wire';

export interface RemoteLiveStroke {
    userId: string;
    strokeId: string;
    page: number;
    kind: 'stroke' | 'highlight';
    color: string;
    w: number;
    pts: number[];
    lastUpdateMs: number;
    /** Final batch received — kept until the committed row lands (no flicker). */
    done: boolean;
}

/** Buffers dropped after this long without updates (network death mid-stroke). */
const TTL_MS = 10_000;

/**
 * Accumulates collaborators' in-flight strokes, keyed (userId, strokeId).
 * Pure data structure (injectable clock) — rendering happens in InkController.
 */
export class RemoteInkBuffers {
    private buffers = new Map<string, RemoteLiveStroke>();

    constructor(private now: () => number = () => Date.now()) {}

    /** Apply a streamed batch; returns the affected page, or null when a no-op. */
    apply(msg: InkProgressMsg): number | null {
        const key = `${msg.userId}:${msg.strokeId}`;
        if (msg.cancel) {
            const existing = this.buffers.get(key);
            this.buffers.delete(key);
            return existing?.page ?? null;
        }
        let buffer = this.buffers.get(key);
        if (!buffer) {
            buffer = {
                userId: msg.userId,
                strokeId: msg.strokeId,
                page: msg.page,
                kind: msg.kind,
                color: msg.color,
                w: msg.w,
                pts: [],
                lastUpdateMs: this.now(),
                done: false,
            };
            this.buffers.set(key, buffer);
        }
        buffer.pts.push(...msg.pts);
        buffer.lastUpdateMs = this.now();
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

    /** Drop stale buffers; returns pages needing a repaint. */
    expire(): number[] {
        const cutoff = this.now() - TTL_MS;
        const pages: number[] = [];
        for (const [key, buffer] of this.buffers) {
            if (buffer.lastUpdateMs < cutoff) {
                this.buffers.delete(key);
                pages.push(buffer.page);
            }
        }
        return pages;
    }

    /** Drop everything (reconnect) — returns pages needing a repaint. */
    clear(): number[] {
        const pages = [...new Set([...this.buffers.values()].map((b) => b.page))];
        this.buffers.clear();
        return pages;
    }

    get size(): number {
        return this.buffers.size;
    }
}
