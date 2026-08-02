import { describe, expect, it } from 'vitest';

import { JobQueue } from './queue.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('JobQueue', () => {
    it('runs jobs FIFO with concurrency 1', async () => {
        const order: string[] = [];
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const queue = new JobQueue<string>(10, async (job) => {
            order.push(`start:${job}`);
            if (job === 'a') {
                await gate;
            }
            order.push(`end:${job}`);
        });

        queue.enqueue('a');
        queue.enqueue('b');
        await tick();
        expect(order).toEqual(['start:a']); // b waits for a
        release();
        await tick();
        await tick();
        expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
    });

    it('rejects beyond max depth', () => {
        const queue = new JobQueue<number>(1, () => new Promise(() => undefined));
        expect(queue.enqueue(1)).toBe(true); // starts running immediately
        expect(queue.enqueue(2)).toBe(true); // fills the single pending slot
        expect(queue.enqueue(3)).toBe(false);
    });

    it('keeps draining after a worker rejects', async () => {
        const seen: number[] = [];
        const queue = new JobQueue<number>(10, async (job) => {
            seen.push(job);
            if (job === 1) {
                throw new Error('boom');
            }
        });
        queue.enqueue(1);
        queue.enqueue(2);
        await tick();
        await tick();
        expect(seen).toEqual([1, 2]);
    });
});
