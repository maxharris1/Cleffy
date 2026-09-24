import { movementIndexFromFilename, workKeyFromMutopiaPath } from './workKey.js';
import { catalogTokensAgree, DEBUSSY_CD_TO_LESURE, formatFromFilename, sourcePriority, type RankedCandidate, type WorkKey } from './types.js';

export interface MutopiaFile {
    url: string;
    filename: string;
}

export interface MutopiaPiece {
    composerMutopiaId: string;
    title: string;
    instrument: string;
    ftpDir: string;
    files: MutopiaFile[];
    workKey: WorkKey | null;
}

const FTP_HREF_RE = /https?:\/\/(?:www\.)?mutopiaproject\.org\/ftp\/[^"'<\s]+/gi;

const basename = (url: string): string => {
    try {
        const path = new URL(url).pathname;
        const parts = path.split('/').filter(Boolean);
        return parts[parts.length - 1] ?? url;
    } catch {
        const parts = url.split('/').filter(Boolean);
        return parts[parts.length - 1] ?? url;
    }
};

const ftpDirOf = (url: string): string => {
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts[parts.length - 1]?.includes('.')) {
            parts.pop();
        }
        return `${u.origin}/${parts.join('/')}/`;
    } catch {
        return url;
    }
};

const mutopiaComposerFromPath = (url: string): string => {
    try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        const ftp = parts.indexOf('ftp');
        return ftp >= 0 ? (parts[ftp + 1] ?? '') : '';
    } catch {
        return '';
    }
};

const isPianoInstrument = (instrument: string): boolean => {
    if (instrument.trim() === '') {
        return true;
    }
    if (!/piano/i.test(instrument)) {
        return false;
    }
    return !/4\s*hands|four\s*hands|2\s*pianos|two\s*pianos|duet|ensemble/i.test(instrument);
};

const decodeHref = (raw: string): string => raw.replace(/&amp;/g, '&');

/** Mutopia ships multi-movement MIDI as `*-mids.zip`, not loose `.mid` files. */
export const isMutopiaMidiZip = (filename: string): boolean => /(?:^|[-_])mids\.zip$/i.test(filename);

const collectFtpUrls = (html: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const match of html.matchAll(FTP_HREF_RE)) {
        const url = decodeHref(match[0] ?? '');
        if (url !== '' && !seen.has(url)) {
            seen.add(url);
            out.push(url);
        }
    }
    return out;
};

const instrumentFromRow = (row: string): string => {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
        (m[1] ?? '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
    );
    for (const cell of cells) {
        if (/^piano$/i.test(cell) || /^guitar$/i.test(cell) || /^violin$/i.test(cell) || /^voice$/i.test(cell)) {
            return cell;
        }
    }
    if (/Instrument\s*=\s*Piano/i.test(row) || />Piano</i.test(row)) {
        return 'Piano';
    }
    if (/Instrument\s*=\s*Guitar/i.test(row) || />Guitar</i.test(row)) {
        return 'Guitar';
    }
    return '';
};

const titleFromRow = (row: string): string => {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) =>
        (m[1] ?? '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
    );
    return cells[1] ?? cells[0] ?? '';
};

const pieceFromUrls = (urls: readonly string[], instrument: string, title: string): MutopiaPiece | null => {
    const midLyPdf = urls.filter(
        (u) => /\.(mid|midi|ly|mxl|xml|pdf)(?:\b|$)/i.test(u) || isMutopiaMidiZip(basename(u)),
    );
    const files: MutopiaFile[] = (midLyPdf.length > 0 ? midLyPdf : [...urls]).map((url) => ({
        url,
        filename: basename(url),
    }));
    const first = files[0];
    if (!first) {
        return null;
    }
    const workKey = workKeyFromMutopiaPath(first.url);
    if (workKey) {
        const fromName = movementIndexFromFilename(first.filename);
        if (workKey.movementIndex === undefined && fromName !== undefined) {
            workKey.movementIndex = fromName;
        }
    }
    return {
        composerMutopiaId: mutopiaComposerFromPath(first.url),
        title,
        instrument,
        ftpDir: ftpDirOf(first.url),
        files,
        workKey,
    };
};

