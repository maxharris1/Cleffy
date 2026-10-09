/**
 * Polyfills for the newest built-ins pdf.js calls without a guard. Defined
 * only when missing. Imported first by the app entry AND by the pdf.js worker
 * wrapper (workers have their own global scope).
 *
 * We ship pdf.js's "modern" build, which assumes the very latest browsers and
 * leaves polyfilling to the embedder (only its legacy build bundles core-js).
 * Each entry below is something the 6.x build reaches on an ordinary score, in
 * a browser our users still have:
 *
 * - Map/WeakMap getOrInsert / getOrInsertComputed (the ES "upsert" proposal):
 *   all over both threads, from document open on.
 * - Math.sumPrecise: the worker's TrueType/CFF font rewriting (createNameTable,
 *   GlyfTable) and its text-width math. Chromium 141 (late 2025) still lacked
 *   it; missing, every Type1/CFF font pdf.js rebuilds as OpenType (what most
 *   engraving software embeds) errors out and is drawn with a substitute.
 * - The global `Iterator`: pdf.mjs and pdf.worker.mjs both test
 *   `typeof Iterator.prototype.join` at MODULE TOP LEVEL (6.x added this), so
 *   in a browser without the global (Safari before 18.4) the modules throw
 *   while evaluating and no score opens at all. The iterator helpers pdf.js
 *   then calls (`.some`, `.find`, `.filter`, `.toArray`) come with it.
 * - Promise.try: the worker's message handler wraps every action in it.
 * - Uint8Array.prototype.toHex: the document fingerprint, computed on every
 *   open.
 * - URL.parse (Safari 18.0): getDocument resolves the data URLs below through
 *   it on the main thread, and the worker validates link targets with it.
 *   Missing, getDocument throws before a single page renders.
 * - Promise.withResolvers (Safari 17.4): dozens of unguarded calls on both
 *   threads — the loading task, every page render, every worker message.
 * - ArrayBuffer.prototype.transferToFixedLength (Safari 17.4): the worker
 *   serializes every font it hands the main thread through it.
 *
 * These are deliberately minimal — the behavior pdf.js relies on, written to
 * the spec's observable results for those calls — not general-purpose
 * replacements.
 */

const defineMissing = (target: object, name: string, value: unknown): void => {
    if (typeof (target as Record<string, unknown>)[name] !== 'function') {
        Object.defineProperty(target, name, { value, writable: true, configurable: true });
    }
};

// --- Map / WeakMap upsert ----------------------------------------------------

interface UpsertableMap {
    has(key: unknown): boolean;
    get(key: unknown): unknown;
    set(key: unknown, value: unknown): unknown;
}

const defineUpsert = (proto: object): void => {
    defineMissing(proto, 'getOrInsert', function (this: UpsertableMap, key: unknown, defaultValue: unknown): unknown {
        if (this.has(key)) {
            return this.get(key);
        }
        this.set(key, defaultValue);
        return defaultValue;
    });
    defineMissing(
        proto,
        'getOrInsertComputed',
        function (this: UpsertableMap, key: unknown, compute: (key: unknown) => unknown): unknown {
            if (this.has(key)) {
                return this.get(key);
            }
            const value = compute(key);
            this.set(key, value);
            return value;
        },
    );
};

defineUpsert(Map.prototype);
defineUpsert(WeakMap.prototype);

// --- Math.sumPrecise -----------------------------------------------------------

/**
 * Neumaier-compensated summation with the spec's edge cases: an empty input is
 * -0, any NaN (or +Infinity meeting -Infinity) is NaN, an infinity otherwise
 * wins, and a non-number is a TypeError. pdf.js only ever sums integers, which
 * this adds exactly; for general floats it is far closer than a naive loop,
 * though not the spec's guaranteed correctly-rounded result.
 */
defineMissing(Math, 'sumPrecise', (items: Iterable<unknown>): number => {
    let sum = 0;
    let compensation = 0;
    let count = 0;
    let allNegativeZero = true;
    let positiveInfinity = false;
    let negativeInfinity = false;
    let nan = false;
    for (const item of items) {
        if (typeof item !== 'number') {
            throw new TypeError('Math.sumPrecise: every item must be a number');
        }
        count += 1;
        if (Number.isNaN(item)) {
            nan = true;
        } else if (item === Infinity) {
            positiveInfinity = true;
        } else if (item === -Infinity) {
            negativeInfinity = true;
        } else {
            if (!Object.is(item, -0)) {
                allNegativeZero = false;
            }
            const next = sum + item;
            compensation += Math.abs(sum) >= Math.abs(item) ? sum - next + item : item - next + sum;
            sum = next;
        }
    }
    if (nan || (positiveInfinity && negativeInfinity)) {
        return NaN;
    }
    if (positiveInfinity) {
        return Infinity;
    }
    if (negativeInfinity) {
        return -Infinity;
    }
    if (count === 0 || allNegativeZero) {
        return -0;
    }
    return sum + compensation;
});

