/** Read a JSON body, refusing anything larger than `maxBytes` even if Content-Length lies. */
export const readCappedJson = async <T>(
    req: Request,
    maxBytes: number,
): Promise<{ ok: true; value: T } | { ok: false; status: 413 | 400 }> => {
    const headerLen = Number(req.headers.get('content-length') ?? '');
    if (Number.isFinite(headerLen) && headerLen > maxBytes) {
        return { ok: false, status: 413 };
    }
    const reader = req.body?.getReader();
    if (!reader) {
        return { ok: false, status: 400 };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (!value) {
            continue;
        }
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel();
            return { ok: false, status: 413 };
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as T };
    } catch {
        return { ok: false, status: 400 };
    }
};
