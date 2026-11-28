const ms = (value: number): number => Math.round(value * 10) / 10;

export class RequestTiming<S extends string> {
    readonly #start = performance.now();
    readonly #spans = new Map<S, number>();

    async time<T>(span: S, fn: () => T | Promise<T>): Promise<T> {
        const start = performance.now();
        try {
            return await fn();
        } finally {
            this.#spans.set(span, (this.#spans.get(span) ?? 0) + performance.now() - start);
        }
    }

    spans(): Record<string, number> {
        return Object.fromEntries([...this.#spans].map(([name, dur]) => [name, ms(dur)]));
    }

    totalMs(): number {
        return ms(performance.now() - this.#start);
    }

    header(): string {
        return [...Object.entries(this.spans()), ['total', this.totalMs()] as const]
            .map(([name, dur]) => `${name};dur=${dur.toFixed(1)}`)
            .join(', ');
    }
}

let firstInvocation = true;

export const withServerTiming =
    <S extends string>(
        fn: string,
        handler: (
            req: Request,
            timing: RequestTiming<S>,
            fields: Record<string, unknown>,
        ) => Response | Promise<Response>,
    ): ((req: Request) => Promise<Response>) =>
    async (req) => {
        const timing = new RequestTiming<S>();
        const fields: Record<string, unknown> = {};
        const coldStart = firstInvocation;
        firstInvocation = false;
        let status = 500;
        try {
            const res = await handler(req, timing, fields);
            status = res.status;
            const headers = new Headers(res.headers);
            headers.set('Server-Timing', timing.header());
            return new Response(res.body, { status, statusText: res.statusText, headers });
        } finally {
            console.log(
                JSON.stringify({ fn, status, totalMs: timing.totalMs(), spans: timing.spans(), coldStart, ...fields }),
            );
        }
    };