// --- Iterator global + the helpers pdf.js calls -------------------------------

/** %IteratorPrototype%: what every built-in iterator (and generator) inherits. */
const iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())) as object;

if (typeof (globalThis as Record<string, unknown>)['Iterator'] === 'undefined') {
    // The abstract constructor, there so `Iterator.prototype` resolves to the
    // real %IteratorPrototype% — which is where pdf.js hangs its own `join`.
    const IteratorConstructor = function Iterator(): never {
        throw new TypeError('Iterator is an abstract class');
    };
    IteratorConstructor.prototype = iteratorPrototype;
    Object.defineProperty(globalThis, 'Iterator', {
        value: IteratorConstructor,
        writable: true,
        configurable: true,
    });
}

type Predicate = (value: unknown, index: number) => unknown;

/** Stop the underlying iterator after an early exit, as the helpers do. */
const closeIterator = (iterator: Iterator<unknown>): void => {
    iterator.return?.();
};

defineMissing(iteratorPrototype, 'some', function (this: Iterator<unknown>, predicate: Predicate): boolean {
    let index = 0;
    for (let step = this.next(); !step.done; step = this.next()) {
        if (predicate(step.value, index++)) {
            closeIterator(this);
            return true;
        }
    }
    return false;
});

defineMissing(iteratorPrototype, 'find', function (this: Iterator<unknown>, predicate: Predicate): unknown {
    let index = 0;
    for (let step = this.next(); !step.done; step = this.next()) {
        if (predicate(step.value, index++)) {
            closeIterator(this);
            return step.value;
        }
    }
    return undefined;
});

function* filterIterator(source: Iterator<unknown>, predicate: Predicate): Generator<unknown> {
    let index = 0;
    for (let step = source.next(); !step.done; step = source.next()) {
        if (predicate(step.value, index++)) {
            yield step.value;
        }
    }
}

// A generator object inherits from %IteratorPrototype%, so the result has the
// other helpers (`.toArray()` in pdf.js's case) too.
defineMissing(iteratorPrototype, 'filter', function (this: Iterator<unknown>, predicate: Predicate) {
    return filterIterator(this, predicate);
});

defineMissing(iteratorPrototype, 'toArray', function (this: Iterator<unknown>): unknown[] {
    const out: unknown[] = [];
    for (let step = this.next(); !step.done; step = this.next()) {
        out.push(step.value);
    }
    return out;
});

// --- Promise.try -----------------------------------------------------------------

defineMissing(Promise, 'try', function <
    T,
>(this: PromiseConstructor, callback: (...args: unknown[]) => T | PromiseLike<T>, ...args: unknown[]): Promise<T> {
    // A synchronous throw inside the executor becomes the rejection.
    return new this<T>((resolve) => resolve(callback(...args)));
});

// --- Uint8Array.prototype.toHex ------------------------------------------------------

defineMissing(Uint8Array.prototype, 'toHex', function (this: Uint8Array): string {
    let hex = '';
    for (const byte of this) {
        hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
});

// --- URL.parse ----------------------------------------------------------------------

// `new URL` that answers an unparsable input with null instead of throwing.
defineMissing(URL, 'parse', (url: string | URL, base?: string | URL): URL | null => {
    try {
        return new URL(url, base);
    } catch {
        return null;
    }
});

// --- Promise.withResolvers ------------------------------------------------------------

defineMissing(Promise, 'withResolvers', function <T>(this: PromiseConstructor) {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    // `this`, like the native: a subclass gets an instance of itself.
    const promise = new this<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
});

// --- ArrayBuffer.prototype.transferToFixedLength ---------------------------------------

/**
 * A copy truncated (or zero-padded) to `newLength`. The one observable
 * difference from the native is that the source is not detached — a polyfill
 * cannot detach a buffer — which pdf.js never notices: it returns the result
 * and drops the source.
 */
defineMissing(
    ArrayBuffer.prototype,
    'transferToFixedLength',
    function (this: ArrayBuffer, newLength?: number): ArrayBuffer {
        const length = newLength === undefined ? this.byteLength : Math.trunc(Number(newLength)) || 0;
        if (length < 0 || length > Number.MAX_SAFE_INTEGER) {
            throw new RangeError('ArrayBuffer.prototype.transferToFixedLength: invalid length');
        }
        const out = new ArrayBuffer(length);
        new Uint8Array(out).set(new Uint8Array(this, 0, Math.min(length, this.byteLength)));
        return out;
    },
);

// Side effects only; the export makes this a module for TypeScript.
export {};
