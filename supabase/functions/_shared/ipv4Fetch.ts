/**
 * Deno `fetch` in local Docker prefers AAAA and hangs on this VM (no IPv6
 * route to generativelanguage.googleapis.com). Resolve A, TCP to that IPv4,
 * TLS with the original hostname as SNI. HTTP/1.1 + Content-Length.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_SEP = encoder.encode('\r\n\r\n');

const throwIfAborted = (signal: AbortSignal | null): void => {
    if (signal?.aborted) {
        throw new DOMException('The operation was aborted', 'AbortError');
    }
};

const writeAll = async (conn: Deno.Conn, data: Uint8Array, signal: AbortSignal | null): Promise<void> => {
    let offset = 0;
    while (offset < data.length) {
        throwIfAborted(signal);
        const n = await conn.write(data.subarray(offset));
        if (n === null) {
            throw new Error('tls write closed');
        }
        offset += n;
    }
};

const readChunk = async (conn: Deno.Conn, signal: AbortSignal | null): Promise<Uint8Array | null> => {
    throwIfAborted(signal);
    const tmp = new Uint8Array(16 * 1024);
    try {
        const n = await conn.read(tmp);
        if (n === null) {
            return null;
        }
        return tmp.slice(0, n);
    } catch (err) {
        if (err instanceof Error && err.name === 'UnexpectedEof') {
            return null;
        }
        throw err;
    }
};

const indexOfSub = (hay: Uint8Array, needle: Uint8Array): number => {
    outer: for (let i = 0; i <= hay.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (hay[i + j] !== needle[j]) {
                continue outer;
            }
        }
        return i;
    }
    return -1;
};

const concat = (chunks: Uint8Array[]): Uint8Array => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
};

const parseHeaders = (raw: Uint8Array): { status: number; headers: Headers; headerBytes: number } => {
    const sep = indexOfSub(raw, HEADER_SEP);
    const headerBytes = sep < 0 ? raw.length : sep + 4;
    const text = decoder.decode(raw.subarray(0, sep < 0 ? raw.length : sep));
    const lines = text.split('\r\n');
    const status = Number(lines[0]?.split(' ')[1] ?? '502');
    const headers = new Headers();
    for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) {
            headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        }
    }
    return { status, headers, headerBytes };
};

const decodeChunked = (body: Uint8Array): Uint8Array => {
    const parts: Uint8Array[] = [];
    let offset = 0;
    while (offset < body.length) {
        const lineEnd = indexOfSub(body.subarray(offset), encoder.encode('\r\n'));
        if (lineEnd < 0) {
            break;
        }
        const size = Number.parseInt(decoder.decode(body.subarray(offset, offset + lineEnd)), 16);
        if (!Number.isFinite(size) || size < 0) {
            break;
        }
        offset += lineEnd + 2;
        if (size === 0) {
            break;
        }
        parts.push(body.subarray(offset, offset + size));
        offset += size + 2;
    }
    return concat(parts);
};

/** Fetch that always dials IPv4. Falls back to global fetch if A-lookup fails. */
export const ipv4Fetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const signal = request.signal ?? null;
    if (url.protocol !== 'https:') {
        return fetch(input, init);
    }
    throwIfAborted(signal);
    let ip: string | undefined;
    try {
        ip = (await Deno.resolveDns(url.hostname, 'A'))[0];
    } catch {
        ip = undefined;
    }
    if (!ip) {
        return fetch(input, init);
    }
    const tcp = await Deno.connect({ hostname: ip, port: Number(url.port || 443) });
    const tls = await Deno.startTls(tcp, { hostname: url.hostname, alpnProtocols: ['http/1.1'] });
    try {
        const path = `${url.pathname}${url.search}`;
        const bodyBytes = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
        const headers = new Headers(request.headers);
        headers.set('Host', url.host);
        headers.set('Connection', 'close');
        headers.set('Accept', 'application/json');
        headers.set('Accept-Encoding', 'identity');
        headers.delete('transfer-encoding');
        if (bodyBytes && !headers.has('content-length')) {
            headers.set('Content-Length', String(bodyBytes.byteLength));
        }
        const headerLines = [`${request.method} ${path} HTTP/1.1`];
        for (const [name, value] of headers.entries()) {
            headerLines.push(`${name}: ${value}`);
        }
        await writeAll(tls, encoder.encode(`${headerLines.join('\r\n')}\r\n\r\n`), signal);
        if (bodyBytes && bodyBytes.byteLength > 0) {
            await writeAll(tls, bodyBytes, signal);
        }

        const chunks: Uint8Array[] = [];
        let raw = new Uint8Array(0);
        let parsed: ReturnType<typeof parseHeaders> | null = null;
        while (!parsed) {
            const chunk = await readChunk(tls, signal);
            if (chunk === null) {
                parsed = parseHeaders(raw);
                break;
            }
            chunks.push(chunk);
            raw = concat(chunks);
            if (indexOfSub(raw, HEADER_SEP) >= 0) {
                parsed = parseHeaders(raw);
            }
        }
        if (!parsed) {
            return new Response('', { status: 502 });
        }

        let body = raw.subarray(parsed.headerBytes);
        const lengthHeader = parsed.headers.get('content-length');
        const chunked = (parsed.headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked');
        if (lengthHeader !== null) {
            const want = Number(lengthHeader);
            if (Number.isFinite(want) && want > body.length) {
                const out = new Uint8Array(want);
                out.set(body, 0);
                let offset = body.length;
                while (offset < want) {
                    const chunk = await readChunk(tls, signal);
                    if (chunk === null) {
                        break;
                    }
                    const take = Math.min(chunk.length, want - offset);
                    out.set(chunk.subarray(0, take), offset);
                    offset += take;
                }
                body = out.subarray(0, offset);
            } else if (Number.isFinite(want) && want >= 0) {
                body = body.subarray(0, want);
            }
        } else if (chunked) {
            const endMark = encoder.encode('\r\n0\r\n');
            while (indexOfSub(body, endMark) < 0) {
                const chunk = await readChunk(tls, signal);
                if (chunk === null) {
                    break;
                }
                body = concat([body, chunk]);
            }
            body = decodeChunked(body);
        }

        return new Response(body, { status: parsed.status, headers: parsed.headers });
    } finally {
        try {
            tls.close();
        } catch {
            // already closed
        }
    }
};
