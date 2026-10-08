import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The polyfills only install what is missing, and Node ships some of these
 * natively — so each test removes the natives first, re-imports the module,
 * and checks OUR implementation, then puts the natives back.
 */

const iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())) as Record<
    string,
    unknown
>;

interface Slot {
    target: object;
    name: string;
    descriptor: PropertyDescriptor | undefined;
}

const SLOTS: [object, string][] = [
    [globalThis, 'Iterator'],
    [iteratorPrototype, 'some'],
    [iteratorPrototype, 'find'],
    [iteratorPrototype, 'filter'],
    [iteratorPrototype, 'toArray'],
    [iteratorPrototype, 'join'],
    [Math, 'sumPrecise'],
    [Promise, 'try'],
    [Uint8Array.prototype, 'toHex'],
    [Map.prototype, 'getOrInsert'],
    [Map.prototype, 'getOrInsertComputed'],
    [WeakMap.prototype, 'getOrInsert'],
    [WeakMap.prototype, 'getOrInsertComputed'],
];

let saved: Slot[] = [];

beforeEach(async () => {
    saved = SLOTS.map(([target, name]) => ({
        target,
        name,
        descriptor: Object.getOwnPropertyDescriptor(target, name),
    }));
    for (const { target, name } of saved) {
        delete (target as Record<string, unknown>)[name];
    }
    vi.resetModules();
    await import('@/lib/polyfills');
});

afterEach(() => {
    for (const { target, name, descriptor } of saved) {
        delete (target as Record<string, unknown>)[name];
        if (descriptor) {
            Object.defineProperty(target, name, descriptor);
        }
    }
});

type Helpers = {
    some(predicate: (value: unknown, index: number) => unknown): boolean;
    find(predicate: (value: unknown, index: number) => unknown): unknown;
    filter(predicate: (value: unknown, index: number) => unknown): Helpers;
    toArray(): unknown[];
};
const helpers = (iterator: Iterator<unknown>): Helpers => iterator as unknown as Helpers;

describe('Iterator global', () => {
    it('exists, is abstract, and its prototype is the one every built-in iterator inherits', () => {
        const IteratorGlobal = (globalThis as Record<string, unknown>)['Iterator'] as {
            prototype: object;
        } & (() => void);
        expect(typeof IteratorGlobal).toBe('function');
        expect(IteratorGlobal.prototype).toBe(iteratorPrototype);
        expect(() => IteratorGlobal()).toThrow(TypeError);
    });

    it('lets the pdf.js module-level `Iterator.prototype.join` shim land on real iterators', () => {
        // What pdf.mjs / pdf.worker.mjs run at module top level.
        const IteratorGlobal = (globalThis as Record<string, unknown>)['Iterator'] as {
            prototype: Record<string, unknown>;
        };
        if (typeof IteratorGlobal.prototype['join'] !== 'function') {
            IteratorGlobal.prototype['join'] = function (this: Iterable<unknown>, separator: string) {
                return [...this].join(separator);
            };
        }
        const keys = new Map([
            ['image/png', 1],
            ['image/jpeg', 2],
        ]).keys() as unknown as { join(separator: string): string };
        expect(keys.join(',')).toBe('image/png,image/jpeg');
    });
});

