// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { functionRows } from './featureMapRows';

vi.mock('npm:@supabase/supabase-js@2', () => import('@supabase/supabase-js'));
vi.mock('npm:stripe@18', () => ({ default: class {} }));
vi.mock('npm:@anthropic-ai/sdk', () => ({ default: class {} }));

type Handler = (req: Request) => Response | Promise<Response>;

let served: Handler | undefined;
vi.stubGlobal('Deno', {
    serve: (first: unknown, second?: unknown) => {
        served = (typeof first === 'function' ? first : second) as Handler;
        return {};
    },
    env: { get: () => undefined },
});

const loadHandler = async (name: string): Promise<Handler> => {
    served = undefined;
    await import(`../../supabase/functions/${name}/index.ts`);
    if (!served) throw new Error(`${name}/index.ts did not call Deno.serve`);
    return served;
};

const CLAIM = /`([A-Z]+)` on the function answers (2xx|`(\d{3})`)/g;
const METHOD = /`(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)`/g;

const probes = functionRows().map((row) => ({
    name: row.name,
    claims: [...row.smokeCheck.matchAll(CLAIM)].map(([, method = '', range = '', status]) => ({
        method,
        status: status ? Number(status) : range,
    })),
    methodsNamed: [...row.smokeCheck.matchAll(METHOD)].length,
}));

describe('verify-cleffy feature map function probes', () => {
    it('states every HTTP method it names as a "`METHOD` on the function answers <status>" claim', () => {
        expect(probes.filter((probe) => probe.methodsNamed !== probe.claims.length).map((probe) => probe.name)).toEqual(
            [],
        );
    });

    it.each(probes.filter((probe) => probe.claims.length > 0))(
        '$name answers as its row says on a lane',
        async ({ name, claims }) => {
            const handler = await loadHandler(name);
            for (const { method, status } of claims) {
                const response = await handler(new Request(`http://127.0.0.1:54321/functions/v1/${name}`, { method }));
                const statusClass = status === '2xx' ? Math.floor(response.status / 100) * 100 : response.status;
                expect(statusClass, `${method} ${name}`).toBe(status === '2xx' ? 200 : status);
            }
        },
    );
});
