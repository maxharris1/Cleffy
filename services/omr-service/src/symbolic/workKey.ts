import type { CatalogType, WorkKey } from './types.js';

const COMPOSER_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
    [/\bbachjs\b/i, 'bach'],
    [/\bjohann\s+sebastian\s+bach\b/i, 'bach'],
    [/\bj\.?\s*s\.?\s*bach\b/i, 'bach'],
    [/\bbach\b/i, 'bach'],
    [/\bbeethovenlv\b/i, 'beethoven'],
    [/\bludwig\s+van\s+beethoven\b/i, 'beethoven'],
    [/\bbeethoven\b/i, 'beethoven'],
    [/\bchopinff\b/i, 'chopin'],
    [/\bfr[eé]d[eé]ric\s+chopin\b/i, 'chopin'],
    [/\bchopin\b/i, 'chopin'],
    [/\bmozartwa\b/i, 'mozart'],
    [/\bwolfgang\s+amadeus\s+mozart\b/i, 'mozart'],
    [/\bw\.?\s*a\.?\s*mozart\b/i, 'mozart'],
    [/\bmozart\b/i, 'mozart'],
    [/\bschumannr\b/i, 'schumann'],
    [/\brobert\s+schumann\b/i, 'schumann'],
    [/\bschumann\b/i, 'schumann'],
    [/\bczernyc\b/i, 'czerny'],
    [/\bczerny\b/i, 'czerny'],
    [/\bburgmullerjff\b/i, 'burgmuller'],
    [/\bburgm[uü]ller\b/i, 'burgmuller'],
    [/\bsatiee\b/i, 'satie'],
    [/\berik\s+satie\b/i, 'satie'],
    [/\bsatie\b/i, 'satie'],
    [/\bpetzold\b/i, 'petzold'],
];

const MUTOPIA_COMPOSER: Record<string, string> = {
    BachJS: 'bach',
    BeethovenLv: 'beethoven',
    ChopinFF: 'chopin',
    MozartWA: 'mozart',
    SchumannR: 'schumann',
    CzernyC: 'czerny',
    BurgmullerJFF: 'burgmuller',
    SatieE: 'satie',
};

const fold = (text: string): string =>
    text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();

export const composerIdFromText = (text: string): string | undefined => {
    const folded = fold(text);
    for (const [re, id] of COMPOSER_ALIASES) {
        if (re.test(folded)) {
            return id;
        }
    }
    return undefined;
};

export const composerIdFromMutopiaId = (mutopiaId: string): string | undefined =>
    MUTOPIA_COMPOSER[mutopiaId] ?? composerIdFromText(mutopiaId);

interface CatalogHit {
    catalogType: CatalogType;
    catalogN: number;
    movementIndex?: number;
}

