import type { InkStroke } from '@/features/viewer/ink/handwriting/grouper';

/** US Letter-ish page: height / width. */
export const ASPECT = 1.3;

/** A pen width small enough not to pad boxes noticeably. */
const PEN_W = 0.001;

/**
 * A diagonal stroke filling the box (x, y, w, h) given in PAGE-WIDTH units,
 * returned in normalized page coords (y divided by the aspect). Enough for
 * the grouper, which only looks at bounding boxes.
 */
export const boxStroke = (
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    page = 0,
    color = '#1f2937',
): InkStroke => {
    const pts: number[] = [];
    const n = 8;
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        pts.push(x + w * t, (y + h * t) / ASPECT, 0.5);
    }
    return { id, page, color, pts, w: PEN_W, at: 0 };
};

/** Manual timers so tests decide when the grouper's pause elapses. */
export class FakeTimers {
    private queue: Array<{ fn: () => void; ms: number; id: number }> = [];
    private next = 1;

    readonly schedule = (fn: () => void, ms: number): unknown => {
        const id = this.next++;
        this.queue.push({ fn, ms, id });
        return id;
    };

    readonly cancel = (handle: unknown): void => {
        this.queue = this.queue.filter((t) => t.id !== handle);
    };

    /** Pending delays (ms), oldest first. */
    pending(): number[] {
        return this.queue.map((t) => t.ms);
    }

    /** Fire every pending timer (the pause elapsed). */
    fire(): void {
        const due = this.queue;
        this.queue = [];
        for (const t of due) {
            t.fn();
        }
    }

    /** Advance `ms` and fire timers whose delay has elapsed. */
    elapse(ms: number): void {
        const due: Array<{ fn: () => void; ms: number; id: number }> = [];
        const rest: Array<{ fn: () => void; ms: number; id: number }> = [];
        for (const t of this.queue) {
            if (t.ms <= ms) {
                due.push(t);
            } else {
                rest.push({ ...t, ms: t.ms - ms });
            }
        }
        this.queue = rest;
        for (const t of due) {
            t.fn();
        }
    }
}