describe('iterator helpers', () => {
    it('some / find stop at the first match and pass the index', () => {
        const seen: number[] = [];
        const values = new Set([1, 2, 3, 4]).values();
        expect(
            helpers(values).some((value, index) => {
                seen.push(index);
                return value === 2;
            }),
        ).toBe(true);
        expect(seen).toEqual([0, 1]);
        expect(helpers(new Set([1, 2, 3]).values()).some((value) => value === 9)).toBe(false);
        expect(
            helpers(new Map([['a', { begin: 4 }]]).values()).find((r) => (r as { begin: number }).begin === 4),
        ).toEqual({ begin: 4 });
        expect(helpers(new Set<number>().values()).find(() => true)).toBeUndefined();
    });

    it('closes the source iterator after an early exit', () => {
        const closed = vi.fn();
        function* source() {
            try {
                yield 1;
                yield 2;
            } finally {
                closed();
            }
        }
        expect(helpers(source()).some((value) => value === 1)).toBe(true);
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it('filter is lazy and chains into toArray', () => {
        const filtered = helpers(new Set([1, 2, 3, 4]).values()).filter((value) => (value as number) % 2 === 0);
        expect(filtered.toArray()).toEqual([2, 4]);
    });
});

describe('Math.sumPrecise', () => {
    const sumPrecise = (items: Iterable<unknown>): number =>
        (Math as unknown as { sumPrecise(items: Iterable<unknown>): number }).sumPrecise(items);

    it('sums integers exactly, as pdf.js uses it', () => {
        expect(sumPrecise([4, 8, 12, 1024])).toBe(1048);
        expect(sumPrecise(new Set([1, 2, 3]))).toBe(6);
    });

    it('compensates where a naive loop drifts', () => {
        expect(sumPrecise([1e20, 1, -1e20])).toBe(1);
        expect(sumPrecise([0.1, 0.2, 0.3])).toBe(0.6);
    });

    it('follows the spec on empty input, signed zero, infinities and NaN', () => {
        expect(Object.is(sumPrecise([]), -0)).toBe(true);
        expect(Object.is(sumPrecise([-0, -0]), -0)).toBe(true);
        expect(Object.is(sumPrecise([-0, 0]), 0)).toBe(true);
        expect(sumPrecise([1, Infinity])).toBe(Infinity);
        expect(sumPrecise([1, -Infinity])).toBe(-Infinity);
        expect(sumPrecise([Infinity, -Infinity])).toBeNaN();
        expect(sumPrecise([1, NaN])).toBeNaN();
    });

    it('rejects non-numbers', () => {
        expect(() => sumPrecise([1, '2'])).toThrow(TypeError);
    });
});

describe('Promise.try', () => {
    const promiseTry = <T>(callback: (...args: unknown[]) => T, ...args: unknown[]): Promise<T> =>
        (Promise as unknown as { try<R>(cb: (...a: unknown[]) => R, ...a: unknown[]): Promise<R> }).try(
            callback,
            ...args,
        );

    it('resolves with the callback result and passes the arguments through', async () => {
        await expect(promiseTry((a, b) => (a as number) + (b as number), 2, 3)).resolves.toBe(5);
        await expect(promiseTry(() => Promise.resolve('async'))).resolves.toBe('async');
    });

    it('turns a synchronous throw into a rejection', async () => {
        await expect(
            promiseTry(() => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
    });
});

describe('Uint8Array.prototype.toHex', () => {
    it('hex-encodes with two lowercase digits per byte', () => {
        const toHex = (bytes: Uint8Array): string => (bytes as unknown as { toHex(): string }).toHex();
        expect(toHex(new Uint8Array([0, 1, 15, 16, 171, 255]))).toBe('00010f10abff');
        expect(toHex(new Uint8Array())).toBe('');
    });
});

describe('Map / WeakMap upsert', () => {
    it('getOrInsert and getOrInsertComputed insert only when missing', () => {
        const map = new Map<string, number>() as unknown as Map<string, number> & {
            getOrInsert(key: string, value: number): number;
            getOrInsertComputed(key: string, compute: (key: string) => number): number;
        };
        expect(map.getOrInsert('a', 1)).toBe(1);
        expect(map.getOrInsert('a', 2)).toBe(1);
        const compute = vi.fn((key: string) => key.length);
        expect(map.getOrInsertComputed('abc', compute)).toBe(3);
        expect(map.getOrInsertComputed('abc', compute)).toBe(3);
        expect(compute).toHaveBeenCalledTimes(1);

        const weak = new WeakMap<object, number>() as unknown as {
            getOrInsertComputed(key: object, compute: () => number): number;
        };
        const key = {};
        expect(weak.getOrInsertComputed(key, () => 7)).toBe(7);
        expect(weak.getOrInsertComputed(key, () => 8)).toBe(7);
    });
});
