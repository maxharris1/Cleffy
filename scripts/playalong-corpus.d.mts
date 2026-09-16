export type LicenceTag = 'PD' | 'CC0' | 'CC-BY' | 'CC-BY-SA';
export type LedgerStatus = 'pending' | 'fetched' | 'queued' | 'ready' | 'skipped' | 'failed' | 'paused';
export type Origin = 'mutopia' | 'openscore' | 'ia';

export type CatalogRef = { type: string; n: number; nEnd?: number; no?: number };

export type FileLicence = { licenseLabel: string | null; restriction: string | null; euHosted: boolean };

export type LicenceVerdict = { accept: boolean; tag: LicenceTag | null; usPd: boolean; reason: string | null };

export type Work = { title: string; tier?: number; composer?: string | null; instrument?: string | null };

export type MutopiaPiece = { dir: string; piece: string; composerId: string; catalogDir: string | null };

export type MutopiaRdf = {
    title: string;
    composer: string;
    opus: string;
    instrument: string;
    date: string;
    style: string;
    arranger: string;
    source: string;
    licence: string;
    lyFile: string;
    midFile: string;
    pdfFileLet: string;
    pdfFileA4: string;
    id: string;
    maintainer: string;
    moreInfo: string;
};

export type OpenscoreRepo = { id: string; treeUrl?: string; rawBase: string; htmlBase: string; credit: string };
export type OpenscoreEntry = { dir: string; composerFolder: string; workFolder: string; files: string[] };

/** `ok: true` carries the fetch/provenance fields; `ok: false` carries `reason`. */
export type Resolution = {
    ok: boolean;
    origin: Origin | string;
    filename: string;
    reason?: string | null;
    workTitle?: string;
    pdfUrl?: string | null;
    renderFrom?: string | null;
    candidateUrl?: string | null;
    sourceUrl?: string;
    licenceTag?: LicenceTag | null;
    usPd?: boolean;
    editorCredit?: string | null;
    pianoSolo?: boolean;
    pieceTitle?: string;
    byteLength?: number | null;
    zipUrl?: string | null;
    zipEntry?: string;
};

export type RankedWork = {
    title: string;
    tier: number;
    prior: number;
    composer: string | null;
    instrument: string | null;
    pin?: boolean;
    score: number;
    downloads: number;
    useCount: number;
    workViews: number;
    composerViews: number;
};

export type CatalogWork = { page_title: string; composer: string | null; categories: string[]; touched: string | null };

export type LedgerRow = { work_title?: string; status: string; attempts?: number | string | null };

export type Plan = { queue: Resolution[]; skips: Resolution[]; origin: Origin | null };

export const LICENCE_TAGS: readonly LicenceTag[];
export const LEDGER_STATUSES: readonly LedgerStatus[];
export const ORIGINS: readonly Origin[];
export const SEED_JOB_PRIORITY: number;
export const MAX_PAGES: number;
export const MAX_PDF_BYTES: number;
export const US_PD_BEFORE_YEAR: number;
export const MAX_ATTEMPTS: number;
export const MAX_FILES_PER_WORK: number;
export const MUTOPIA_ORIGIN: string;
export const MUTOPIA_TREE_URL: string;
export const OPENSCORE_REPOS: readonly OpenscoreRepo[];
export const IA_SEARCH_URL: string;
export const IA_METADATA_URL: string;
export const IMSLP_API: string;
export const IMSLP_CRAWL_DELAY_MS: number;
export const CANONICAL_SURNAMES: readonly string[];
export const PARK_AFTER_FAILURES: number;
export const LEDGER_TRANSITIONS: Readonly<Record<LedgerStatus, readonly LedgerStatus[]>>;

export function fold(text: unknown): string;
export function composerNameOf(title: unknown): string | null;
export function composerSurnameOf(title: unknown): string | null;
export function workTitleOf(title: unknown): string;
export function composerMatchesMutopiaId(surname: string, mutopiaId: string): boolean;
export function composerMatchesFolder(composerName: string, folder: string): boolean;

export function catalogRefsFromText(text: unknown): CatalogRef[];
export function catalogMatches(wantRefs: CatalogRef[], haveRefs: CatalogRef[]): boolean;
export function catalogEquals(wantRefs: CatalogRef[], haveRefs: CatalogRef[]): boolean;
export const DEBUSSY_CD_TO_LESURE: Readonly<Record<number, number>>;
export function expandCatalogRefs(refs: readonly CatalogRef[]): CatalogRef[];
export function significantWords(title: string): string[];
export function titleWordsMatch(workTitle: string, candidateText: string): boolean;
export function titleCore(title: string): string;

