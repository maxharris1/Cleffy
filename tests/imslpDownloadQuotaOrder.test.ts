import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The deployment-wide IMSLP fetch slot is one per window. A caller the quota
 * refuses must not be able to take it for free, so the smart_imports gate
 * runs first and a queued caller is refunded instead.
 */
const edge = readFileSync(resolve(process.cwd(), 'supabase/functions/imslp-download/index.ts'), 'utf8');

describe('imslp-download: quota before the global IMSLP slot', () => {
    it('enforces smart_imports before taking the global download slot', () => {
        const quota = edge.indexOf("await enforce(admin, doc.owner_id, 'smart_imports')");
        const slot = edge.indexOf('await gateGlobalImslpDownload(');
        expect(quota).toBeGreaterThan(-1);
        expect(slot).toBeGreaterThan(-1);
        expect(quota).toBeLessThan(slot);
    });

    it('refunds a caller the global slot queues', () => {
        expect(edge).toMatch(
            /if \(!pacing\.ok\) \{\s*await giveBack\(\);\s*return jsonResponse\(pacing\.body, pacing\.status\);/,
        );
    });
});
