/**
 * imslp-work MediaWiki query contract.
 *
 * Combined `images|revisions` is the happy path (wikitext rides along with the
 * file list). A timeout or missing `revisions[0]['*']` must still yield the
 * image list so the work panel loads; ranking then falls back to size without
 * publisher/Urtext meta instead of 502ing the whole lookup.
 *
 * NO imports — loaded by Deno and vitest.
 */

export const IMSLP_WORK_WITH_WIKITEXT: Record<string, string> = {
    action: 'query',
    prop: 'images|revisions',
    imlimit: '500',
    rvprop: 'content',
    redirects: '1',
};

export const IMSLP_WORK_IMAGES_ONLY: Record<string, string> = {
    action: 'query',
    prop: 'images',
    imlimit: '500',
    redirects: '1',
};

/** Wikitext payload `imslp-work` parses; empty when revisions were not returned. */
export const wikitextFromMwPage = (page: { revisions?: Array<{ '*'?: string }> | undefined }): string =>
    page.revisions?.[0]?.['*'] ?? '';

/**
 * Fetch the work page's images plus wikitext. If the combined query fails
 * (timeout from pulling full wikitext), retry images-only so the panel still
 * lists PDFs.
 */
export const fetchWorkPageOrImages = async <T>(
    title: string,
    fetchMw: (params: Record<string, string>) => Promise<T>,
): Promise<T> => {
    try {
        return await fetchMw({ titles: title, ...IMSLP_WORK_WITH_WIKITEXT });
    } catch {
        return await fetchMw({ titles: title, ...IMSLP_WORK_IMAGES_ONLY });
    }
};
