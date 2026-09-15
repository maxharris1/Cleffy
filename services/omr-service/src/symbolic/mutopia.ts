import { movementIndexFromFilename, workKeyFromMutopiaPath } from './workKey.js';
import { formatFromFilename, sourcePriority, type RankedCandidate, type WorkKey } from './types.js';

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
        (m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
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
        (m[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    );
    return cells[1] ?? cells[0] ?? '';
};

const pieceFromUrls = (
    urls: readonly string[],
    instrument: string,
    title: string,
): MutopiaPiece | null => {
    const midLyPdf = urls.filter((u) => /\.(mid|midi|ly|mxl|xml|pdf)(?:\b|$)/i.test(u));
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
    if (query.composerId !== candidate.composerId) {
        return false;
    }
    if (query.catalogType !== candidate.catalogType) {
        return false;
    }
    if (query.catalogN !== candidate.catalogN) {
        return false;
    }
    if (query.movementIndex !== undefined && candidate.movementIndex !== undefined) {
        return query.movementIndex === candidate.movementIndex;
    }
    return true;
};

export const lookupMutopia = (index: readonly MutopiaPiece[], workKey: WorkKey): RankedCandidate[] => {
    const out: RankedCandidate[] = [];
    for (const piece of index) {
        if (!isPianoInstrument(piece.instrument)) {
            continue;
        }
        for (const file of piece.files) {
            const format = formatFromFilename(file.filename);
            if (format === null) {
                continue;
            }
            const key =
                workKeyFromMutopiaPath(file.url) ??
                piece.workKey ??
                workKeyFromMutopiaPath(piece.ftpDir);
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
