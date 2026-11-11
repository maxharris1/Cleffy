import { afterEach, describe, expect, it, vi } from 'vitest';

import { z } from '@/lib/zod';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('@/lib/zod', () => {
    it('runs zod jitless, so the production CSP never sees an eval probe', () => {
        expect(z.config().jitless).toBe(true);
    });

    it('parses objects without reaching the Function constructor', () => {
        // The JIT's capability probe and its compiled parsers both go through
        // `Function`; jitless must touch neither.
        const RealFunction = globalThis.Function;
        const used = vi.fn();
        vi.stubGlobal(
            'Function',
            new Proxy(RealFunction, {
                construct: (target, args) => {
                    used(args);
                    return Reflect.construct(target, args) as object;
                },
                apply: (target, thisArg, args) => {
                    used(args);
                    return Reflect.apply(target, thisArg, args) as unknown;
                },
            }),
        );
        const schema = z.object({ id: z.string(), page: z.number().int(), tags: z.array(z.string()) });
        expect(schema.parse({ id: 'a', page: 1, tags: ['x'] })).toEqual({ id: 'a', page: 1, tags: ['x'] });
        expect(schema.safeParse({ id: 1 }).success).toBe(false);
        expect(used).not.toHaveBeenCalled();
    });
});
