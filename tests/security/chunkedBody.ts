/**
 * A POST whose body streams in chunks with no Content-Length (or a lying one),
 * the way a chunked upload arrives: what a body cap must refuse without
 * trusting any header. `pulled()` says how many bytes the reader asked for,
 * so a test can show the read stopped at the cap.
 */
export const chunkedRequest = (
    totalBytes: number,
    options: { url?: string; chunkBytes?: number; headers?: Record<string, string>; fill?: string } = {},
): { request: Request; pulled: () => number } => {
    const chunkBytes = options.chunkBytes ?? 4096;
    const fill = new TextEncoder().encode((options.fill ?? 'x').repeat(chunkBytes)).slice(0, chunkBytes);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (sent >= totalBytes) {
                controller.close();
                return;
            }
            const size = Math.min(chunkBytes, totalBytes - sent);
            sent += size;
            controller.enqueue(fill.slice(0, size));
        },
    });
    const request = new Request(options.url ?? 'https://edge.test/fn', {
        method: 'POST',
        headers: options.headers ?? {},
        body,
        // Node's fetch needs this to send a stream body.
        duplex: 'half',
    } as RequestInit);
    return { request, pulled: () => sent };
};

/** A chunked JSON object padded past `totalBytes`: valid JSON, if it were read whole. */
export const chunkedJson = (
    value: Record<string, unknown>,
    totalBytes: number,
    options: { url?: string; headers?: Record<string, string> } = {},
): Request => {
    const head = JSON.stringify(value).slice(0, -1);
    const prefix = `${head}${head.length > 1 ? ',' : ''}"pad":"`;
    const padding = Math.max(0, totalBytes - prefix.length - 2);
    const text = `${prefix}${'x'.repeat(padding)}"}`;
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (offset >= bytes.length) {
                controller.close();
                return;
            }
            controller.enqueue(bytes.slice(offset, offset + 4096));
            offset += 4096;
        },
    });
    return new Request(options.url ?? 'https://edge.test/fn', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        body,
        duplex: 'half',
    } as RequestInit);
};
