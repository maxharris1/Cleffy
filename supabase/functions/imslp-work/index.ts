import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { WORK_NOT_FOUND_COPY } from '../_shared/scoreSearchCopy.ts';
import {
    checkRateLimit,
    clientKey,
    fetchWorkPageHtml,
    imagefromIndexUrl,
    isPdfFileTitle,
    mwFetch,
    parseComposerFromTitle,
    serviceClient,
    stripFilePrefix,
    workPageUrl,
} from '../_shared/imslp.ts';
import { fileMetaFor, parseImslpFileBlocks, type ImslpFileMeta } from '../_shared/imslpFileBlocks.ts';
import { fetchWorkPageOrImages, wikitextFromMwPage } from '../_shared/imslpWorkPage.ts';
import { CONTROL_BODY_MAX_BYTES, isJsonObject, PAYLOAD_TOO_LARGE, readCappedJson } from '../_shared/readCappedJson.ts';
import { classifyLicense, isDownloadable, type ImslpLicenseClass } from '../_shared/imslpLicense.ts';
import { resolveLicenses, type LicenseSpan } from '../_shared/imslpWorkLicenses.ts';
import { withServerTiming } from '../_shared/serverTiming.ts';

interface Edition extends ImslpFileMeta {
    filename: string;
    size: number | null;
    mime: string | null;
    openUrl: string;
    license: ImslpLicenseClass;
    licenseLabel: string | null;
    restriction: string | null;
    downloadable: boolean;
    /** Present when the license lookup itself failed (IMSLP unreachable), not when IMSLP withheld clearance. */
    licenseCheck?: 'unavailable';
}

type WorkSpan = 'rl' | 'mw_page' | 'mw_imageinfo' | LicenseSpan;

Deno.serve(
    withServerTiming<WorkSpan>('imslp-work', async (req, timing, fields) => {
        if (req.method === 'OPTIONS') {
            return optionsResponse();
        }
        if (req.method !== 'POST') {
            return jsonResponse({ error: 'Method not allowed' }, 405);
        }

        const rate = await timing.time('rl', () => checkRateLimit(`work:${clientKey(req)}`, 20, 60_000));
        if (!rate.ok) {
            return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
        }

        const read = await readCappedJson(req, CONTROL_BODY_MAX_BYTES);
        if (!read.ok) {
            return read.status === 413
                ? jsonResponse(PAYLOAD_TOO_LARGE, 413)
                : jsonResponse({ error: 'Invalid JSON body' }, 400);
        }
        if (!isJsonObject(read.value)) {
            return jsonResponse({ error: 'Invalid JSON body' }, 400);
        }
        const body = read.value as { title?: string };

        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) {
            return jsonResponse({ error: 'title is required' }, 400);
        }

        try {
            // The wikitext rides along with the image list: its #fte:imslpfile
            // blocks are the only place IMSLP states each PDF's publisher and
            // {{Urtext}} tag.
            const imagesData = (await timing.time('mw_page', () => fetchWorkPageOrImages(title, mwFetch))) as {
                query?: {
                    pages?: Record<
                        string,
                        {
                            missing?: boolean;
                            title?: string;
                            images?: Array<{ title: string }>;
                            revisions?: Array<{ '*'?: string }>;
                        }
                    >;
                };
            };

            const page = Object.values(imagesData.query?.pages ?? {})[0];
            if (!page || page.missing) {
                return jsonResponse({ error: WORK_NOT_FOUND_COPY }, 404);
            }

            const pdfTitles = (page.images ?? [])
                .map((img) => img.title)
                .filter(isPdfFileTitle)
                .map(stripFilePrefix);
            fields.pdfTitles = pdfTitles.length;

            const fileMeta = parseImslpFileBlocks(wikitextFromMwPage(page));
            const metaFields = (filename: string): ImslpFileMeta => fileMetaFor(fileMeta, filename);

            const { licenses, source: licenseSource } = await resolveLicenses(
                { admin: serviceClient(), fetchWorkPageHtml, timing },
                page.title ?? title,
                pdfTitles,
            );
            fields.licenseSource = licenseSource;
            const licenseFields = (
                filename: string,
            ): Pick<Edition, 'license' | 'licenseLabel' | 'restriction' | 'downloadable' | 'licenseCheck'> => {
                const license = licenses.get(filename);
                if (license) {
                    return {
                        license: classifyLicense(license.licenseLabel),
                        licenseLabel: license.licenseLabel,
                        restriction: license.restriction,
                        downloadable: isDownloadable(license),
                    };
                }
                // Not cleared either way. A parsed page without this file means
                // IMSLP's own listing didn't clear it; a failed lookup means nobody
                // checked. imslp-download refuses both (license_unknown), so the
                // picker must not offer a one-tap import it would then refuse —
                // `licenseCheck` lets it say "check on IMSLP" for the transient case.
                return {
                    license: 'unknown',
                    licenseLabel: null,
                    restriction: null,
                    downloadable: false,
                    ...(licenseSource === 'unavailable' ? { licenseCheck: 'unavailable' as const } : {}),
                };
            };

            const editions: Edition[] = [];
            let imageinfoBatches = 0;
            fields.imageinfoBatches = imageinfoBatches;

            // Batch imageinfo in chunks of 40.
            for (let i = 0; i < pdfTitles.length; i += 40) {
                const batch = pdfTitles.slice(i, i + 40);
                if (batch.length === 0) {
                    continue;
                }
                fields.imageinfoBatches = ++imageinfoBatches;
                const infoData = (await timing.time('mw_imageinfo', () =>
                    mwFetch({
                        action: 'query',
                        titles: batch.map((f) => `File:${f}`).join('|'),
                        prop: 'imageinfo',
                        iiprop: 'size|mime|url',
                    }),
                )) as {
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
                        ...licenseFields(filename),
                        ...metaFields(filename),
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
            return jsonResponse({ error: err instanceof Error ? err.message : 'Could not load the source page' }, 502);
        }
    }),
);
