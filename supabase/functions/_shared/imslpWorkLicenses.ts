import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
    LICENSE_TTL_MS,
    classifyLicense,
    isDownloadable,
    parseWorkPageLicenses,
    type FileLicense,
} from './imslpLicense.ts';
import type { RequestTiming } from './serverTiming.ts';

interface LicenseRow {
    filename: string;
    license_label: string | null;
    restriction: string | null;
    eu_hosted: boolean;
    fetched_at: string;
}

export type LicenseSpan = 'lic_db' | 'lic_parse' | 'lic_upsert';

export interface LicenseIo {
    admin: Pick<SupabaseClient, 'from'> | null;
    fetchWorkPageHtml: (workTitle: string) => Promise<string | null>;
    timing: Pick<RequestTiming<LicenseSpan>, 'time'>;
}

/**
 * Per-file licenses for the work's PDFs: fresh cache rows, plus one
 * action=parse of the rendered page (then cached) when they don't cover
 * every file.
 * `source` distinguishes "IMSLP was parsed and this file wasn't cleared" from
 * "license lookup unavailable". Neither is downloadable (imslp-download fails
 * closed on both); the second is reported so the picker can say why.
 */
export const resolveLicenses = async (
    io: LicenseIo,
    workTitle: string,
    pdfTitles: string[],
): Promise<{ licenses: Map<string, FileLicense>; source: 'cache' | 'live' | 'unavailable' }> => {
    const licenses = new Map<string, FileLicense>();
    if (pdfTitles.length === 0) {
        return { licenses, source: 'cache' };
    }

    const admin = io.admin;
    if (admin) {
        try {
            const { data } = await io.timing.time('lic_db', async () =>
                admin
                    .from('imslp_file_licenses')
                    .select('filename, license_label, restriction, eu_hosted, fetched_at')
                    .in('filename', pdfTitles),
            );
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

    const parsed = await io.timing.time('lic_parse', async () => {
        const html = await io.fetchWorkPageHtml(workTitle);
        return html ? parseWorkPageLicenses(html) : null;
    });
    if (!parsed) {
        return { licenses, source: 'unavailable' };
    }
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
            await io.timing.time('lic_upsert', async () => admin.from('imslp_file_licenses').upsert(upserts));
        } catch {
            // cache write is best-effort — the response already has the data
        }
    }

    return { licenses, source: 'live' };
};