const catalogFromText = (text: string): CatalogHit | undefined => {
    const folded = fold(text);

    const anh = folded.match(/\bBWV\s*Anh\.?\s*(\d+)\b/i);
    if (anh?.[1]) {
        return { catalogType: 'Anh', catalogN: Number(anh[1]) };
    }

    const roman = (raw: string | undefined): number | undefined => {
        if (!raw) {
            return undefined;
        }
        const map: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };
        return map[raw.toLowerCase()];
    };

    const bwv = folded.match(/\bBWV\s*(\d+)\b/i);
    if (bwv?.[1]) {
        const movement =
            folded.match(/\b(?:invention|prelude|praeludium|menuet|minuet|air)\s*(\d+)\b/i) ??
            folded.match(/\b(?:invention|prelude|praeludium)\s+(I{1,3}|IV|V|VI{0,3}|IX|X)\b/i);
        const hit: CatalogHit = { catalogType: 'BWV', catalogN: Number(bwv[1]) };
        if (movement?.[1]) {
            hit.movementIndex = /^\d+$/.test(movement[1]) ? Number(movement[1]) : roman(movement[1]);
        }
        return hit;
    }

    const woo = folded.match(/\bWoO\s*\.?\s*(\d+)\b/i);
    if (woo?.[1]) {
        return { catalogType: 'WoO', catalogN: Number(woo[1]) };
    }

    const kay = folded.match(/\bK(?:\.?\s*V\.?|\.)?\s*(\d+)\b/i);
    if (kay?.[1] && !/\bOp\b/i.test(kay[0] ?? '')) {
        const movement = folded.match(/\b(?:mvt|movement)\s*(\d+)\b/i);
        const hit: CatalogHit = { catalogType: 'K', catalogN: Number(kay[1]) };
        if (movement?.[1]) {
            hit.movementIndex = Number(movement[1]);
        }
        return hit;
    }

    const op = folded.match(/\bOp(?:us)?\.?\s*(\d+)\b/i);
    if (op?.[1]) {
        const rest = folded.slice(op.index ?? 0);
        const no = rest.match(/\bOp(?:us)?\.?\s*\d+\s*(?:No\.?|N[o°]\.?|#|\/)\s*(\d+)\b/i);
        const hit: CatalogHit = { catalogType: 'Op', catalogN: Number(op[1]) };
        if (no?.[1]) {
            hit.movementIndex = Number(no[1]);
        }
        return hit;
    }

    const numbered = folded.match(/\b(?:gymnop[eé]die|gnossienne)[_-\s]*(?:No\.?\s*)?(\d+)\b/i);
    if (numbered?.[1]) {
        return { catalogType: 'No', catalogN: Number(numbered[1]) };
    }
    const numberedPrefix = folded.match(/\b(\d+)\s*\.?\s*(?:ème|eme)?\s*(?:gymnop[eé]die|gnossienne)\b/i);
    if (numberedPrefix?.[1]) {
        return { catalogType: 'No', catalogN: Number(numberedPrefix[1]) };
    }

    return undefined;
};

const composerFromCatalog = (hit: CatalogHit): string | undefined => {
    switch (hit.catalogType) {
        case 'BWV':
        case 'Anh':
            return 'bach';
        case 'WoO':
            return 'beethoven';
        case 'K':
            return 'mozart';
        case 'Op': {
            switch (hit.catalogN) {
                case 28:
                    return 'chopin';
                case 68:
                    return 'schumann';
                case 100:
                    return 'burgmuller';
                case 821:
                    return 'czerny';
                default:
                    return undefined;
            }
        }
        case 'No':
            return undefined;
        case 'Hob':
            return undefined;
        case 'D':
            return undefined;
        case 'H':
            return undefined;
        default: {
            const exhaustive: never = hit.catalogType;
            throw new Error(`unhandled catalog type ${exhaustive}`);
        }
    }
};

/**
 * Normalize a `WorkKey` from an IMSLP page title, PDF text tokens, or a
 * Mutopia / filename string. Structured catalog tokens win over prose.
 */
export const workKeyFromText = (text: string): WorkKey | null => {
    const catalog = catalogFromText(text);
    if (!catalog) {
        return null;
    }
    const composerId = composerIdFromText(text) ?? composerFromCatalog(catalog);
    if (!composerId) {
        return null;
    }
    const key: WorkKey = {
        composerId,
        catalogType: catalog.catalogType,
        catalogN: catalog.catalogN,
    };
    if (catalog.movementIndex !== undefined) {
        key.movementIndex = catalog.movementIndex;
    }
    return key;
};

export const movementIndexFromFilename = (filename: string): number | undefined => {
    const base = filename.replace(/\.[^.]+$/, '').replace(/\.ly$/i, '');
    const soldaten = base.match(/^(\d+)\._/);
    if (soldaten?.[1]) {
        return Number(soldaten[1]);
    }
    const opDash = base.match(/op(?:us)?[_-]?(\d+)[_-](\d+)/i);
    if (opDash?.[2]) {
        return Number(opDash[2]);
    }
    const no = base.match(/\bNo[_.\s-]*(\d+)\b/i);
    if (no?.[1]) {
        return Number(no[1]);
    }
    const prelude = base.match(/\bprelude[_-]?(\d+)\b/i);
    if (prelude?.[1]) {
        return Number(prelude[1]);
    }
    const gym = base.match(/\bgymnopedie[_-]?(\d+)\b/i);
    if (gym?.[1]) {
        return Number(gym[1]);
    }
    const ef = base.match(/\b\d+EF[_-](\d+)\b/i);
    if (ef?.[1]) {
        return Number(ef[1]);
    }
    const tail = base.match(/-(\d+)$/);
    if (tail?.[1] && !/^BWV/i.test(base)) {
        const n = Number(tail[1]);
        if (n > 0 && n < 100) {
            return n;
        }
    }
    return undefined;
};

const catalogFromMutopiaFolder = (folder: string): CatalogHit | undefined => {
    const anh = folder.match(/^BWVAnh(\d+)$/i);
    if (anh?.[1]) {
        return { catalogType: 'Anh', catalogN: Number(anh[1]) };
    }
    const bwv = folder.match(/^BWV(\d+)$/i);
    if (bwv?.[1]) {
        return { catalogType: 'BWV', catalogN: Number(bwv[1]) };
    }
    const woo = folder.match(/^WoO(\d+)$/i);
    if (woo?.[1]) {
        return { catalogType: 'WoO', catalogN: Number(woo[1]) };
    }
    const op = folder.match(/^Op_?(\d+)$/i) ?? folder.match(/^O(\d+)$/i);
    if (op?.[1]) {
        return { catalogType: 'Op', catalogN: Number(op[1]) };
    }
    return undefined;
};

/** Mutopia FTP paths look like `/ftp/BachJS/BWV772/bach-invention-01/file.mid`. */
export const workKeyFromMutopiaPath = (urlOrPath: string): WorkKey | null => {
    let path = urlOrPath;
    try {
        path = new URL(urlOrPath).pathname;
    } catch {
        // already a path
    }
    const parts = path.split('/').filter(Boolean);
    const ftp = parts.indexOf('ftp');
    if (ftp < 0 || parts.length < ftp + 3) {
        return workKeyFromText(urlOrPath);
    }
    const composerRaw = parts[ftp + 1];
    const catalogRaw = parts[ftp + 2];
    const pieceRaw = parts[ftp + 3];
    if (!composerRaw || !catalogRaw) {
        return workKeyFromText(urlOrPath);
    }
    const composerId = composerIdFromMutopiaId(composerRaw);
    const catalog = catalogFromMutopiaFolder(catalogRaw) ?? catalogFromText(`${catalogRaw} ${pieceRaw ?? ''}`);
    if (!composerId || !catalog) {
        const fromText = workKeyFromText(`${composerRaw} ${catalogRaw} ${pieceRaw ?? ''} ${urlOrPath}`);
        return fromText;
    }
    const fromPiece = pieceRaw ? movementIndexFromFilename(pieceRaw) : undefined;
    const key: WorkKey = {
        composerId,
        catalogType: catalog.catalogType,
        catalogN: catalog.catalogN,
    };
    const movement = catalog.movementIndex ?? fromPiece;
    if (movement !== undefined) {
        key.movementIndex = movement;
    }
    return key;
};

export const workKeyFromTokens = (tokens: readonly string[]): WorkKey | null =>
    workKeyFromText(tokens.join(' '));
