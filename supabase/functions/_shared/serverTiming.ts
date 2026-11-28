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

export type TelemetryFields = Record<string, string | number | boolean | null>;

const bigintAsString = (_key: string, value: unknown): unknown =>
    typeof value === 'bigint' ? value.toString() : value;

const logLine = (measured: Record<string, unknown>, fields: TelemetryFields): void => {
    let line: string;
    try {
        line = JSON.stringify({ ...fields, ...measured }, bigintAsString);
    } catch {
        line = JSON.stringify(measured);
    }
    try {
        console.log(line);
    } catch {
        return;
    }
};

const withHeader = (res: Response, name: string, value: string): Response => {
    try {
        res.headers.set(name, value);
        return res;
    } catch {
        const headers = new Headers(res.headers);
        headers.set(name, value);
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
};

export const withServerTiming =
    <S extends string>(
        fn: string,
        handler: (req: Request, timing: RequestTiming<S>, fields: TelemetryFields) => Response | Promise<Response>,
    ): ((req: Request) => Promise<Response>) =>
    async (req) => {
        const timing = new RequestTiming<S>();
        const fields: TelemetryFields = {};
        const coldStart = firstInvocation;
        firstInvocation = false;
        let status = 500;
        try {
            const res = await handler(req, timing, fields);
            status = res.status;
            return withHeader(res, 'Server-Timing', timing.header());
        } finally {
            logLine({ fn, status, totalMs: timing.totalMs(), spans: timing.spans(), coldStart }, fields);
        }
    };
