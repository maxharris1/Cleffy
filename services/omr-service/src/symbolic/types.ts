export type SymbolicSource = 'mutopia' | 'imslp' | 'user' | 'asap_eval';

export type SymbolicFormat = 'mxl' | 'xml' | 'ly' | 'mid' | 'mscz' | 'user-xml';

/**
 * Catalogue families a WorkKey can carry. `K` is Köchel (Mozart) or Kirkpatrick
 * (Scarlatti) — the composer disambiguates; `Hob` is Hoboken XVI only (keyboard
 * sonatas), `S` Searle (Liszt), `D` Deutsch (Schubert), `CD` the Debussy
 * catalogue used by IMSLP titles and `L` Lesure as Mutopia files Debussy.
 */
export type CatalogType =
    'BWV' | 'WoO' | 'Op' | 'K' | 'Anh' | 'Hob' | 'D' | 'H' | 'No' | 'S' | 'HWV' | 'RV' | 'TWV' | 'CD' | 'L';

export interface WorkKey {
    composerId: string;
    catalogType: CatalogType;
    catalogN: number;
    movementIndex?: number;
}

export type SourcePriority = 1 | 2 | 3 | 4;

export interface RankedCandidate {
    source: SymbolicSource;
    format: SymbolicFormat;
    url: string;
    sha256?: string;
    workKey: WorkKey;
    title?: string;
    /** True when harvest already classified this as an arrangement / other scoring. */
    arrangement: boolean;
    /** Locked source priority from the symbolic-first design. */
    priority: SourcePriority;
}

export const workKeysEqual = (a: WorkKey, b: WorkKey): boolean =>
    a.composerId === b.composerId &&
    a.catalogType === b.catalogType &&
    a.catalogN === b.catalogN &&
    (a.movementIndex ?? null) === (b.movementIndex ?? null);

/**
 * IMSLP titles Debussy by Catalogue Debussy (`CD 82`); Mutopia files him by
 * Lesure (`L75`). Same popular piano works, both ways.
 */
export const DEBUSSY_CD_TO_LESURE: Readonly<Record<number, number>> = {
    74: 66, // 2 Arabesques
    76: 68, // Rêverie
    82: 75, // Suite bergamasque
    119: 113, // Children's Corner
    125: 117, // Préludes, Livre 1
};

const debussyLesure = (key: WorkKey): number | undefined => {
    if (key.composerId !== 'debussy') {
        return undefined;
    }
    if (key.catalogType === 'L') {
        return key.catalogN;
    }
    if (key.catalogType === 'CD') {
        return DEBUSSY_CD_TO_LESURE[key.catalogN];
    }
    return undefined;
};

/**
 * Composer + catalogue token, ignoring movement. `No` catalogN 0 means the
 * whole uncatalogued set (3 Gymnopédies) and agrees with any piece number.
 */
export const catalogTokensAgree = (a: WorkKey, b: WorkKey): boolean => {
    if (a.composerId !== b.composerId) {
        return false;
    }
    const lesureA = debussyLesure(a);
    const lesureB = debussyLesure(b);
    if (lesureA !== undefined && lesureA === lesureB) {
        return true;
    }
    if (a.catalogType !== b.catalogType) {
        return false;
    }
    if (a.catalogType === 'No' && (a.catalogN === 0 || b.catalogN === 0)) {
        return true;
    }
    return a.catalogN === b.catalogN;
};

/**
 * Catalog token for PDF vs candidate. Mutopia headers often omit "No. N"
 * while the pin title has it; a missing movementIndex on either side still
 * agrees. Both present and different → miss (Op. 68 No. 1 vs No. 2).
 */
export const catalogAgrees = (pdf: WorkKey, candidate: WorkKey): boolean => {
    if (pdf.composerId === 'unknown' || candidate.composerId === 'unknown') {
        return false;
    }
    if (!catalogTokensAgree(pdf, candidate)) {
        return false;
    }
    if (pdf.movementIndex === undefined || candidate.movementIndex === undefined) {
        return true;
    }
    return pdf.movementIndex === candidate.movementIndex;
};

export const formatFromFilename = (name: string): SymbolicFormat | null => {
    const lower = name.toLowerCase();
    if (lower.endsWith('.mxl')) {
        return 'mxl';
    }
    if (lower.endsWith('.xml')) {
        return 'xml';
    }
    if (lower.endsWith('.ly') || lower.endsWith('.ly.zip')) {
        return 'ly';
    }
    if (lower.endsWith('.mscz')) {
        return 'mscz';
    }
    if (lower.endsWith('.mid') || lower.endsWith('.midi')) {
        return 'mid';
    }
    return null;
};

export const sourcePriority = (source: SymbolicSource, format: SymbolicFormat): SourcePriority => {
    switch (source) {
        case 'mutopia': {
            switch (format) {
                case 'mxl':
                case 'ly':
                case 'xml':
                    return 1;
                case 'mid':
                    return 3;
                case 'mscz':
                    return 2;
                case 'user-xml':
                    return 4;
                default: {
                    const exhaustive: never = format;
                    throw new Error(`unhandled format ${exhaustive}`);
                }
            }
        }
        case 'imslp': {
            switch (format) {
                case 'mxl':
                case 'xml':
                case 'ly':
                case 'mscz':
                    return 2;
                case 'mid':
                    return 3;
                case 'user-xml':
                    return 4;
                default: {
                    const exhaustive: never = format;
                    throw new Error(`unhandled format ${exhaustive}`);
                }
            }
        }
        case 'user':
            return 4;
        case 'asap_eval':
            return 3;
        default: {
            const exhaustive: never = source;
            throw new Error(`unhandled source ${exhaustive}`);
        }
    }
};
