import { afterEach, describe, expect, it, vi } from 'vitest';

import { walkCategoryBatch } from '../../supabase/functions/_shared/categorySync';
import { ImslpFetchError } from '../../supabase/functions/_shared/imslpDownload';

vi.mock('../../supabase/functions/_shared/rateLimit.ts', () => ({
    checkRateLimit: vi.fn(),
    clientKey: vi.fn(),
    serviceClient: vi.fn(),
}));

// Load the Deno entry module at runtime so tsc does not follow its npm: imports.
const imslpModule = '../../supabase/functions/_shared/imslp.ts';
const { mwFetch } = await import(imslpModule);

const options = { category: 'For piano', clcategories: ['For piano'], gcmcontinue: null };
const payload = { query: { pages: { '1': { pageid: 1, title: 'A (B, C)' } } } };
const json = () => new Response(JSON.stringify(payload));

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('mwFetch category-sync retries', () => {
    it('retries the real mwFetch timeout after its own attempts are exhausted', async () => {
        vi.useFakeTimers();
        const timeout = new DOMException('Copy without retry keywords', 'TimeoutError');
        const fetchMock = vi.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce(json());
        vi.stubGlobal('fetch', fetchMock);
        const result = walkCategoryBatch((params) => mwFetch(params, { attempts: 1 }), options);
        await vi.advanceTimersByTimeAsync(1999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toMatchObject({ members: [{ pageid: 1, title: 'A (B, C)' }] });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('preserves the timeout code and cause independently of display copy', async () => {
        const timeout = new DOMException('Copy without retry keywords', 'TimeoutError');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeout));
        const result = mwFetch({}, { attempts: 1 });
        await expect(result).rejects.toBeInstanceOf(ImslpFetchError);
        await expect(result).rejects.toMatchObject({
            code: 'timeout',
            message: 'The source page timed out',
            cause: timeout,
        });
    });

    it('still retries an HTTP 429 after mwFetch exhausts its attempts', async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response('', { status: 429 }))
            .mockResolvedValueOnce(json());
        vi.stubGlobal('fetch', fetchMock);
        const result = walkCategoryBatch((params) => mwFetch(params, { attempts: 1 }), options);
        await vi.advanceTimersByTimeAsync(2000);
        await expect(result).resolves.toMatchObject({ members: [{ pageid: 1 }] });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
