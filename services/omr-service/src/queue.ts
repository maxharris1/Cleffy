/**
 * In-process FIFO with bounded depth. Concurrency 1: Audiveris is memory-
 * hungry (-Xmx3g) and small instances thrash with parallel JVMs. Lost jobs on
 * instance recycle are acceptable — the app's staleness rule surfaces them as
 * retryable, never as a stuck spinner.
 */
export class JobQueue<T> {
    private readonly pending: T[] = [];
    private running = 0;

    constructor(
        private readonly maxDepth: number,
        private readonly worker: (job: T) => Promise<void>,
    ) {}

    /** False when the queue is full (caller answers 429). */
    enqueue(job: T): boolean {
        if (this.pending.length >= this.maxDepth) {
            return false;
        }
        this.pending.push(job);
        this.drain();
        return true;
    }

    get depth(): number {
        return this.pending.length + this.running;
    }

    private drain(): void {
        if (this.running > 0) {
            return;
        }
        const job = this.pending.shift();
        if (job === undefined) {
            return;
        }
        this.running = 1;
        void this.worker(job)
            .catch((err) => console.error('[queue] worker threw (should be impossible):', err))
            .finally(() => {
                this.running = 0;
                this.drain();
            });
    }
}
