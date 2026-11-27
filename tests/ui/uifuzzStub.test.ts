import { describe, expect, it } from 'vitest';

import { API, reply, STUB_ENTITLEMENTS, stubApi } from '../../scripts/ui/uifuzz.mjs';

type Fulfilled = { status: number; body: string };
type RouteHandler = (route: unknown) => unknown;

async function answer(path: string, handlers?: Record<string, unknown>) {
    let handle: RouteHandler | undefined;
    await stubApi({ route: (_: string, h: RouteHandler) => (handle = h) }, handlers);
    let out: Fulfilled | undefined;
    await handle?.({
        request: () => ({ method: () => 'POST', url: () => API + path }),
        fulfill: (r: Fulfilled) => (out = r),
    });
    if (!out) throw new Error(`no answer for ${path}`);
    return { status: out.status, body: JSON.parse(out.body) };
}

const RPCS = ['/rest/v1/rpc/get_entitlements', '/rest/v1/rpc/library_bootstrap'];

describe('stubApi', () => {
    it('answers the shell RPCs with teacher entitlements when the caller has no handler', async () => {
        expect((await answer(RPCS[0]!)).body).toEqual(STUB_ENTITLEMENTS);
        expect((await answer(RPCS[1]!)).body).toMatchObject({ documents: [], entitlements: STUB_ENTITLEMENTS });
    });

    it.each(RPCS)('lets a full-path caller handler for %s win over the default', async (path) => {
        expect(await answer(path, { [path]: reply(503, { message: 'offline' }) })).toEqual({
            status: 503,
            body: { message: 'offline' },
        });
    });

    it.each(RPCS)('lets a short suffix caller handler for %s win over the default', async (path) => {
        const suffix = path.slice(path.lastIndexOf('_'));
        expect(await answer(path, { [suffix]: { tier: 'free' } })).toEqual({ status: 200, body: { tier: 'free' } });
    });
});
