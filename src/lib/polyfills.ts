/**
 * Polyfills for the ES "upsert" proposal (Map/WeakMap getOrInsert /
 * getOrInsertComputed), which pdf.js ≥5.6 uses and only the newest browsers
 * ship. Defined only when missing. Imported first by the app entry AND by the
 * pdf.js worker wrapper (workers have their own global scope).
 */

interface UpsertableMap {
    has(key: unknown): boolean;
    get(key: unknown): unknown;
    set(key: unknown, value: unknown): unknown;
}

const defineUpsert = (proto: object): void => {
    const target = proto as Record<string, unknown>;
    if (typeof target['getOrInsert'] !== 'function') {
        Object.defineProperty(proto, 'getOrInsert', {
            value(this: UpsertableMap, key: unknown, defaultValue: unknown): unknown {
                if (this.has(key)) {
                    return this.get(key);
                }
                this.set(key, defaultValue);
                return defaultValue;
            },
            writable: true,
            configurable: true,
        });
    }
    if (typeof target['getOrInsertComputed'] !== 'function') {
        Object.defineProperty(proto, 'getOrInsertComputed', {
            value(this: UpsertableMap, key: unknown, compute: (key: unknown) => unknown): unknown {
                if (this.has(key)) {
                    return this.get(key);
                }
                const value = compute(key);
                this.set(key, value);
                return value;
            },
            writable: true,
            configurable: true,
        });
    }
};

defineUpsert(Map.prototype);
defineUpsert(WeakMap.prototype);
