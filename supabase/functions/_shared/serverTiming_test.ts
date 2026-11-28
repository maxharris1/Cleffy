import { corsHeaders, jsonResponse, optionsResponse } from './cors.ts';
import { CONTROL_BODY_MAX_BYTES, readCappedJson } from './readCappedJson.ts';
import { withServerTiming } from './serverTiming.ts';

const assert = (condition: unknown, message = 'assertion failed'): void => {
    if (!condition) throw new Error(message);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const captureLogs = async (run: () => Promise<unknown>): Promise<string[]> => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    try {
        await run();
    } finally {
        console.log = original;
    }
    return lines;
};

const durations = (header: string): Map<string, number> =>
    new Map(
        header.split(', ').map((entry) => {
            const [name, dur] = entry.split(';dur=');
            return [name ?? '', Number(dur)];
        }),
    );

Deno.test('a 200 that ran auth twice and db once carries auth, db and total; everything else unchanged', async () => {
    const handler = withServerTiming<'auth' | 'db'>('test-fn', async (_req, timing, fields) => {
        await timing.time('auth', () => sleep(5));
        await timing.time('auth', () => sleep(5));
        const rows = await timing.time('db', () => [1, 2, 3]);
        fields.rowCount = rows.length;
        return jsonResponse({ rows });
    });
    let res: Response | undefined;
    const lines = await captureLogs(async () => {
        res = await handler(new Request('https://x.test/fn', { method: 'POST' }));
    });

    const header = res!.headers.get('Server-Timing') ?? '';
    assert(/^auth;dur=\d+\.\d, db;dur=\d+\.\d, total;dur=\d+\.\d$/.test(header), header);
    const durs = durations(header);
    assert(durs.get('auth')! >= 9.5, `auth spans should add: ${header}`);
    assert(durs.get('total')! >= durs.get('auth')! + durs.get('db')!, header);
    assert(res!.status === 200);
    assert(res!.headers.get('Content-Type') === 'application/json');
    for (const [name, value] of Object.entries(corsHeaders)) assert(res!.headers.get(name) === value, name);
    assert(JSON.stringify(await res!.json()) === JSON.stringify({ rows: [1, 2, 3] }));

    assert(lines.length === 1, `one log line, got ${lines.length}`);
    const log = JSON.parse(lines[0]!);
    assert(log.fn === 'test-fn' && log.status === 200 && log.coldStart === true, lines[0]);
    assert(typeof log.totalMs === 'number' && log.rowCount === 3, lines[0]);
    assert(JSON.stringify(Object.keys(log.spans)) === JSON.stringify(['auth', 'db']), lines[0]);
    assert(log.spans.auth >= 9.5, lines[0]);
});

Deno.test('an early 429 and an OPTIONS response carry total only and keep status and body', async () => {
    const handler = withServerTiming<'auth'>('test-fn', (req) =>
        req.method === 'OPTIONS'
            ? optionsResponse()
            : new Response('slow down', { status: 429, statusText: 'Too Many Requests', headers: corsHeaders }),
    );
    let refused: Response | undefined;
    let options: Response | undefined;
    const lines = await captureLogs(async () => {
        refused = await handler(new Request('https://x.test/fn', { method: 'POST' }));
        options = await handler(new Request('https://x.test/fn', { method: 'OPTIONS' }));
    });

    assert(/^total;dur=\d+\.\d$/.test(refused!.headers.get('Server-Timing') ?? ''));
    assert(refused!.status === 429 && refused!.statusText === 'Too Many Requests');
    assert((await refused!.text()) === 'slow down');
    assert(/^total;dur=\d+\.\d$/.test(options!.headers.get('Server-Timing') ?? ''));
    assert(options!.status === 200 && (await options!.text()) === 'ok');
    assert(options!.headers.get('Access-Control-Allow-Origin') === '*');

    assert(lines.length === 2, `one log line per request, got ${lines.length}`);
    const [first, second] = lines.map((line) => JSON.parse(line));
    assert(first.status === 429 && first.coldStart === false && JSON.stringify(first.spans) === '{}', lines[0]);
    assert(second.status === 200 && second.coldStart === false, lines[1]);
});

Deno.test('a throwing handler logs once with status 500 and rethrows; a throwing span is still recorded', async () => {
    const boom = new Error('boom');
    const handler = withServerTiming<'db'>('test-fn', async (_req, timing, fields) => {
        fields.stage = 'db';
        await timing.time('db', () => {
            throw boom;
        });
        return new Response('unreachable');
    });
    let thrown: unknown;
    const lines = await captureLogs(async () => {
        try {
            await handler(new Request('https://x.test/fn', { method: 'POST' }));
        } catch (error) {
            thrown = error;
        }
    });

    assert(thrown === boom, 'the original error is rethrown');
    assert(lines.length === 1, `one log line, got ${lines.length}`);
    const log = JSON.parse(lines[0]!);
    assert(log.status === 500 && log.fn === 'test-fn' && log.stage === 'db', lines[0]);
    assert(typeof log.spans.db === 'number', lines[0]);
});

Deno.test('the log line and header never carry the token, request body or response body', async () => {
    const handler = withServerTiming<'auth'>('test-fn', async (req, timing) => {
        await timing.time('auth', () => readCappedJson(req, CONTROL_BODY_MAX_BYTES));
        return new Response('%PDF-1.7 fake', { headers: { ...corsHeaders, 'Content-Type': 'application/pdf' } });
    });
    let res: Response | undefined;
    const lines = await captureLogs(async () => {
        res = await handler(
            new Request('https://x.test/fn?user=user-id-7f3e', {
                method: 'POST',
                headers: { Authorization: 'Bearer secret-token-abc', 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: 'user-id-7f3e', email: 'max@example.com' }),
            }),
        );
    });

    assert((await res!.text()).startsWith('%PDF-'));
    const surfaces = [...lines, res!.headers.get('Server-Timing') ?? ''].join('\n');
    for (const secret of ['secret-token-abc', 'user-id-7f3e', 'max@example.com', '%PDF-']) {
        assert(!surfaces.includes(secret), `leaked ${secret}`);
    }
});

Deno.test('browsers may read Server-Timing cross-origin', () => {
    assert(corsHeaders['Access-Control-Expose-Headers']?.includes('Server-Timing'));
});