/**
 * Parse Mutopia `piece-list.html` or `make-table.cgi?Instrument=Piano` HTML.
 * Rows that declare a non-piano instrument are dropped.
 */
export const parseMutopiaHtml = (html: string): MutopiaPiece[] => {
    const rows = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((m) => m[0] ?? '');
    const byDir = new Map<string, MutopiaPiece>();

    const addPiece = (piece: MutopiaPiece): void => {
        if (!isPianoInstrument(piece.instrument)) {
            return;
        }
        const existing = byDir.get(piece.ftpDir);
        if (!existing) {
            byDir.set(piece.ftpDir, piece);
            return;
        }
        const seen = new Set(existing.files.map((f) => f.url));
        for (const file of piece.files) {
            if (!seen.has(file.url)) {
                existing.files.push(file);
            }
        }
        if (existing.instrument === '' && piece.instrument !== '') {
            existing.instrument = piece.instrument;
        }
        if (existing.title === '' && piece.title !== '') {
            existing.title = piece.title;
        }
        if (!existing.workKey && piece.workKey) {
            existing.workKey = piece.workKey;
        }
    };

    if (rows.length > 0) {
        for (const row of rows) {
            const urls = collectFtpUrls(row);
            if (urls.length === 0) {
                continue;
            }
            const piece = pieceFromUrls(urls, instrumentFromRow(row), titleFromRow(row));
            if (piece) {
                addPiece(piece);
            }
        }
    }

    if (byDir.size === 0) {
        const grouped = new Map<string, string[]>();
        for (const url of collectFtpUrls(html)) {
            const dir = ftpDirOf(url);
            const list = grouped.get(dir) ?? [];
            list.push(url);
            grouped.set(dir, list);
        }
        for (const urls of grouped.values()) {
            const piece = pieceFromUrls(urls, 'Piano', '');
            if (piece) {
                addPiece(piece);
            }
        }
    }

    return [...byDir.values()];
};

export const mergeMutopiaIndexes = (chunks: readonly MutopiaPiece[][]): MutopiaPiece[] => {
    const byDir = new Map<string, MutopiaPiece>();
    for (const chunk of chunks) {
        for (const piece of chunk) {
            if (!isPianoInstrument(piece.instrument)) {
                continue;
            }
            const existing = byDir.get(piece.ftpDir);
            if (!existing) {
                byDir.set(piece.ftpDir, {
                    ...piece,
                    files: [...piece.files],
                    workKey: piece.workKey ? { ...piece.workKey } : null,
                });
                continue;
            }
            const seen = new Set(existing.files.map((f) => f.url));
            for (const file of piece.files) {
                if (!seen.has(file.url)) {
                    existing.files.push(file);
                }
            }
        }
    }
    return [...byDir.values()];
};

const catalogCompatible = (query: WorkKey, candidate: WorkKey): boolean => {
    if (!catalogTokensAgree(query, candidate)) {
        return false;
    }
    if (query.movementIndex !== undefined && candidate.movementIndex !== undefined) {
        return query.movementIndex === candidate.movementIndex;
    }
    return true;
};

/**
 * Guitar / tab / ukulele transcriptions of a keyboard work. They share the
 * work's catalogue number, so nothing else separates them from the piano
 * edition. The instrument field alone is not a signal: BWV 999 is a lute
 * piece and stays.
 */
const isTranscriptionFilename = (filename: string): boolean => /guitar|[-_]tab[-_.]|ukulele/i.test(filename);

export const lookupMutopia = (index: readonly MutopiaPiece[], workKey: WorkKey): RankedCandidate[] => {
    const out: RankedCandidate[] = [];
    for (const piece of index) {
        if (!isPianoInstrument(piece.instrument)) {
            continue;
        }
        for (const file of piece.files) {
            const format = isMutopiaMidiZip(file.filename) ? 'mid' : formatFromFilename(file.filename);
            // .pdf (and other non-candidate suffixes) stay index-only.
            if (format === null) {
                continue;
            }
            if (isTranscriptionFilename(file.filename)) {
                continue;
            }
            const key = workKeyFromMutopiaPath(file.url) ?? piece.workKey ?? workKeyFromMutopiaPath(piece.ftpDir);
            if (!key) {
                continue;
            }
            const fromName = movementIndexFromFilename(file.filename);
            if (key.movementIndex === undefined && fromName !== undefined) {
                key.movementIndex = fromName;
            }
            if (!catalogCompatible(workKey, key)) {
                continue;
            }
            out.push({
                source: 'mutopia',
                format,
                url: file.url,
                workKey: key,
                title: piece.title,
                arrangement: false,
                priority: sourcePriority('mutopia', format),
            });
        }
    }
    return out;
};

