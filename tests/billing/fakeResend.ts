/**
 * Resend's POST /emails as its idempotency docs describe it, for the billing
 * mail tests: a key seen with the same payload in the last 24 hours is
 * answered with the first answer and nothing is sent; with another payload it
 * is a 409 `invalid_idempotent_request`. `dropNextAnswer` accepts the next
 * email and then drops the connection before answering -- the outcome Codex's
 * round-3 major on #62 is about.
 */
export class FakeResend {
    /** Emails Resend actually sent. */
    delivered: Array<{ key: string; to: string[]; body: string }> = [];
    /** Every request it was given, sent or not. */
    requests: Array<{ key: string; body: string }> = [];
    /** Accept the next email, then reset the connection instead of answering. */
    dropNextAnswer = false;
    /** Statuses to fail the next requests with, before anything is accepted. */
    failNext: number[] = [];
    private seen = new Map<string, { body: string; id: string }>();

    fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const key = ((init?.headers ?? {}) as Record<string, string>)['Idempotency-Key'] ?? '';
        const body = String(init?.body);
        this.requests.push({ key, body });
        const failure = this.failNext.shift();
        if (failure !== undefined) {
            return new Response(JSON.stringify({ name: 'failure', message: `status ${failure}` }), {
                status: failure,
            });
        }
        const prior = key ? this.seen.get(key) : undefined;
        if (prior) {
            return prior.body === body
                ? new Response(JSON.stringify({ id: prior.id }), { status: 200 })
                : new Response(JSON.stringify({ name: 'invalid_idempotent_request', message: 'different payload' }), {
                      status: 409,
                  });
        }
        const id = `email_${this.delivered.length + 1}`;
        if (key) {
            this.seen.set(key, { body, id });
        }
        this.delivered.push({ key, to: (JSON.parse(body) as { to: string[] }).to, body });
        if (this.dropNextAnswer) {
            this.dropNextAnswer = false;
            throw new TypeError('fetch failed: other side closed (ECONNRESET)');
        }
        return new Response(JSON.stringify({ id }), { status: 200 });
    }) as unknown as typeof fetch;
}
