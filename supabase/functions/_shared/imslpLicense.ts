/**
 * IMSLP per-file license extraction and classification.
 *
 * IMSLP's MediaWiki (1.18) exposes no structured license data: File: pages
 * have no wikitext or categories via the API, and the work-page wikitext's
 * `Copyright=` field misses the regional review flags (a "Public Domain" tag
 * can still be Non-PD US). The only complete source is the RENDERED work page
 * (action=parse), where each file group's "Copyright" cell carries the license
 * link, the red "Non-PD …" flag, and a tagger link binding it to file indexes,
 * and each file entry carries its index, filename and "(EU)" mirror marker.
 *
 * NO imports — loaded by Deno (with the `.ts` extension) and by vitest
 * (without it), so the parser is testable against saved page fixtures.
 */

export type ImslpLicenseClass = 'pd' | 'cc' | 'non-pd' | 'unknown';

/**
 * How long a cached license row stays authoritative. Status changes are rare
 * (mostly Public Domain Day), and stale errs toward yesterday's usually more
 * restrictive answer.
 */
export const LICENSE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * MediaWiki treats "_" as " " and upper-cases a title's first letter, so an
 * equivalent-but-different spelling resolves to the same file while missing
 * the cache row (always written in the canonical space form).
 */
export const canonicalImslpFilename = (filename: string): string => {
    const spaced = filename.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (!spaced) {
        return spaced;
    }
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export interface FileLicense {
    /** Verbatim IMSLP tag, e.g. "Creative Commons Attribution 4.0". */
    licenseLabel: string | null;
    /** Verbatim red flag, e.g. "Non-PD US" or "Non-PD US, Non-PD EU". */
    restriction: string | null;
    /** File is served from IMSLP's EU mirror ("(EU)" marker). */
    euHosted: boolean;
}

export const classifyLicense = (label: string | null): ImslpLicenseClass => {
    if (!label) {
        return 'unknown';
    }
    const folded = label.trim().toLowerCase();
    if (folded.startsWith('public domain')) {
        return 'pd';
    }
    if (folded.startsWith('creative commons') || folded.startsWith('performance restricted')) {
        return 'cc';
    }
    if (/non-?pd/.test(folded)) {
        return 'non-pd';
    }
    return 'unknown';
};

/**
 * Conservative downloadability: a clean PD/CC tag with no regional flag and
 * not EU-mirror-hosted. Anything else stays visible but is not something
 * Cleffy should promise to fetch (the edge function runs US-side and EU-only
 * files don't serve a plain download there anyway).
 */
export const isDownloadable = (file: FileLicense): boolean => {
    const cls = classifyLicense(file.licenseLabel);
    return (cls === 'pd' || cls === 'cc') && file.restriction === null && !file.euHosted;
};

const decodeEntities = (value: string): string =>
    value
        .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(Number(dec)))
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();

const stripTags = (value: string): string => decodeEntities(value.replace(/<[^>]+>/g, ' '));

interface ParsedFileEntry {
    filename: string;
    index: string;
    position: number;
    euHosted: boolean;
}

interface ParsedCopyrightCell {
    licenseLabel: string | null;
    restriction: string | null;
    indexes: string[];
    position: number;
}

/**
 * Extract per-file licenses from an IMSLP work page's rendered HTML.
 * Returns a map keyed by filename (space form, matching `prop=images` titles).
 *
 * Association is primarily by the file-index binding in each Copyright cell's
 * tagger link (`indexes=123/456`); cells without one fall back to "files that
 * appeared since the previous cell", which matches IMSLP's layout order.
 */
export const parseWorkPageLicenses = (html: string): Map<string, FileLicense> => {
    // Each file entry starts with the download-arrow anchor; the "(EU)" mirror
    // marker sits between that anchor and the we_file_info2 span.
    const entries: ParsedFileEntry[] = [];
    const chunks = html.split('we_file_dlarrwrap');
    let offset = chunks[0]?.length ?? 0;
    for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i] ?? '';
        const infoStart = chunk.indexOf('we_file_info2');
        const fileMatch = chunk.match(/title="File:([^"]+)">#(\d+)<\/a>/);
        if (infoStart >= 0 && fileMatch && typeof fileMatch.index === 'number' && fileMatch.index > infoStart) {
            entries.push({
                filename: decodeEntities(fileMatch[1] ?? ''),
                index: fileMatch[2] ?? '',
                position: offset + infoStart,
                euHosted: chunk.slice(0, infoStart).includes('(EU)'),
            });
        }
        offset += 'we_file_dlarrwrap'.length + chunk.length;
    }

    const cells: ParsedCopyrightCell[] = [];
    const cellRe = /<th>\s*Copyright\s*<\/th>\s*<td>([\s\S]*?)<\/td>/g;
    for (let m = cellRe.exec(html); m !== null; m = cellRe.exec(html)) {
        const body = m[1] ?? '';
        const label = body.match(/<a [^>]*>([^<]+)<\/a>/);
        const restriction = body.match(/<span style="color:red">(?:<b>)?([^<]+)/);
        const indexes = body.match(/indexes=([\d/]+)/);
        cells.push({
            licenseLabel: label ? stripTags(label[1] ?? '') || null : null,
            restriction: restriction ? stripTags(restriction[1] ?? '') || null : null,
            indexes: indexes ? (indexes[1] ?? '').split('/').filter(Boolean) : [],
            position: m.index,
        });
    }

    const byIndex = new Map<string, ParsedCopyrightCell>();
    for (const cell of cells) {
        for (const index of cell.indexes) {
            byIndex.set(index, cell);
        }
    }

    const out = new Map<string, FileLicense>();
    let previousCellEnd = 0;
    const sequential = [...cells].sort((a, b) => a.position - b.position);
    for (const cell of sequential) {
        for (const entry of entries) {
            if (out.has(entry.filename)) {
                continue;
            }
            const bound = byIndex.get(entry.index);
            const matches = bound === cell || (!bound && entry.position > previousCellEnd && entry.position < cell.position);
            if (matches) {
                out.set(entry.filename, {
                    licenseLabel: cell.licenseLabel,
                    restriction: cell.restriction,
                    euHosted: entry.euHosted,
                });
            }
        }
        previousCellEnd = cell.position;
    }

    return out;
};