export function licenceTagOf(label: unknown): LicenceTag | null;
export function publicationYearOf(value: unknown): number | null;
export function licenceVerdict(input: {
    label: string | null;
    restriction?: string | null;
    euHosted?: boolean;
    year?: number | null;
}): LicenceVerdict;
export function imslpFileLicenceFor(
    filename: string,
    licences: Map<string, FileLicence> | null | undefined,
): FileLicence | null;
export function workLevelLicence(licences: Map<string, FileLicence> | null | undefined): FileLicence | null;

export function mutopiaPiecesFromTree(paths: readonly string[]): MutopiaPiece[];
export function catalogRefsFromMutopiaDir(catalogDir: string | null): CatalogRef[];
export function parseMutopiaRdf(xml: string): MutopiaRdf;
export function mutopiaPieceInfoUrl(id: string, dir: string): string;
export function isPianoSolo(instrument: unknown): boolean;
export function mutopiaPieceCandidate(work: Work, piece: MutopiaPiece): boolean;
export function mutopiaPieceMatches(work: Work, piece: MutopiaPiece, rdf: MutopiaRdf): boolean;
export function mutopiaResolution(work: Work, piece: MutopiaPiece, rdf: MutopiaRdf): Resolution;

export function openscoreWorksFromTree(paths: readonly string[]): OpenscoreEntry[];
export function openscoreWorkMatches(work: Work, entry: OpenscoreEntry): boolean;
export function openscoreScorePdf(entry: OpenscoreEntry): string | null;
export function openscoreResolution(
    work: Work,
    entry: OpenscoreEntry,
    repo: OpenscoreRepo,
    options?: { renderer?: boolean },
): Resolution;

export function iaRecordId(title: string): string;
export function iaExactQuery(title: string): string;
export function iaCatalogToken(title: string): string | null;
export function iaFallbackQueries(title: string): string[];
export function iaSearchUrl(query: string, rows?: number): string;
export function pickIaDoc<T extends { title?: string; creator?: string | string[] }>(
    title: string,
    docs: readonly T[] | null | undefined,
): T | null;
export const IA_PART_OR_ARRANGEMENT_RE: RegExp;
export const IA_PART_ABBREV_RE: RegExp;
export function iaFileIsPartOrArrangement(name: string): boolean;
export function pickIaPdf<T extends { name?: string; source?: string; size?: string | number }>(
    files: readonly T[] | null | undefined,
    editions?: readonly ImslpEdition[],
): T | null;
export function iaFileUrl(identifier: string, name: string): string;
export function iaResolution(
    work: Work,
    item: { metadata: { identifier?: string; title?: string; date?: string | null; subject?: string[] } },
    file: { name: string; size?: string | number },
    licences: Map<string, FileLicence>,
): Resolution;
export function imslpParseUrl(title: string): string;
export function imslpRedirectsUrl(title: string): string;
export function imslpRedirectAliases(
    title: string,
    response: { query?: { backlinks?: Array<{ title?: string; ns?: number }> } } | null | undefined,
): string[];

export type ZipEntry = { name: string; method: number; compressedSize: number; size: number; offset: number };
export function expandZipResolution(res: Resolution, entryNames: readonly string[]): Resolution[];
export function zipEntries(buf: Buffer): ZipEntry[];
export function zipEntrySlice(buf: Buffer, entry: ZipEntry): { method: number; data: Buffer };
export function zipExtract(buf: Buffer, entry: ZipEntry): Buffer;

export function canonicalComposerOrder(popular: readonly Work[], extraSurnames?: readonly string[]): string[];
export const RANK_WEIGHTS: Readonly<{ download: number; use: number; work: number; composer: number; prior: number }>;
export type Popularity = { workViews?: number; composerViews?: number; article?: string | null };
export function popularityScore(popularity?: Popularity, weights?: typeof RANK_WEIGHTS): number;
export function rankWorks(input: {
    popular: readonly Work[];
    pins?: readonly { title: string }[];
    catalog?: readonly CatalogWork[];
    demand?: Map<string, number>;
    corpusUse?: Map<string, number>;
    popularity?: Map<string, Popularity>;
    weights?: typeof RANK_WEIGHTS;
}): RankedWork[];
export function demandFromDocumentTitles(titles: readonly unknown[]): Map<string, number>;

export function mutopiaPieceDirFromUrl(url: string): string | null;
export function evalPinPieceDirs(pins: readonly unknown[]): string[];
export function titleForMutopiaPiece(
    piece: MutopiaPiece,
    rdf: MutopiaRdf,
    popular: readonly Work[],
    catalogWorks?: readonly CatalogWork[],
): string | null;

