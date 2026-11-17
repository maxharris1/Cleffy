// Serves supabase/functions/<name>/index.ts at /functions/v1/<name> and proxies every
// other path to the native stack's API_URL, so the app needs one Supabase URL.
// See docs/qa-lane.md for why the lane does not use `supabase functions serve`.

const [functionsDir, apiUrl, urlFile] = Deno.args;
if (!functionsDir || !apiUrl || !urlFile) {
    console.error('usage: functions-server.ts <functions dir> <api url> <url file>');
    Deno.exit(2);
}

type Handler = (req: Request) => Response | Promise<Response>;

const listen = Deno.serve.bind(Deno);
let captured: Handler | undefined;
Deno.serve = ((first: unknown, second?: unknown) => {
    captured = (typeof first === 'function' ? first : second) as Handler;
    return {};
}) as unknown as typeof Deno.serve;

const handlers = new Map<string, Promise<Handler>>();
let loadQueue: Promise<unknown> = Promise.resolve();

const load = (name: string): Promise<Handler> => {
    let handler = handlers.get(name);
    if (!handler) {
        handler = loadQueue.then(async () => {
            captured = undefined;
            await import(`file://${functionsDir}/${name}/index.ts`);
            if (!captured) throw new Error(`${name}/index.ts did not call Deno.serve`);
            return captured;
        });
        loadQueue = handler.catch(() => undefined);
        handlers.set(name, handler);
    }
    return handler;
};

const functionExists = async (name: string) => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return false;
    try {
        return (await Deno.stat(`${functionsDir}/${name}/index.ts`)).isFile;
    } catch {
        return false;
    }
};

const relaySocket = (req: Request, target: URL): Response => {
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const { socket, response } = Deno.upgradeWebSocket(req);
    const upstream = new WebSocket(target);
    const pending: (string | ArrayBuffer | Blob)[] = [];
    upstream.binaryType = 'arraybuffer';
    upstream.onopen = () => pending.splice(0).forEach((data) => upstream.send(data));
    upstream.onmessage = (event) => socket.readyState === WebSocket.OPEN && socket.send(event.data);
    socket.onmessage = (event) =>
        upstream.readyState === WebSocket.OPEN ? upstream.send(event.data) : pending.push(event.data);
    upstream.onclose = () => socket.readyState < WebSocket.CLOSING && socket.close();
    socket.onclose = () => upstream.readyState < WebSocket.CLOSING && upstream.close();
    upstream.onerror = () => socket.readyState < WebSocket.CLOSING && socket.close(1011);
    return response;
};

const proxy = (req: Request, url: URL): Response | Promise<Response> => {
    const target = new URL(url.pathname + url.search, apiUrl);
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') return relaySocket(req, target);
    const headers = new Headers(req.headers);
    headers.delete('host');
    return fetch(target, {
        method: req.method,
        headers,
        body: req.body,
        redirect: 'manual',
    });
};

const server = listen(
    {
        hostname: '127.0.0.1',
        port: 0,
        onListen: ({ hostname, port }) => Deno.writeTextFileSync(urlFile, `http://${hostname}:${port}\n`),
    },
    async (req) => {
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/functions\/v1\/([^/]+)/);
        if (!match) return proxy(req, url);
        const name = match[1];
        if (!(await functionExists(name))) {
            return Response.json({ code: 'NOT_FOUND', message: 'Function not found' }, { status: 404 });
        }
        try {
            return await (
                await load(name)
            )(req);
        } catch (error) {
            console.error(`[functions-server] ${name}:`, error);
            return Response.json({ code: 'BOOT_ERROR', message: String(error) }, { status: 500 });
        }
    },
);
await server.finished;
