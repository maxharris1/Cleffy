export type AnalysisSourceName = 'Mutopia' | 'IMSLP XML' | 'MIDI' | 'You uploaded';

export type AnalysisMatchBand = 'accept' | 'ambiguous' | 'reject';

export type AnalysisMatchReason =
    | 'accept'
    | 'ambiguous'
    | 'low_score'
    | 'meter'
    | 'bars'
    | 'arrangement'
    | 'performance_midi'
    | 'no_candidate'
    | 'parser_unusable'
    | 'alignment_failed';

export type AnalysisTier = 'symbolic' | 'omr';

/** Licences the corpus accepts. CC-BY and CC-BY-SA oblige us to attribute. */
export type AnalysisLicence = 'PD' | 'CC0' | 'CC-BY' | 'CC-BY-SA';

/** Sibling of ScoreData on score_analyses.timings. Not part of scoreDataSchema. */
export interface AnalysisSource {
    tier: AnalysisTier;
    format?: string;
    sourceName?: AnalysisSourceName;
    matchScore?: number;
    band: AnalysisMatchBand;
    reason: AnalysisMatchReason;
    /** Provenance of the edition this analysis was made from. Absent for uploads. */
    licence?: AnalysisLicence;
    editorCredit?: string;
    sourceUrl?: string;
}

export interface AlignBox {
    page: number;
    system: number;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
}

export interface AlignmentMap {
    pdfSha256: string;
    candidateSha256: string;
    pickup: boolean;
    printedBars: number;
    bySrcIndex: Record<number, AlignBox>;
}

const BANDS: readonly AnalysisMatchBand[] = ['accept', 'ambiguous', 'reject'];
const REASONS: readonly AnalysisMatchReason[] = [
    'accept',
    'ambiguous',
    'low_score',
    'meter',
    'bars',
    'arrangement',
    'performance_midi',
    'no_candidate',
    'parser_unusable',
    'alignment_failed',
];
const NAMES: readonly AnalysisSourceName[] = ['Mutopia', 'IMSLP XML', 'MIDI', 'You uploaded'];
const LICENCES: readonly AnalysisLicence[] = ['PD', 'CC0', 'CC-BY', 'CC-BY-SA'];

const isBand = (v: unknown): v is AnalysisMatchBand =>
    typeof v === 'string' && (BANDS as readonly string[]).includes(v);

const isReason = (v: unknown): v is AnalysisMatchReason =>
    typeof v === 'string' && (REASONS as readonly string[]).includes(v);

const isName = (v: unknown): v is AnalysisSourceName =>
    typeof v === 'string' && (NAMES as readonly string[]).includes(v);

const isLicence = (v: unknown): v is AnalysisLicence =>
    typeof v === 'string' && (LICENCES as readonly string[]).includes(v);

const nonEmptyString = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;

export const parseAnalysisSource = (raw: unknown): AnalysisSource | undefined => {
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const o = raw as Record<string, unknown>;
    const tier = o.tier === 'symbolic' || o.tier === 'omr' ? o.tier : null;
    if (!tier || !isBand(o.band) || !isReason(o.reason)) {
        return undefined;
    }
    const out: AnalysisSource = { tier, band: o.band, reason: o.reason };
    if (typeof o.format === 'string') {
        out.format = o.format;
    }
    if (isName(o.sourceName)) {
        out.sourceName = o.sourceName;
    }
    if (typeof o.matchScore === 'number' && Number.isFinite(o.matchScore)) {
        out.matchScore = Math.round(o.matchScore);
    }
    if (isLicence(o.licence)) {
        out.licence = o.licence;
    }
    const credit = nonEmptyString(o.editorCredit);
    if (credit !== undefined) {
        out.editorCredit = credit;
    }
    const sourceUrl = nonEmptyString(o.sourceUrl);
    if (sourceUrl !== undefined) {
        out.sourceUrl = sourceUrl;
    }
    return out;
};

