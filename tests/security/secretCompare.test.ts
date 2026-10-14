import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { secretsEqual } from '../../supabase/functions/_shared/secretCompare';

describe('secretsEqual', () => {
    it('matches identical secrets', async () => {
        expect(await secretsEqual('s3cret-value', 's3cret-value')).toBe(true);
    });

    it('rejects any difference — content, case, length, or a prefix', async () => {
        expect(await secretsEqual('s3cret-valuf', 's3cret-value')).toBe(false);
        expect(await secretsEqual('S3cret-value', 's3cret-value')).toBe(false);
        expect(await secretsEqual('s3cret-value ', 's3cret-value')).toBe(false);
        expect(await secretsEqual('s3cret', 's3cret-value')).toBe(false);
        expect(await secretsEqual('s3cret-value-and-more', 's3cret-value')).toBe(false);
    });

    it('fails closed when the secret is not configured, whatever was sent', async () => {
        // An unset IMSLP_SYNC_SECRET must not turn an absent or empty header
        // into a match.
        expect(await secretsEqual('', '')).toBe(false);
        expect(await secretsEqual(null, undefined)).toBe(false);
        expect(await secretsEqual('anything', undefined)).toBe(false);
        expect(await secretsEqual('', 'configured')).toBe(false);
        expect(await secretsEqual(null, 'configured')).toBe(false);
    });
});

describe('edge functions compare header secrets in constant time', () => {
    it('imslp-sync never compares its credentials with ===', () => {
        const source = readFileSync(resolve(process.cwd(), 'supabase/functions/imslp-sync/index.ts'), 'utf8');
        const gate = source.slice(source.indexOf('const authorized'), source.indexOf('Deno.serve'));
        expect(gate).toContain('secretsEqual(');
        expect(gate).not.toMatch(/===\s*(syncSecret|`Bearer)/);
        expect(gate).not.toMatch(/(Secret|Key)\s*===/);
    });
});