const MUTOPIA_ORIGIN = 'https://www.mutopiaproject.org';

const LISTING_HREF_RE = /<a\s+href="([^"]+)"/gi;

export const mutopiaFtpComposerDir = (composerId: string): string | undefined => {
    switch (composerId) {
        case 'bach':
            return 'BachJS';
        case 'beethoven':
            return 'BeethovenLv';
        case 'chopin':
            return 'ChopinFF';
        case 'mozart':
            return 'MozartWA';
        case 'schumann':
            return 'SchumannR';
        case 'czerny':
            return 'CzernyC';
        case 'burgmuller':
            return 'BurgmullerJFF';
        case 'satie':
            return 'SatieE';
        case 'petzold':
            return 'Petzold';
        case 'schubert':
            return 'SchubertF';
        case 'liszt':
            return 'LisztF';
        case 'joplin':
            return 'JoplinS';
        case 'debussy':
            return 'DebussyC';
        case 'grieg':
            return 'GriegE';
        case 'tchaikovsky':
            return 'TchaikovskyPI';
        case 'mendelssohn':
            return 'Mendelssohn-BartholdyF';
        case 'brahms':
            return 'BrahmsJ';
        case 'scarlatti':
            return 'ScarlattiD';
        case 'handel':
            return 'HandelGF';
        case 'haydn':
            return 'HaydnFJ';
        case 'clementi':
            return 'ClementiM';
        case 'rachmaninoff':
            return 'RachmaninoffS';
        case 'vivaldi':
            return 'VivaldiA';
        case 'telemann':
            return 'TelemannGP';
        case 'dvorak':
            return 'DvorakA';
        case 'diabelli':
            return 'DiabelliA';
        case 'kuhlau':
            return 'KuhlauF';
        case 'dussek':
            return 'DussekJL';
        case 'faure':
            return 'FaureG';
        case 'scriabin':
            return 'ScriabinA';
        case 'mussorgsky':
            return 'MussorgskyM';
        case 'field':
            return 'FieldJ';
        default:
            return undefined;
    }
};

export const mutopiaFtpCatalogDirs = (workKey: WorkKey): string[] => {
    switch (workKey.catalogType) {
        case 'BWV':
            return [`BWV${workKey.catalogN}`];
        case 'Anh':
            return [`BWVAnh${workKey.catalogN}`];
        case 'WoO':
            return [`WoO${workKey.catalogN}`];
        case 'Op':
            return [`Op_${workKey.catalogN}`, `Op${workKey.catalogN}`, `O${workKey.catalogN}`];
        case 'K':
            return [`K${workKey.catalogN}`];
        case 'D':
            return [`D${workKey.catalogN}`];
        case 'S':
            return [`S.${workKey.catalogN}`, `S${workKey.catalogN}`];
        case 'HWV':
            return [`HWV${workKey.catalogN}`];
        case 'RV':
            return [`rv${workKey.catalogN}`, `RV${workKey.catalogN}`];
        case 'TWV':
            return [`TWV${workKey.catalogN}`];
        case 'L':
            return [`L${workKey.catalogN}`];
        case 'CD': {
            const lesure = DEBUSSY_CD_TO_LESURE[workKey.catalogN];
            return lesure === undefined ? [] : [`L${lesure}`];
        }
        case 'Hob':
            return [`HOB-XVI-${workKey.catalogN}`];
        case 'H':
            return [`H${workKey.catalogN}`, `H.${workKey.catalogN}`];
        case 'No':
            return [];
        default: {
            const exhaustive: never = workKey.catalogType;
            throw new Error(`unhandled catalog type ${exhaustive}`);
        }
    }
};