/**
 * The attribution a licence obliges us to show, or null when none is owed.
 *
 * Public domain and CC0 carry no attribution condition, so a PD edition stays
 * out of the player's way. CC-BY and CC-BY-SA both require crediting the editor
 * and naming the licence, which is why those two always produce a line even when
 * the credit itself is missing — the licence alone still has to be visible.
 */
export const attributionOf = (
    source: AnalysisSource,
): { credit: string | null; licence: AnalysisLicence; url: string | null } | null => {
    if (source.licence !== 'CC-BY' && source.licence !== 'CC-BY-SA') {
        return null;
    }
    return {
        credit: source.editorCredit ?? null,
        licence: source.licence,
        url: source.sourceUrl ?? null,
    };
};

const asBox = (raw: unknown): AlignBox | null => {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const o = raw as Record<string, unknown>;
    if (
        typeof o.page !== 'number' ||
        typeof o.system !== 'number' ||
        typeof o.x0 !== 'number' ||
        typeof o.x1 !== 'number' ||
        typeof o.y0 !== 'number' ||
        typeof o.y1 !== 'number'
    ) {
        return null;
    }
    return { page: o.page, system: o.system, x0: o.x0, x1: o.x1, y0: o.y0, y1: o.y1 };
};

export const parseAlignmentMap = (raw: unknown): AlignmentMap | undefined => {
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const o = raw as Record<string, unknown>;
    if (
        typeof o.pdfSha256 !== 'string' ||
        typeof o.candidateSha256 !== 'string' ||
        typeof o.pickup !== 'boolean' ||
        typeof o.printedBars !== 'number' ||
        typeof o.bySrcIndex !== 'object' ||
        o.bySrcIndex === null
    ) {
        return undefined;
    }
    const bySrcIndex: Record<number, AlignBox> = {};
    for (const [key, value] of Object.entries(o.bySrcIndex as Record<string, unknown>)) {
        const box = asBox(value);
        if (!box) {
            continue;
        }
        bySrcIndex[Number(key)] = box;
    }
    return {
        pdfSha256: o.pdfSha256,
        candidateSha256: o.candidateSha256,
        pickup: o.pickup,
        printedBars: o.printedBars,
        bySrcIndex,
    };
};

export const parseTimingsExtras = (timings: unknown): { source?: AnalysisSource; alignmentMap?: AlignmentMap } => {
    if (typeof timings !== 'object' || timings === null) {
        return {};
    }
    const o = timings as Record<string, unknown>;
    const source = parseAnalysisSource(o.source);
    const alignmentMap = parseAlignmentMap(o.alignmentMap);
    return {
        ...(source ? { source } : {}),
        ...(alignmentMap ? { alignmentMap } : {}),
    };
};

/** Product badge copy. Integer confidence only on accept. */
export const sourceBadgeText = (source: AnalysisSource): string => {
    switch (source.band) {
        case 'accept': {
            const score = source.matchScore !== undefined ? ` ${source.matchScore}` : '';
            return source.sourceName ? `Symbolic · ${source.sourceName}${score}` : `Symbolic${score}`;
        }
        case 'ambiguous':
            return 'Pick edition';
        case 'reject':
            return 'OMR';
        default: {
            const exhaustive: never = source.band;
            throw new Error(`unhandled band ${exhaustive}`);
        }
    }
};

const bandTitle = (source: AnalysisSource): string => {
    switch (source.band) {
        case 'accept':
            return source.sourceName
                ? `Playing from ${source.sourceName} (match ${source.matchScore ?? ''})`.trim()
                : 'Playing from a matching MusicXML or MIDI';
        case 'ambiguous':
            return 'More than one edition matched — pick one, or use OMR';
        case 'reject':
            return 'No matching MusicXML';
        default: {
            const exhaustive: never = source.band;
            throw new Error(`unhandled band ${exhaustive}`);
        }
    }
};

export const sourceBadgeTitle = (source: AnalysisSource): string => {
    const attribution = attributionOf(source);
    if (!attribution) {
        return bandTitle(source);
    }
    const who = attribution.credit ?? 'Unnamed editor';
    return `${bandTitle(source)} — edition by ${who}, licensed ${attribution.licence}`;
};
