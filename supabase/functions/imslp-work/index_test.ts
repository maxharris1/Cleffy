import { CONTROL_BODY_MAX_BYTES } from '../_shared/readCappedJson.ts';

const assert = (condition: unknown, message = 'assertion failed'): void => {
    if (!condition) throw new Error(message);
};

const REQUIRED = ['coldStart', 'licenseSource', 'imageinfoBatches', 'pdfTitles'] as const;

let handler: ((req: Request) => Promise<Response>) | undefined;
const realServe = Deno.serve;
(Deno as { serve: unknown }).serve = (h: (req: Request) => Promise<Response>) => {
    handler = h;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
try {
    await import('./index.ts');
} finally {
    (Deno as { serve: unknown }).serve = realServe;
}
if (!handler) throw new Error('imslp-work did not call Deno.serve');
const serve = handler;

type Upstream = (url: URL) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const noUpstream: Upstream = (url) => {
    throw new Error(`unexpected upstream call: ${url}`);
};

let ip = 0;
const request = (init: RequestInit & { ip?: string } = {}) =>
    new Request('https://edge.test/functions/v1/imslp-work', {
        method: 'POST',
        ...init,
        headers: {
            'Content-Type': 'application/json',
            'cf-connecting-ip': init.ip ?? `203.0.113.${++ip}`,
            ...(init.headers ?? {}),
        },
    });

const drive = async (req: Request, upstream: Upstream = noUpstream) => {
    const lines: string[] = [];
    const calls: string[] = [];
    const originalLog = console.log;
    const originalFetch = globalThis.fetch;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    globalThis.fetch = (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        calls.push(url.searchParams.get('prop') ?? url.searchParams.get('action') ?? url.pathname);
        return Promise.resolve(upstream(url));
    };
    let res: Response;
    try {
        res = await serve(req);
    } finally {
        console.log = originalLog;
        globalThis.fetch = originalFetch;
    }
    assert(lines.length === 1, `one log line, got ${lines.length}: ${lines.join('\n')}`);
    const log = JSON.parse(lines[0]!) as Record<string, unknown>;
    return { res, log, line: lines[0]!, calls };
};

const assertNotRun = (log: Record<string, unknown>, line: string, pdfTitles = 0) => {
    const missing = REQUIRED.filter((field) => !(field in log));
    assert(missing.length === 0, `missing: ${missing.join(', ')} in ${line}`);
    assert(typeof log.coldStart === 'boolean', line);
    assert(log.licenseSource === null, line);
    assert(log.imageinfoBatches === 0, line);
    assert(log.pdfTitles === pdfTitles, line);
};

const firstTwo = [(await drive(request({ method: 'OPTIONS' }))).log, (await drive(request({ method: 'OPTIONS' }))).log];

Deno.test('the instance logs coldStart true on its first request and false after', () => {
    const line = JSON.stringify(firstTwo);
    assert(firstTwo[0]!.coldStart === true && firstTwo[1]!.coldStart === false, line);
});

Deno.test('OPTIONS: the timing record carries every required field', async () => {
    const { res, log, line } = await drive(request({ method: 'OPTIONS' }));
    assert(res.status === 200, `status ${res.status}`);
    assert(log.status === 200, line);
    assertNotRun(log, line);
});

Deno.test('405: the timing record carries every required field', async () => {
    const { res, log, line } = await drive(request({ method: 'GET' }));
    assert(res.status === 405, `status ${res.status}`);
    assert(log.status === 405, line);
    assertNotRun(log, line);
});

for (const [name, body, status] of [
    ['invalid JSON', '{not json', 400],
    ['a non-object body', '[1,2]', 400],
    ['a missing title', JSON.stringify({ title: '   ' }), 400],
    ['an oversized body', JSON.stringify({ title: 'x'.repeat(CONTROL_BODY_MAX_BYTES) }), 413],
] as const) {
    Deno.test(`${status} on ${name}: the timing record carries every required field`, async () => {
        const { res, log, line, calls } = await drive(request({ body }));
        assert(res.status === status, `status ${res.status}`);
        assert(log.status === status, line);
        assert(calls.length === 0, `upstream calls: ${calls.join(', ')}`);
        assertNotRun(log, line);
    });
}

Deno.test('429: the timing record carries every required field', async () => {
    const body = JSON.stringify({ title: '' });
    for (let i = 0; i < 20; i++) {
        await drive(request({ body, ip: '198.51.100.7' }));
    }
    const { res, log, line } = await drive(request({ body, ip: '198.51.100.7' }));
    assert(res.status === 429, `status ${res.status}`);
    assert(log.status === 429, line);
    assertNotRun(log, line);
});

Deno.test('404 on a missing work: the timing record carries every required field', async () => {
    const { res, log, line, calls } = await drive(request({ body: JSON.stringify({ title: 'No Such Work' }) }), () =>
        json({ query: { pages: { '-1': { missing: true, title: 'No Such Work' } } } }),
    );
    assert(res.status === 404, `status ${res.status}`);
    assert(log.status === 404, line);
    assert(JSON.stringify(calls) === '["images|revisions"]', JSON.stringify(calls));
    assertNotRun(log, line);
});

Deno.test('502 when IMSLP fails: the timing record carries every required field', async () => {
    const { res, log, line, calls } = await drive(request({ body: JSON.stringify({ title: 'Some Work' }) }), () =>
        json({ error: 'down' }, 500),
    );
    assert(res.status === 502, `status ${res.status}`);
    assert(log.status === 502, line);
    assert(JSON.stringify(calls) === '["images|revisions","images"]', JSON.stringify(calls));
    assertNotRun(log, line);
});

Deno.test('a served work updates the fields as the work runs and logs no titles or secrets', async () => {
    const work = 'Sonata (Example, Ann)';
    const pdf = 'PMLP1-Sonata.pdf';
    const req = request({
        body: JSON.stringify({ title: work }),
        headers: { Authorization: 'Bearer secret-token-abc', apikey: 'anon-key-xyz' },
    });
    const { res, log, line, calls } = await drive(req, (url) => {
        if (url.searchParams.get('prop') === 'images|revisions') {
            return json({ query: { pages: { '1': { title: work, images: [{ title: `File:${pdf}` }] } } } });
        }
        if (url.searchParams.get('prop') === 'imageinfo') {
            return json({
                query: { pages: { '2': { title: `File:${pdf}`, imageinfo: [{ size: 10, mime: 'application/pdf' }] } } },
            });
        }
        return new Response('down', { status: 500 });
    });
    assert(res.status === 200, `status ${res.status}`);
    const body = (await res.json()) as { editions: Array<{ filename: string }> };
    assert(body.editions.length === 1 && body.editions[0]!.filename === pdf, JSON.stringify(body));
    assert(calls.at(0) === 'images|revisions' && calls.at(-1) === 'imageinfo', JSON.stringify(calls));
    assert(log.licenseSource === 'unavailable', line);
    assert(log.pdfTitles === 1 && log.imageinfoBatches === 1, line);
    for (const leak of ['PMLP', 'Sonata', 'Example', 'secret-token-abc', 'anon-key-xyz', 'bearer', 'authorization']) {
        assert(!line.toLowerCase().includes(leak.toLowerCase()), `leaked ${leak}: ${line}`);
    }
});