/**
 * Mutopia sometimes files uncatalogued piano works as composer-root folders
 * (`SatieE/gymnopedie_1`, `JoplinS/entertainer`) instead of `Op_N`.
 */
export const mutopiaFtpTitleDirs = (workKey: WorkKey): string[] => {
    switch (workKey.composerId) {
        case 'satie': {
            if (workKey.catalogType !== 'No') {
                return [];
            }
            if (workKey.catalogN === 0) {
                return ['gymnopedie_1', 'gymnopedie_2', 'gymnopedie_3'];
            }
            if (workKey.catalogN === 9) {
                return ['Gnossienne'];
            }
            if (workKey.catalogN >= 1 && workKey.catalogN <= 3) {
                return [`gymnopedie_${workKey.catalogN}`];
            }
            return [];
        }
        case 'joplin': {
            if (workKey.catalogType !== 'No') {
                return [];
            }
            if (workKey.catalogN === 1) {
                return ['entertainer'];
            }
            if (workKey.catalogN === 2) {
                return ['maple'];
            }
            return [];
        }
        case 'mussorgsky':
            return ['pictures-at-an-exhibition'];
        default:
            return [];
    }
};

const listingEntries = (html: string, baseUrl: string): { dirs: string[]; files: string[] } => {
    const dirs: string[] = [];
    const files: string[] = [];
    const base = new URL(baseUrl);
    const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    for (const match of html.matchAll(LISTING_HREF_RE)) {
        const href = match[1] ?? '';
        if (href.startsWith('?') || href.startsWith('#')) {
            continue;
        }
        let abs: URL;
        try {
            abs = new URL(href, base);
        } catch {
            continue;
        }
        if (!/(?:^|\.)mutopiaproject\.org$/i.test(abs.hostname)) {
            continue;
        }
        if (!abs.pathname.startsWith('/ftp/')) {
            continue;
        }
        if (abs.pathname.length <= basePath.length && basePath.startsWith(abs.pathname)) {
            continue;
        }
        const last = abs.pathname.split('/').filter(Boolean).pop() ?? '';
        if (abs.pathname.endsWith('/') && formatFromFilename(last) === null && !isMutopiaMidiZip(last)) {
            dirs.push(abs.toString());
        } else if (formatFromFilename(last) !== null || isMutopiaMidiZip(last)) {
            files.push(abs.toString());
        }
    }
    return { dirs, files };
};

const htmlFromFtpUrls = (urls: readonly string[]): string =>
    `<table>${urls.map((url) => `<a href="${url}">file</a>`).join('\n')}</table>`;

/**
 * WorkKey → Mutopia FTP directory listing. piece-list.html no longer embeds
 * ftp:// links, so live identify walks `/ftp/{Composer}/{Catalog}/`.
 */
export const harvestMutopiaFtp = async (
    fetchText: (url: string) => Promise<string>,
    workKey: WorkKey,
): Promise<MutopiaPiece[]> => {
    const composer = mutopiaFtpComposerDir(workKey.composerId);
    if (composer === undefined) {
        return [];
    }
    const catalogs = [...mutopiaFtpCatalogDirs(workKey), ...mutopiaFtpTitleDirs(workKey)];
    const fileUrls: string[] = [];
    for (const catalog of catalogs) {
        const dirUrl = `${MUTOPIA_ORIGIN}/ftp/${composer}/${catalog}/`;
        let html: string;
        try {
            html = await fetchText(dirUrl);
        } catch {
            continue;
        }
        const listing = listingEntries(html, dirUrl);
        fileUrls.push(...listing.files);
        const wanted = listing.dirs.filter((dir) => {
            if (workKey.movementIndex === undefined) {
                return true;
            }
            const n = movementIndexFromFilename(dir.replace(/\/$/, ''));
            return n === undefined || n === workKey.movementIndex;
        });
        for (const sub of wanted.slice(0, 40)) {
            try {
                const subHtml = await fetchText(sub);
                fileUrls.push(...listingEntries(subHtml, sub).files);
            } catch {
                continue;
            }
        }
    }
    if (fileUrls.length === 0) {
        return [];
    }
    return parseMutopiaHtml(htmlFromFtpUrls(fileUrls));
};
