export type SymbolicSource = 'mutopia' | 'imslp' | 'user' | 'asap_eval';

export type SymbolicFormat = 'mxl' | 'xml' | 'ly' | 'mid' | 'mscz' | 'user-xml';

export type CatalogType = 'BWV' | 'WoO' | 'Op' | 'K' | 'Anh' | 'Hob' | 'D' | 'H' | 'No';

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
 * Catalog token for PDF vs candidate. Mutopia headers often omit "No. N"
 * while the pin title has it; a missing movementIndex on either side still
 * agrees. Both present and different → miss (Op. 68 No. 1 vs No. 2).
 */
export const catalogAgrees = (pdf: WorkKey, candidate: WorkKey): boolean => {
    if (pdf.composerId === 'unknown' || candidate.composerId === 'unknown') {
        return false;
    }
    if (pdf.composerId !== candidate.composerId || pdf.catalogType !== candidate.catalogType || pdf.catalogN !== candidate.catalogN) {
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