export function canTransition(from: string, to: string): boolean;
export function shouldProcess(
    row: LedgerRow,
    options?: { retrySkipped?: boolean },
): { process: boolean; reason: string };
export function gateReviewError(
    timings: { corpusGate?: { promoted?: boolean; reason?: string } | null } | null | undefined,
): string | null;
export function reconcileQueued(
    job: { status: string; last_error?: string | null } | null | undefined,
    analysis:
        | {
              status: string;
              error?: string | null;
              timings?: { corpusGate?: { promoted?: boolean; reason?: string } | null } | null;
          }
        | null
        | undefined,
): { status: 'ready' | 'failed' | 'skipped'; error: string | null } | null;
export function sourceEnabled(origin: string, options?: { sources?: readonly string[]; parked?: Set<string> }): boolean;
export function parseSources(value: string | null | undefined): Origin[];
export function backoffDelayMs(consecutiveFailures: number, options?: { baseMs?: number; maxMs?: number }): number;

export function planWork(resolutions: readonly Resolution[], options?: { sources?: readonly string[] }): Plan;
export function coverageByOrigin(
    plans: Map<string, { origin: string | null } | undefined>,
    titles: readonly string[],
): Record<string, number>;
export function progressEvent(counts: {
    ready?: number;
    queued?: number;
    fetched?: number;
    skipped?: number;
    failed?: number;
    target?: number;
    batchId?: number | null;
    [extra: string]: unknown;
}): string;
export function workEvent(event: {
    workTitle: string;
    status: string;
    origin?: string | null;
    filename?: string | null;
    pdfSha256?: string | null;
    reason?: string | null;
}): string;
export function coveredWorkCount(rows: Iterable<{ work_title: string; status: string }>): number;

export const WIKI_API: string;
export const WIKI_PAGEVIEWS_API: string;
export const WIKI_DELAY_MS: number;
export function composerArticleName(title: string): string | null;
export function wikiSearchQuery(title: string): string;
export function wikiSearchUrl(query: string): string;
export function pageviewsWindow(now?: Date): { start: string; end: string };
export function wikiPageviewsUrl(article: string, window?: { start: string; end: string }): string;
export function monthlyAverageViews(response: { items?: Array<{ views?: number }> } | null | undefined): number;
export function wikiArticleMatches(workTitle: string, articleTitle: string): boolean;
export function wikiArticleFor(
    workTitle: string,
    searchResponse: { query?: { search?: Array<{ title?: string }> } } | null | undefined,
): string | null;

export type ImslpFileBlockEntry = {
    filename: string;
    description: string;
    imageType: string | null;
    editor: string | null;
    arranger: string | null;
    publisher: string | null;
    misc: string | null;
    copyright: string | null;
};
export type ImslpFileStats = {
    filename: string;
    fileId: string | null;
    sizeMb: number | null;
    pages: number | null;
    rating: number | null;
    downloads: number | null;
    description: string;
    typesetLine: boolean | null;
};
export type ImslpEdition = Partial<ImslpFileBlockEntry> &
    Partial<ImslpFileStats> & { filename?: string; typeset?: boolean | null; complete?: boolean; score?: number };
export type EditionSummary = {
    filename: string;
    fileId: string | null;
    imageType: string | null;
    description: string;
    editor: string | null;
    rating: number | null;
    downloads: number | null;
    pages: number | null;
    sizeMb: number | null;
    score: number;
};
export type EditionSignals = {
    chosen: {
        origin: string;
        filename: string;
        imageType: string;
        complete: boolean;
        rating: number | null;
        downloads: number | null;
    } | null;
    matchedImslp: EditionSummary | null;
    bestImslp: EditionSummary | null;
    matchesBest: boolean | null;
    imslpEditions: number;
};
export function parseImslpFileBlocks(wikitext: string): ImslpFileBlockEntry[];
export function parseImslpFileStats(html: string): Map<string, ImslpFileStats>;
export function editionScore(edition: ImslpEdition): number;
export function imslpEditions(
    wikitext: string,
    html: string,
): Array<ImslpFileBlockEntry & Partial<ImslpFileStats> & { typeset: boolean | null; complete: boolean; score: number }>;
export function bestImslpEdition<T extends ImslpEdition>(editions: readonly T[]): T | null;
export function cleanWikitext(value: unknown): string;
export function editionSummary(edition: ImslpEdition | null | undefined): EditionSummary | null;
export function matchImslpEdition<T extends ImslpEdition>(filename: string, editions: readonly T[]): T | null;
export function editionSignals(
    res: { origin: string; filename: string } | null,
    editions: readonly ImslpEdition[] | null | undefined,
): EditionSignals;
