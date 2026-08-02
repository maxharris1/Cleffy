import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import {
    checkRateLimit,
    clientKey,
    imagefromIndexUrl,
    isPdfFileTitle,
    mwFetch,
    parseComposerFromTitle,
    stripFilePrefix,
    workPageUrl,
} from '../_shared/imslp.ts';

interface Edition {
    filename: string;
    size: number | null;
    mime: string | null;
    openUrl: string;
}

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const rate = await checkRateLimit(`work:${clientKey(req)}`, 20, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    let body: { title?: string };
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
        return jsonResponse({ error: 'title is required' }, 400);
    }

    try {
        const imagesData = (await mwFetch({
            action: 'query',
            titles: title,
            prop: 'images',
            imlimit: '500',
            redirects: '1',
        })) as {
            query?: {
                pages?: Record<
                    string,
                    { missing?: boolean; title?: string; images?: Array<{ title: string }> }
                >;
            };
        };

        const page = Object.values(imagesData.query?.pages ?? {})[0];
        if (!page || page.missing) {
            return jsonResponse({ error: 'Work not found on IMSLP' }, 404);
        }

        const pdfTitles = (page.images ?? [])
            .map((img) => img.title)
            .filter(isPdfFileTitle)
            .map(stripFilePrefix);

        const editions: Edition[] = [];

        // Batch imageinfo in chunks of 40.
        for (let i = 0; i < pdfTitles.length; i += 40) {
            const batch = pdfTitles.slice(i, i + 40);
            if (batch.length === 0) {
                continue;
            }
            const infoData = (await mwFetch({
                action: 'query',
                titles: batch.map((f) => `File:${f}`).join('|'),
                prop: 'imageinfo',
                iiprop: 'size|mime|url',
            })) as {
                query?: {
                    pages?: Record<
                        string,
                        {
                            title?: string;
                            missing?: boolean;
                            imageinfo?: Array<{ size?: number; mime?: string }>;
                        }
                    >;
                };
            };

            for (const infoPage of Object.values(infoData.query?.pages ?? {})) {
                if (infoPage.missing) {
                    continue;
                }
                const filename = stripFilePrefix(infoPage.title ?? '');
                if (!filename.toLowerCase().endsWith('.pdf')) {
                    continue;
                }
                const info = infoPage.imageinfo?.[0];
                editions.push({
                    filename,
                    size: info?.size ?? null,
                    mime: info?.mime ?? null,
                    openUrl: imagefromIndexUrl(filename),
                });
            }
        }

        // Preserve IMSLP listing order when possible.
        const order = new Map(pdfTitles.map((f, idx) => [f, idx]));
        editions.sort((a, b) => (order.get(a.filename) ?? 0) - (order.get(b.filename) ?? 0));

        return jsonResponse({
            title: page.title ?? title,
            composer: parseComposerFromTitle(page.title ?? title),
            imslpUrl: workPageUrl(page.title ?? title),
            editions,
        });
    } catch (err) {
        return jsonResponse(
            { error: err instanceof Error ? err.message : 'IMSLP work lookup failed' },
            502,
        );
    }
});
