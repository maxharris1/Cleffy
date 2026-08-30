import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
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
import {
    LICENSE_TTL_MS,
    classifyLicense,
    isDownloadable,
    parseWorkPageLicenses,
    type FileLicense,
    type ImslpLicenseClass,
} from '../_shared/imslpLicense.ts';

interface Edition {
    filename: string;
    size: number | null;
    mime: string | null;
    openUrl: string;
    license: ImslpLicenseClass;
    licenseLabel: string | null;
    restriction: string | null;
    downloadable: boolean;
}

interface LicenseRow {
    filename: string;
    license_label: string | null;
    restriction: string | null;
    eu_hosted: boolean;
    fetched_at: string;
}

/**
 * Per-file licenses for the work's PDFs: fresh cache rows, plus one
 * action=parse of the rendered page (then cached) when they don't cover
 * every file.
 * `source` distinguishes "IMSLP was parsed and this file wasn't cleared"
 * (conservative: not downloadable) from "license lookup unavailable"
 * (fail-open: downloadable, but never recommended).
 */
const resolveLicenses = async (
    workTitle: string,
    pdfTitles: string[],
): Promise<{ licenses: Map<string, FileLicense>; source: 'cache' | 'live' | 'unavailable' }> => {
    const licenses = new Map<string, FileLicense>();
    if (pdfTitles.length === 0) {
        return { licenses, source: 'cache' };
    }

    const admin = serviceClient();
    if (admin) {
        try {
            const { data } = await admin
                .from('imslp_file_licenses')
                .select('filename, license_label, restriction, eu_hosted, fetched_at')
                .in('filename', pdfTitles);
            const rows = (data ?? []) as LicenseRow[];
            const fresh = rows.filter((r) => Date.now() - new Date(r.fetched_at).getTime() < LICENSE_TTL_MS);
            // Seeded before the coverage check so a known restriction is never
            // dropped just because a sibling file has no row — otherwise a
            // failed live parse below would report it as downloadable.
            for (const row of fresh) {
                licenses.set(row.filename, {
                    licenseLabel: row.license_label,
                    restriction: row.restriction,
                    euHosted: row.eu_hosted,
                });
            }
            if (fresh.length === pdfTitles.length) {
                return { licenses, source: 'cache' };
            }
        } catch {
            // fall through to a live parse
        }
    }

    const html = await fetchWorkPageHtml(workTitle);
    if (!html) {
        return { licenses, source: 'unavailable' };
    }
    const parsed = parseWorkPageLicenses(html);
    // Only what this parse actually re-verified is written back — upserting the
    // seeded cache rows too would keep renewing their TTL without rechecking.
    const freshlyParsed = new Map<string, FileLicense>();
    for (const filename of pdfTitles) {
        const license = parsed.get(filename);
        if (license) {
            licenses.set(filename, license);
            freshlyParsed.set(filename, license);
        }
    }

    if (admin && freshlyParsed.size > 0) {
        const fetchedAt = new Date().toISOString();
        const upserts = [...freshlyParsed.entries()].map(([filename, license]) => ({
            filename,
            work_title: workTitle,
            license: classifyLicense(license.licenseLabel),
            license_label: license.licenseLabel,
            restriction: license.restriction,
            eu_hosted: license.euHosted,
            downloadable: isDownloadable(license),
            fetched_at: fetchedAt,
        }));
        try {
            await admin.from('imslp_file_licenses').upsert(upserts);
        } catch {
            // cache write is best-effort — the response already has the data
        }
    }

    return { licenses, source: 'live' };
};

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
                pages?: Record<string, { missing?: boolean; title?: string; images?: Array<{ title: string }> }>;
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

        const { licenses, source: licenseSource } = await resolveLicenses(page.title ?? title, pdfTitles);
        const licenseFields = (filename: string): Pick<Edition, 'license' | 'licenseLabel' | 'restriction' | 'downloadable'> => {
            const license = licenses.get(filename);
            if (license) {
                return {
                    license: classifyLicense(license.licenseLabel),
                    licenseLabel: license.licenseLabel,
                    restriction: license.restriction,
                    downloadable: isDownloadable(license),
                };
            }
            return {
                license: 'unknown',
                licenseLabel: null,
                restriction: null,
                // Parsed page without this file = not cleared; lookup failure
                // fails open so an IMSLP hiccup can't lock the import feature.
                downloadable: licenseSource !== 'live',
            };
        };

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
                    ...licenseFields(filename),
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
        return jsonResponse({ error: err instanceof Error ? err.message : 'IMSLP work lookup failed' }, 502);
    }
});
