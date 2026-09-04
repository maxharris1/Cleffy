import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Spend guard + response cache for the spike. Every live call is appended to
 * a JSON ledger (tokens, USD, model, latency); a call that would push the
 * running total past the cap throws before it is sent. Responses are cached
 * on disk by request hash so re-running the benchmark is free and repeatable.
 */

export interface LlmUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    usd: number;
}

export interface LedgerEntry extends LlmUsage {
    at: string;
    model: string;
    label: string;
    ms: number;
    cached: boolean;
}

interface LedgerFile {
    capUsd: number;
    spentUsd: number;
    calls: LedgerEntry[];
}

export class SpendCapError extends Error {
    readonly code = 'llm_spend_cap';
    constructor(spent: number, cap: number) {
        super(`LLM spend cap reached: $${spent.toFixed(3)} of $${cap.toFixed(2)}`);
    }
}

export class SpendLedger {
    private file: LedgerFile | null = null;
    private writing: Promise<void> = Promise.resolve();

    constructor(
        readonly path: string,
        readonly capUsd: number,
        /** Upper bound reserved per in-flight call so parallel calls cannot overshoot. */
        readonly reserveUsd = 0.25,
    ) {}

    private inFlight = 0;

    private async load(): Promise<LedgerFile> {
        if (!this.file) {
            try {
                this.file = JSON.parse(await readFile(this.path, 'utf8')) as LedgerFile;
            } catch {
                this.file = { capUsd: this.capUsd, spentUsd: 0, calls: [] };
            }
            this.file.capUsd = this.capUsd;
        }
        return this.file;
    }

    async spent(): Promise<number> {
        return (await this.load()).spentUsd;
    }

    /** Throws when the cap would be breached by another call. */
    async reserve(): Promise<void> {
        const file = await this.load();
        const projected = file.spentUsd + (this.inFlight + 1) * this.reserveUsd;
        if (projected > this.capUsd) {
            throw new SpendCapError(file.spentUsd, this.capUsd);
        }
        this.inFlight += 1;
    }

    release(): void {
        this.inFlight = Math.max(0, this.inFlight - 1);
    }

    async record(entry: LedgerEntry): Promise<void> {
        const file = await this.load();
        file.calls.push(entry);
        if (!entry.cached) {
            file.spentUsd += entry.usd;
        }
        this.writing = this.writing.then(async () => {
            await mkdir(dirname(this.path), { recursive: true });
            await writeFile(this.path, JSON.stringify(file, null, 2));
        });
        await this.writing;
    }
}

export const requestHash = (parts: Array<string | Buffer>): string => {
    const h = createHash('sha256');
    for (const part of parts) {
        h.update(part);
        h.update('\u0000');
    }
    return h.digest('hex');
};

export class ResponseCache {
    constructor(readonly dir: string | null) {}

    async get<T>(key: string): Promise<T | null> {
        if (!this.dir) {
            return null;
        }
        try {
            return JSON.parse(await readFile(join(this.dir, `${key}.json`), 'utf8')) as T;
        } catch {
            return null;
        }
    }

    async put(key: string, value: unknown): Promise<void> {
        if (!this.dir) {
            return;
        }
        await mkdir(this.dir, { recursive: true });
        await writeFile(join(this.dir, `${key}.json`), JSON.stringify(value));
    }
}
