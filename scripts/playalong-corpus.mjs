#!/usr/bin/env node
/**
 * Play-along corpus seed — the pure parts of scripts/seed-playalong-corpus.mjs.
 *
 * Everything here is network-free and side-effect-free so the ranking, the
 * licence filter, the source matching, the ledger state machine and the
 * dry-run plan can be unit-tested. The CLI wires fetch / PostgREST / Storage
 * around these.
 *
 * Default sources are bulk-friendly public mirrors (Mutopia, OpenScore, the
 * Internet Archive `imslp` collection). `--source imslp` is opt-in and last:
 * the CLI fetches one file at a time via the live wait-page → CDN parse
 * (`extractCdnUrlFromWaitPage`); it does not sleep 15s unless `--imslp-wait`.
 * See docs/omr-midi-preload-plan.md (Phase 2 / 2b).
 */

import { inflateRawSync } from 'node:zlib';

import {
    extractCdnUrlFromWaitPage,
    looksLikePdf,
    MAX_PDF_BYTES as IMSLP_MAX_PDF_BYTES,
} from '../supabase/functions/_shared/imslpWaitPage.ts';

/** Values accepted by the `playalong_corpus.licence_tag` / `pd_pdf_store.licence_tag` check constraints. */
export const LICENCE_TAGS = Object.freeze(['PD', 'CC0', 'CC-BY', 'CC-BY-SA']);
/** Values accepted by the `playalong_corpus_seed.status` check constraint. */
export const LEDGER_STATUSES = Object.freeze(['pending', 'fetched', 'queued', 'ready', 'skipped', 'failed', 'paused']);
/** All seed origins in first-hit-wins order. `imslp` is last and opt-in. */
export const ORIGINS = Object.freeze(['mutopia', 'openscore', 'ia', 'imslp']);
/** `--source all` and the CLI default: bulk mirrors only — never imslp.org PDF bytes. */
export const BULK_ORIGINS = Object.freeze(['mutopia', 'openscore', 'ia']);
/** Same as ORIGINS; kept so callers can iterate the resolution order explicitly. */
export const ORIGIN_ORDER = ORIGINS;
/** Cosmetic 15s wait on the IMSLP wait page; `--imslp-wait` turns this on. Default off. */
export const IMSLP_WAIT_MS = 15_000;

export const SEED_JOB_PRIORITY = -10;
/** Mirrors MAX_PAGES in services/omr-service/src/job.ts — skip before enqueue. */
export const MAX_PAGES = 60;
/** Matches the `scores` / `pd-pdfs` bucket file_size_limit. */
export const MAX_PDF_BYTES = IMSLP_MAX_PDF_BYTES;
/** US public domain by publication year (the plan's "published before 1931"). */
export const US_PD_BEFORE_YEAR = 1931;
/** Fetch / enqueue attempts per ledger row before it stays `failed`. */
export const MAX_ATTEMPTS = 3;
/** Per-work file cap (WTC I is 48 Mutopia pieces; Op.28 is 24). */
export const MAX_FILES_PER_WORK = 48;

/** Overridable so the mode tests can serve RDF + PDF fixtures from a local server. */
export const MUTOPIA_ORIGIN = process.env.CORPUS_MUTOPIA_ORIGIN ?? 'https://www.mutopiaproject.org';
export const MUTOPIA_TREE_URL =
    'https://api.github.com/repos/MutopiaProject/MutopiaProject/git/trees/master?recursive=1';
export const OPENSCORE_REPOS = Object.freeze([
    {
        id: 'lieder',
        treeUrl: 'https://api.github.com/repos/OpenScore/Lieder/git/trees/main?recursive=1',
        rawBase: 'https://raw.githubusercontent.com/OpenScore/Lieder/main/',
        htmlBase: 'https://github.com/OpenScore/Lieder/tree/main/',
        credit: 'OpenScore Lieder contributors (CC0)',
    },
    {
        id: 'string-quartets',
        treeUrl: 'https://api.github.com/repos/OpenScore/StringQuartets/git/trees/main?recursive=1',
        rawBase: 'https://raw.githubusercontent.com/OpenScore/StringQuartets/main/',
        htmlBase: 'https://github.com/OpenScore/StringQuartets/tree/main/',
        credit: 'OpenScore String Quartets contributors (CC0)',
    },
]);
export const IA_SEARCH_URL = 'https://archive.org/advancedsearch.php';
export const IA_METADATA_URL = 'https://archive.org/metadata/';
export const IMSLP_API = 'https://imslp.org/api.php';
/** robots.txt Crawl-delay on imslp.org; metadata calls only. */
export const IMSLP_CRAWL_DELAY_MS = 2000;

/**
 * Copy of ERA_SURNAMES in supabase/functions/_shared/era.ts (not exported there;
 * the three era.ts copies are kept in lockstep and this script must not edit
 * them). tests/corpus/playalongCorpus.test.ts asserts this stays a superset.
 */
export const CANONICAL_SURNAMES = Object.freeze([
    'Bach',
    'Vivaldi',
    'Handel',
    'Pachelbel',
    'Scarlatti',
    'Couperin',
    'Rameau',
    'Telemann',
    'Purcell',
    'Mozart',
    'Haydn',
    'Beethoven',
    'Clementi',
    'Kuhlau',
    'Diabelli',
    'Hummel',
    'Czerny',
    'Dussek',
    'Chopin',
    'Schubert',
    'Brahms',
    'Liszt',
    'Schumann',
    'Tchaikovsky',
    'Mendelssohn',
    'Grieg',
    'Dvořák',
    'Fauré',
    'Mussorgsky',
    'Burgmüller',
    'Heller',
    'Field',
    'Elgar',
    'Scriabin',
    'Debussy',
    'Ravel',
    'Satie',
    'Rachmaninoff',
    'Joplin',
    'Bartók',
    'Prokofiev',
    'Shostakovich',
    'Gershwin',
    'Poulenc',
    'Kabalevsky',
    'Khachaturian',
]);

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export const fold = (text) =>
    String(text ?? '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/[\u2018\u2019]/g, "'")
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();

/** `Für Elise, WoO 59 (Beethoven, Ludwig van)` → `Beethoven, Ludwig van`. */
export const composerNameOf = (title) => {
    const match = /\(([^()]+)\)\s*$/.exec(String(title ?? '').trim());
    const name = match?.[1]?.trim();
    return name ? name : null;
};

export const composerSurnameOf = (title) => {
    const name = composerNameOf(title);
    if (!name) {
        return null;
    }
    const surname = (name.split(',')[0] ?? '').trim();
    return surname ? surname : null;
};

/** Title without its `(Composer, Name)` suffix. */
export const workTitleOf = (title) =>
    String(title ?? '')
        .replace(/\s*\([^()]+\)\s*$/, '')
        .trim();

const lettersOnly = (text) => fold(text).replace(/[^a-z]/g, '');

/**
 * Mutopia composer ids are surname + initials (`BeethovenLv`, `BachJS`,
 * `Mendelssohn-BartholdyF`). A surname matches when the folded id starts with it.
 */
export const composerMatchesMutopiaId = (surname, mutopiaId) => {
    const s = lettersOnly(surname);
    const id = lettersOnly(mutopiaId);
    return s.length >= 3 && id.startsWith(s);
};

/** `Beethoven,_Ludwig_van` (OpenScore folder) ↔ `Beethoven, Ludwig van`. */
export const composerMatchesFolder = (composerName, folder) =>
    fold(String(folder).replace(/_/g, ' ')) === fold(composerName);

// ---------------------------------------------------------------------------
// Catalog references (Op.27 No.2, BWV 846–869, K.331, D.899, …)
// ---------------------------------------------------------------------------

/** @typedef {{ type: string, n: number, nEnd?: number, no?: number }} CatalogRef */

const REF_PATTERNS = [
    { type: 'Anh', re: /\bBWV\s*Anh\.?\s*(\d+)/gi },
    { type: 'BWV', re: /\bBWV\s*(\d+)(?:\s*-\s*(\d+))?/gi, range: true },
    { type: 'WoO', re: /\bWoO\s*\.?\s*(\d+)/gi },
    { type: 'Op', re: /\bOp(?:us)?[._]?\s*(\d+)[a-z]?(?:\s*,?\s*(?:No\.?|Nr\.?|n[o°]?\.?|#)\s*(\d+))?/gi, no: true },
    { type: 'HWV', re: /\bHWV\s*(\d+)(?:\s*-\s*(\d+))?/gi, range: true },
    { type: 'RV', re: /\bRV\s*(\d+)/gi },
    { type: 'TWV', re: /\bTWV\s*(\d+)/gi },
    { type: 'Hob', re: /\bHob\.?\s*([IVX]+[a-z]?)\s*[:.]\s*(\d+)/gi, group: true },
    { type: 'K', re: /\bK\.?\s?V?\.?\s*(\d+)/g },
    { type: 'D', re: /\bD\.\s?(\d+)/g },
    { type: 'S', re: /\bS\.\s?(\d+)/g },
    { type: 'M', re: /\bM\.\s?(\d+)/g },
    { type: 'CD', re: /\bCD\s*(\d+)/g },
    { type: 'L', re: /\bL\.\s?(\d+)/g },
    { type: 'P', re: /\bP\.\s?(\d+)/g },
];

/**
 * Every catalog reference in a title / Mutopia opus / folder name. `BWV Anh`
 * is its own type so `BWV Anh.114` never reads as `BWV 114`.
 */
export const catalogRefsFromText = (text) => {
    const source = String(text ?? '')
        .normalize('NFKD')
        .replace(/[\u2010-\u2015\u2212]/g, '-');
    const refs = [];
    let scan = source;
    for (const { type, re, range, no, group } of REF_PATTERNS) {
        re.lastIndex = 0;
        for (const match of scan.matchAll(re)) {
            // Hoboken keeps its roman group in the type (`Hob.I` vs `Hob.XVI`).
            const n = Number(group ? match[2] : match[1]);
            if (!Number.isFinite(n)) {
                continue;
            }
            const ref = { type: group ? `${type}.${match[1].toUpperCase()}` : type, n };
            if (range && match[2]) {
                ref.nEnd = Number(match[2]);
            }
            if (no && match[2]) {
                ref.no = Number(match[2]);
            }
            refs.push(ref);
        }
        if (type === 'Anh') {
            // Strip `BWV Anh.114` so the BWV pattern does not see `114`.
            scan = scan.replace(re, ' ');
        }
    }
    return refs;
};

const refCovers = (want, have) => {
    if (want.type !== have.type) {
        return false;
    }
    const wantLo = want.n;
    const wantHi = want.nEnd ?? want.n;
    const haveLo = have.n;
    const haveHi = have.nEnd ?? have.n;
    if (haveHi < wantLo || haveLo > wantHi) {
        return false;
    }
    if (want.no !== undefined && have.no !== undefined && want.no !== have.no) {
        return false;
    }
    return true;
};

/**
 * True when some reference of the candidate falls inside a reference of the
 * wanted work. Ranges cover their members. When the work names a `No.`, a
 * candidate that names a different `No.` anywhere is another piece of the set
 * (`op76-n1` is not `Op.76 No.3`); a candidate naming no `No.` is the whole set.
 */
export const catalogMatches = (wantRefs, haveRefs) =>
    wantRefs.some((want) => {
        const same = haveRefs.filter((have) => refCovers({ ...want, no: undefined }, have));
        if (same.length === 0) {
            return false;
        }
        if (want.no === undefined) {
            return true;
        }
        if (same.some((have) => have.no === want.no)) {
            return true;
        }
        return same.every((have) => have.no === undefined);
    });

/** Exact agreement (same type, same number, same `No.` when either has it). */
export const catalogEquals = (wantRefs, haveRefs) =>
    wantRefs.length > 0 &&
    wantRefs.every((want) =>
        haveRefs.some(
            (have) =>
                have.type === want.type &&
                have.n === want.n &&
                (have.nEnd ?? null) === (want.nEnd ?? null) &&
                (have.no ?? null) === (want.no ?? null),
        ),
    );

const STOP_WORDS = new Set([
    'the',
    'a',
    'an',
    'in',
    'of',
    'no',
    'major',
    'minor',
    'for',
    'and',
    'la',
    'le',
    'les',
    'der',
    'die',
    'das',
    'des',
    'du',
    'et',
    'und',
    'von',
    'en',
    'on',
    'from',
    'to',
    'i',
    'ii',
    'iii',
    'op',
    'nr',
    'sharp',
    'flat',
    'de',
    'di',
    'da',
    'del',
    // Catalogue tokens are references, not title words.
    'bwv',
    'woo',
    'hob',
    'hwv',
    'rv',
    'twv',
    'cd',
    'kv',
    'anh',
    'opus',
]);

const stem = (word) => word.replace(/s$/, '').replace(/e$/, '');

export const significantWords = (title) =>
    fold(workTitleOf(title))
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(' ')
        .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !STOP_WORDS.has(w))
        .map(stem)
        .filter((w) => w.length >= 3 || /^\d/.test(w));

/** Word-level match for works without a catalog number (`The Entertainer`, `3 Gymnopédies`). */
export const titleWordsMatch = (workTitle, candidateText) => {
    const want = significantWords(workTitle);
    if (want.length === 0) {
        return false;
    }
    const have = new Set(significantWords(`${candidateText} (x)`));
    return want.every((w) => have.has(w));
};

// ---------------------------------------------------------------------------
// Licence filter
// ---------------------------------------------------------------------------

/**
 * Map an IMSLP / Mutopia / OpenScore licence label onto a `licence_tag`
 * constraint value, or null when the label is not one we may ingest.
 */
export const licenceTagOf = (label) => {
    const l = fold(label);
    if (l === '') {
        return null;
    }
    if (/performance restricted/.test(l)) {
        return null;
    }
    if (/non-?pd/.test(l)) {
        return null;
    }
    if (/\bcc0\b|creative commons zero|public domain dedication|public domain mark/.test(l)) {
        return 'CC0';
    }
    if (/^public domain/.test(l)) {
        return 'PD';
    }
    if (/creative commons/.test(l) || /^cc[- ]by/.test(l)) {
        if (/non-?commercial|\bnc\b|no-?deriv|\bnd\b/.test(l)) {
            return null;
        }
        if (/share[ -]?alike|\bsa\b/.test(l)) {
            return 'CC-BY-SA';
        }
        if (/attribution|\bby\b/.test(l)) {
            return 'CC-BY';
        }
        return null;
    }
    return null;
};

export const publicationYearOf = (value) => {
    const match = /\b(1[5-9]\d\d|20\d\d)\b/.exec(String(value ?? ''));
    return match ? Number(match[1]) : null;
};

/**
 * Ingest decision for one file.
 *
 * @param {{ label: string | null, restriction?: string | null, euHosted?: boolean, year?: number | null }} input
 * @returns {{ accept: boolean, tag: string | null, usPd: boolean, reason: string | null }}
 */
export const licenceVerdict = ({ label, restriction = null, euHosted = false, year = null }) => {
    const l = fold(label);
    if (/performance restricted/.test(l)) {
        return { accept: false, tag: null, usPd: false, reason: 'performance_restricted' };
    }
    if (/creative commons/.test(l) && /non-?commercial|\bnc\b|no-?deriv|\bnd\b/.test(l)) {
        return { accept: false, tag: null, usPd: false, reason: 'non_commercial' };
    }
    const tag = licenceTagOf(label);
    if (tag === null) {
        return { accept: false, tag: null, usPd: false, reason: 'no_licence' };
    }
    if (euHosted) {
        return { accept: false, tag, usPd: false, reason: 'eu_hosted' };
    }
    if (restriction && restriction.trim() !== '') {
        return { accept: false, tag, usPd: false, reason: 'not_us_pd' };
    }
    // US-PD: published before 1931, or an IMSLP-reviewed tag with no regional flag
    // (a CC edition grants the rights itself).
    const usPd = tag !== 'PD' || year === null || year < US_PD_BEFORE_YEAR;
    if (!usPd) {
        return { accept: false, tag, usPd: false, reason: 'not_us_pd' };
    }
    return { accept: true, tag, usPd: true, reason: null };
};

/** IMSLP file names carry a `PMLP1234-` prefix; IA copies often drop it. */
const looseFilenameKey = (name) =>
    lettersOnly(
        String(name)
            .replace(/^PMLP\d+-/i, '')
            .replace(/\.pdf$/i, ''),
    );

/**
 * The IMSLP licence row for a file, by canonical name first, then loosely
 * (prefix / case / punctuation-insensitive). `licences` is
 * `parseWorkPageLicenses(html)` from supabase/functions/_shared/imslpLicense.ts.
 */
export const imslpFileLicenceFor = (filename, licences) => {
    if (!licences || licences.size === 0) {
        return null;
    }
    const spaced = String(filename).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    const canonical = spaced.charAt(0).toUpperCase() + spaced.slice(1);
    const direct = licences.get(canonical) ?? licences.get(filename);
    if (direct) {
        return direct;
    }
    const key = looseFilenameKey(filename);
    if (key === '') {
        return null;
    }
    for (const [name, licence] of licences) {
        if (looseFilenameKey(name) === key) {
            return licence;
        }
    }
    return null;
};

/**
 * Work-level fallback when the scan's filename cannot be bound to one IMSLP
 * file: the work must carry at least one clean (unflagged, non-EU) PD / CC
 * file. The caller still requires the scan's own publication year to be
 * US-PD, which is what keeps a flagged later edition out.
 */
export const workLevelLicence = (licences) => {
    if (!licences || licences.size === 0) {
        return null;
    }
    for (const licence of licences.values()) {
        if (!licence.euHosted && !licence.restriction && licenceTagOf(licence.licenseLabel) === 'PD') {
            return licence;
        }
    }
    return null;
};

// ---------------------------------------------------------------------------
// Mutopia
// ---------------------------------------------------------------------------

/**
 * Piece directories from the MutopiaProject git tree (`git/trees/…?recursive=1`).
 * A piece is the deepest directory holding `.ly` files, with a `*-lys/`
 * sub-directory collapsed onto its parent (multi-movement pieces).
 *
 * @returns {Array<{ dir: string, piece: string, composerId: string, catalogDir: string | null }>}
 */
export const mutopiaPiecesFromTree = (paths) => {
    const dirs = new Set();
    for (const path of paths) {
        if (!path.startsWith('ftp/') || !/\.ly$/i.test(path)) {
            continue;
        }
        const parts = path.split('/');
        parts.pop();
        if (parts.length > 0 && /-lys$/i.test(parts[parts.length - 1])) {
            parts.pop();
        }
        if (parts.length < 3) {
            continue;
        }
        dirs.add(parts.join('/'));
    }
    return [...dirs].sort().map((dir) => {
        const parts = dir.split('/');
        return {
            dir,
            piece: parts[parts.length - 1],
            composerId: parts[1],
            catalogDir: parts.length >= 4 ? parts[2] : null,
        };
    });
};

/** `O27` / `Op_27` / `WoO59` / `BWVAnh114` / `BWV846` / `K331` → refs. */
export const catalogRefsFromMutopiaDir = (catalogDir) => {
    if (!catalogDir) {
        return [];
    }
    const m =
        /^(?:Op_?|O)(\d+)$/i.exec(catalogDir) ??
        /^(WoO)(\d+)$/i.exec(catalogDir) ??
        /^(BWVAnh)(\d+)$/i.exec(catalogDir) ??
        /^(BWV|HWV|RV|TWV|K|D|S|L)\.?(\d+)$/i.exec(catalogDir) ??
        /^(HOB)-XVI-(\d+)$/i.exec(catalogDir);
    if (!m) {
        return [];
    }
    if (m.length === 2) {
        return [{ type: 'Op', n: Number(m[1]) }];
    }
    const upper = m[1].toUpperCase();
    // Hoboken dirs are keyboard sonatas (`HOB-XVI-27`), the `Hob.XVI` ref type.
    const type = upper === 'BWVANH' ? 'Anh' : upper === 'WOO' ? 'WoO' : upper === 'HOB' ? 'Hob.XVI' : upper;
    return [{ type, n: Number(m[2]) }];
};

const decodeXmlEntities = (value) =>
    String(value ?? '')
        .replace(/&amp;/g, '&')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
        .trim();

const rdfField = (xml, name) => {
    const match = new RegExp(`<mp:${name}>([\\s\\S]*?)</mp:${name}>`).exec(xml);
    return match ? decodeXmlEntities(match[1]) : '';
};

/** Parse a Mutopia `<piece>.rdf` (served next to the PDF / MIDI on the FTP tree). */
export const parseMutopiaRdf = (xml) => ({
    title: rdfField(xml, 'title'),
    composer: rdfField(xml, 'composer'),
    opus: rdfField(xml, 'opus'),
    instrument: rdfField(xml, 'for'),
    date: rdfField(xml, 'date'),
    style: rdfField(xml, 'style'),
    arranger: rdfField(xml, 'arranger'),
    source: rdfField(xml, 'source'),
    licence: rdfField(xml, 'licence'),
    lyFile: rdfField(xml, 'lyFile'),
    midFile: rdfField(xml, 'midFile'),
    pdfFileLet: rdfField(xml, 'pdfFileLet'),
    pdfFileA4: rdfField(xml, 'pdfFileA4'),
    id: rdfField(xml, 'id'),
    maintainer: rdfField(xml, 'maintainer'),
    moreInfo: rdfField(xml, 'moreInfo'),
});

/** `Mutopia-2015/08/18-931` → the piece-info page (the courtesy source link). */
export const mutopiaPieceInfoUrl = (id, dir) => {
    const match = /-(\d+)$/.exec(String(id ?? ''));
    if (match) {
        return `${MUTOPIA_ORIGIN}/cgibin/piece-info.cgi?id=${match[1]}`;
    }
    return `${MUTOPIA_ORIGIN}/${dir}/`;
};

export const isPianoSolo = (instrument) => {
    const text = String(instrument ?? '').trim();
    if (text === '') {
        return false;
    }
    if (!/piano|harpsichord|clavier|keyboard/i.test(text)) {
        return false;
    }
    return !/4\s*hands|four\s*hands|2\s*pianos|two\s*pianos|duet|ensemble|voice|violin|cello|flute|orchestra|quartet|trio/i.test(
        text,
    );
};

/**
 * IMSLP titles Debussy by the Catalogue Debussy (`CD 82`); Mutopia files him by
 * Lesure (`L75`). Mirrors DEBUSSY_CD_TO_LESURE in services/omr-service/src/symbolic/mutopia.ts.
 */
export const DEBUSSY_CD_TO_LESURE = Object.freeze({ 74: 66, 76: 68, 82: 75, 119: 113, 125: 117 });

/** Refs plus their cross-catalogue equivalents (CD ↔ L for Debussy). */
export const expandCatalogRefs = (refs) => {
    const out = [...refs];
    for (const ref of refs) {
        if (ref.type === 'CD' && DEBUSSY_CD_TO_LESURE[ref.n] !== undefined) {
            out.push({ ...ref, type: 'L', n: DEBUSSY_CD_TO_LESURE[ref.n] });
        } else if (ref.type === 'L') {
            for (const [cd, lesure] of Object.entries(DEBUSSY_CD_TO_LESURE)) {
                if (lesure === ref.n) {
                    out.push({ ...ref, type: 'CD', n: Number(cd) });
                }
            }
        }
    }
    return out;
};

/** A work's catalog refs as Mutopia would file them. */
const wantRefsOf = (work) => expandCatalogRefs(catalogRefsFromText(workTitleOf(work.title)));

/**
 * Cheap pre-filter before fetching a piece's RDF: composer must match, and the
 * catalog directory (when the tree has one) must agree with the work's refs.
 */
export const mutopiaPieceCandidate = (work, piece) => {
    const surname = composerSurnameOf(work.title);
    const wantRefs = wantRefsOf(work);
    // Mutopia files every BWV / BWV Anh. number under BachJS, whoever IMSLP credits.
    const bachCatalog = piece.composerId === 'BachJS' && wantRefs.some((r) => r.type === 'BWV' || r.type === 'Anh');
    if (!surname || (!bachCatalog && !composerMatchesMutopiaId(surname, piece.composerId))) {
        return false;
    }
    if (wantRefs.length === 0) {
        return true;
    }
    const dirRefs = catalogRefsFromMutopiaDir(piece.catalogDir);
    if (dirRefs.length === 0) {
        return true;
    }
    return catalogMatches(wantRefs, dirRefs);
};

/** Confirm a candidate against its RDF: opus / piece name refs, or title words. */
export const mutopiaPieceMatches = (work, piece, rdf) => {
    if (rdf.arranger && rdf.arranger.trim() !== '') {
        return false;
    }
    const wantRefs = wantRefsOf(work);
    if (wantRefs.length > 0) {
        const haveRefs = [
            ...catalogRefsFromText(rdf.opus),
            ...catalogRefsFromMutopiaDir(piece.catalogDir),
            ...catalogRefsFromText(piece.piece.replace(/[_-]/g, ' ')),
        ];
        return haveRefs.length > 0 && catalogMatches(wantRefs, haveRefs);
    }
    return titleWordsMatch(work.title, `${rdf.title} ${rdf.moreInfo} ${piece.piece.replace(/[_-]/g, ' ')}`);
};

/**
 * Resolution record for a Mutopia piece, or null with a skip reason when the
 * RDF licence is not ingestable.
 */
export const mutopiaResolution = (work, piece, rdf) => {
    const verdict = licenceVerdict({ label: rdf.licence, year: publicationYearOf(rdf.date) });
    const base = `${MUTOPIA_ORIGIN}/${piece.dir}/`;
    // Multi-movement pieces ship one `*-pdfs.zip` per paper size; the caller
    // expands it into one resolution per PDF inside (see expandZipResolution).
    const zip = [rdf.pdfFileLet, rdf.pdfFileA4].find((f) => /\.zip$/i.test(f ?? ''));
    const filename = [rdf.pdfFileLet, rdf.pdfFileA4].find((f) => /\.pdf$/i.test(f ?? '')) ?? zip;
    if (!filename) {
        return { ok: false, reason: 'no_source', origin: 'mutopia', filename: `${piece.piece}.pdf` };
    }
    // Guitar / tab transcriptions of keyboard works carry no `arranger` in the RDF
    // but name the instrument in the file (`…-guitar-let.pdf`). The instrument
    // field alone is not a signal: BWV 999 is a lute piece and stays.
    if (/guitar|[-_]tab[-_.]|ukulele/i.test(filename)) {
        return { ok: false, reason: 'arrangement_only', origin: 'mutopia', filename };
    }
    if (!verdict.accept) {
        return { ok: false, reason: verdict.reason, origin: 'mutopia', filename };
    }
    const credit = [rdf.maintainer, rdf.source ? `after ${rdf.source}` : null].filter(Boolean).join(', ');
    return {
        ok: true,
        origin: 'mutopia',
        workTitle: work.title,
        filename,
        pdfUrl: filename === zip ? null : `${base}${filename}`,
        zipUrl: filename === zip ? `${base}${zip}` : null,
        candidateUrl: rdf.midFile ? `${base}${rdf.midFile}` : null,
        sourceUrl: mutopiaPieceInfoUrl(rdf.id, piece.dir),
        licenceTag: verdict.tag,
        usPd: verdict.usPd,
        editorCredit: credit ? `${credit} (Mutopia)` : 'Mutopia Project',
        pianoSolo: isPianoSolo(rdf.instrument),
        pieceTitle: rdf.title,
    };
};

/**
 * One resolution per PDF inside a Mutopia `*-pdfs.zip`: the ledger row is the
 * entry name, the bytes come from `zipUrl` + `zipEntry`. Non-PDF entries and
 * macOS resource forks are ignored.
 */
export const expandZipResolution = (res, entryNames) =>
    entryNames
        .filter(
            (name) =>
                /\.pdf$/i.test(name) &&
                !/(^|\/)(__MACOSX|\.)/.test(name) &&
                !IA_PART_OR_ARRANGEMENT_RE.test(
                    name
                        .split('/')
                        .pop()
                        .replace(/\.pdf$/i, ''),
                ),
        )
        .sort()
        .map((name) => ({
            ...res,
            filename: name.split('/').pop(),
            zipEntry: name,
            pdfUrl: null,
        }));

// ---------------------------------------------------------------------------
// Minimal ZIP reader (central directory + deflate), enough for Mutopia's zips
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** @returns {Array<{ name: string, method: number, compressedSize: number, size: number, offset: number }>} */
export const zipEntries = (buf) => {
    const maxBack = Math.min(buf.length - 22, 0xffff + 22);
    let eocd = -1;
    for (let i = buf.length - 22; i >= buf.length - 22 - maxBack && i >= 0; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error('zip: no end-of-central-directory record');
    }
    const count = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(pos) !== CEN_SIG) {
            throw new Error('zip: bad central directory entry');
        }
        const method = buf.readUInt16LE(pos + 10);
        const compressedSize = buf.readUInt32LE(pos + 20);
        const size = buf.readUInt32LE(pos + 24);
        const nameLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        const offset = buf.readUInt32LE(pos + 42);
        const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
        entries.push({ name, method, compressedSize, size, offset });
        pos += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
};

/** Raw (still compressed) bytes and method for one entry, from its local header. */
export const zipEntrySlice = (buf, entry) => {
    if (buf.readUInt32LE(entry.offset) !== LOC_SIG) {
        throw new Error(`zip: bad local header for ${entry.name}`);
    }
    const nameLen = buf.readUInt16LE(entry.offset + 26);
    const extraLen = buf.readUInt16LE(entry.offset + 28);
    const start = entry.offset + 30 + nameLen + extraLen;
    return { method: entry.method, data: buf.subarray(start, start + entry.compressedSize) };
};

/** Decompressed bytes of one entry (stored or deflate). */
export const zipExtract = (buf, entry) => {
    const { method, data } = zipEntrySlice(buf, entry);
    if (method === 0) {
        return Buffer.from(data);
    }
    if (method === 8) {
        return inflateRawSync(data);
    }
    throw new Error(`zip: unsupported compression method ${method} for ${entry.name}`);
};

// ---------------------------------------------------------------------------
// OpenScore (CC0) — Lieder ships mscz/mxl only; String Quartets ship PDFs too
// ---------------------------------------------------------------------------

/**
 * Work folders from an OpenScore repo tree: `scores/<Composer,_Name>/<Work>/…`.
 * @returns {Array<{ dir: string, composerFolder: string, workFolder: string, files: string[] }>}
 */
export const openscoreWorksFromTree = (paths) => {
    const byDir = new Map();
    for (const path of paths) {
        const parts = path.split('/');
        if (parts[0] !== 'scores' || parts.length < 4) {
            continue;
        }
        const dir = parts.slice(0, 3).join('/');
        const entry = byDir.get(dir) ?? { dir, composerFolder: parts[1], workFolder: parts[2], files: [] };
        entry.files.push(path);
        byDir.set(dir, entry);
    }
    return [...byDir.values()];
};

export const openscoreWorkMatches = (work, entry) => {
    const composer = composerNameOf(work.title);
    if (!composer || !composerMatchesFolder(composer, entry.composerFolder)) {
        return false;
    }
    const folderTitle = entry.workFolder.replace(/_/g, ' ');
    if (fold(folderTitle) === fold(workTitleOf(work.title))) {
        return true;
    }
    const wantRefs = catalogRefsFromText(workTitleOf(work.title));
    if (wantRefs.length > 0) {
        return catalogEquals(wantRefs, catalogRefsFromText(folderTitle));
    }
    return titleWordsMatch(work.title, folderTitle);
};

/** The full-score PDF (`sq123.pdf`, never a `-Part-`), else null. */
export const openscoreScorePdf = (entry) =>
    entry.files.find((f) => /\.pdf$/i.test(f) && !/-Part-/i.test(f) && !/_text\.pdf$/i.test(f)) ?? null;

export const openscoreResolution = (work, entry, repo, { renderer = false } = {}) => {
    const pdf = openscoreScorePdf(entry);
    const mxl = entry.files.find((f) => /\.mxl$/i.test(f)) ?? null;
    const mscz = entry.files.find((f) => /\.mscz$/i.test(f)) ?? null;
    if (!pdf && !(renderer && mscz)) {
        return { ok: false, reason: 'no_renderer', origin: 'openscore', filename: `${entry.workFolder}.pdf` };
    }
    const filename = pdf
        ? pdf.split('/').pop()
        : `${mscz
              .split('/')
              .pop()
              .replace(/\.mscz$/i, '')}.pdf`;
    return {
        ok: true,
        origin: 'openscore',
        workTitle: work.title,
        filename,
        pdfUrl: pdf ? `${repo.rawBase}${pdf}` : null,
        renderFrom: pdf ? null : `${repo.rawBase}${mscz}`,
        candidateUrl: mxl ? `${repo.rawBase}${mxl}` : null,
        sourceUrl: `${repo.htmlBase}${entry.dir}`,
        licenceTag: 'CC0',
        usPd: true,
        editorCredit: repo.credit,
        pianoSolo: false,
        pieceTitle: entry.workFolder.replace(/_/g, ' '),
    };
};

// ---------------------------------------------------------------------------
// Internet Archive `imslp` collection
// ---------------------------------------------------------------------------

/** IA items carry `external-identifier: urn:imslp_record_id:<base64(page title)>`. */
export const iaRecordId = (title) => `urn:imslp_record_id:${Buffer.from(title, 'utf8').toString('base64')}`;

export const iaExactQuery = (title) => `collection:imslp AND external-identifier:"${iaRecordId(title)}"`;

/** Catalog token for the fallback search (`Op.27 No.2`, `WoO 59`, `BWV 846`). */
export const iaCatalogToken = (title) => {
    const ref = catalogRefsFromText(workTitleOf(title))[0];
    if (!ref) {
        return null;
    }
    if (ref.type.startsWith('Hob.')) {
        return `${ref.type}:${ref.n}`;
    }
    switch (ref.type) {
        case 'Op':
            return ref.no !== undefined ? `Op.${ref.n} No.${ref.no}` : `Op.${ref.n}`;
        case 'Anh':
            return `BWV Anh.${ref.n}`;
        case 'BWV':
        case 'HWV':
        case 'RV':
        case 'TWV':
        case 'WoO':
        case 'CD':
            return `${ref.type} ${ref.n}`;
        case 'K':
        case 'D':
        case 'S':
        case 'M':
        case 'L':
        case 'P':
            return `${ref.type}.${ref.n}`;
        default:
            return null;
    }
};

/** Title with every catalog reference and all punctuation removed, folded. */
export const titleCore = (title) => {
    let text = workTitleOf(title)
        .normalize('NFKD')
        .replace(/[\u2010-\u2015\u2212]/g, '-');
    for (const { re } of REF_PATTERNS) {
        re.lastIndex = 0;
        text = text.replace(re, ' ');
    }
    return fold(text)
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
};

/**
 * Fallback searches for a work the record id did not find (IA mirrored IMSLP
 * in 2012 under the page titles of the time): the catalog token, then the
 * title phrase. Both are accepted only through `pickIaDoc`.
 */
export const iaFallbackQueries = (title) => {
    const composer = composerNameOf(title);
    if (!composer) {
        return [];
    }
    const out = [];
    const token = iaCatalogToken(title);
    if (token) {
        out.push(`collection:imslp AND creator:"${composer}" AND title:"${token}"`);
    }
    const core = titleCore(title);
    if (core.length >= 6) {
        out.push(`collection:imslp AND creator:"${composer}" AND title:"${core}"`);
    }
    return out;
};

export const iaSearchUrl = (query, rows = 10) => {
    const url = new URL(IA_SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.append('fl[]', 'identifier');
    url.searchParams.append('fl[]', 'title');
    url.searchParams.append('fl[]', 'creator');
    url.searchParams.append('fl[]', 'date');
    url.searchParams.set('rows', String(rows));
    url.searchParams.set('output', 'json');
    return url.toString();
};

/**
 * Pick the IA document that is this work: title equality (sans composer), or
 * exact catalog agreement with a creator match. Anything looser is a wrong
 * edition, which is worse than a miss.
 */
export const pickIaDoc = (title, docs) => {
    const want = fold(workTitleOf(title));
    const wantRefs = catalogRefsFromText(workTitleOf(title));
    const composer = fold(composerNameOf(title) ?? '');
    const sameCreator = (doc) => {
        const creator = Array.isArray(doc.creator) ? doc.creator.join(' ') : doc.creator;
        return fold(creator) === composer;
    };
    for (const doc of docs ?? []) {
        if (fold(doc.title) === want) {
            return doc;
        }
    }
    for (const doc of docs ?? []) {
        if (!sameCreator(doc)) {
            continue;
        }
        const haveRefs = catalogRefsFromText(doc.title);
        if (wantRefs.length > 0 && catalogEquals(wantRefs, haveRefs)) {
            return doc;
        }
        // Same words, and neither side names a catalog number the other contradicts.
        if (
            titleCore(title) === titleCore(doc.title) &&
            (wantRefs.length === 0 || haveRefs.length === 0 || catalogEquals(wantRefs, haveRefs))
        ) {
            return doc;
        }
    }
    return null;
};

/** File names that are a single part or another scoring, not the work's score. */
export const IA_PART_OR_ARRANGEMENT_RE =
    /(?:^|[-_ .(])(?:parts?|pf ?4h|4 ?hands|four ?hands|arr|arrangement|transc\w*|duet|vn ?\d|vl ?\d|violin[oi]?|viola|cello|violoncello|contrabass[oi]?|clarinet[ti]?|clarinetti|oboe|oboi|flute|flauti|flauto|fagott[oi]|bassoon|horn|corni|corno|trumpet|tromba|trombe|trombone|timpani|tuba|bass|continuo|soprano|alto|tenor|quartet|kwartet|overture|ouverture)[a-z]?\d*(?:$|[-_ .)])/i;

/**
 * The original PDF of an IA item (not the `_text.pdf` OCR derivative), skipping
 * files named as a part or an arrangement. Null when only those remain.
 */
export const pickIaPdf = (files, editions = []) => {
    const pdfs = (files ?? []).filter((f) => /\.pdf$/i.test(f.name ?? '') && !/_text\.pdf$/i.test(f.name));
    const scores = pdfs.filter((f) => !IA_PART_OR_ARRANGEMENT_RE.test(f.name.replace(/\.pdf$/i, '')));
    const originals = scores.filter((f) => f.source === 'original');
    const pool = originals.length > 0 ? originals : scores;
    // Best IMSLP edition first (typeset > scan, complete, rating, downloads); unmatched
    // files rank below every matched one; size breaks the remaining ties.
    const editionScoreOf = (f) => matchImslpEdition(f.name, editions)?.score ?? -1000;
    pool.sort((a, b) => editionScoreOf(b) - editionScoreOf(a) || Number(b.size ?? 0) - Number(a.size ?? 0));
    return pool[0] ?? null;
};

export const iaFileUrl = (identifier, name) =>
    `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(name)}`;

export const iaResolution = (work, item, file, licences) => {
    const filename = file.name;
    const year = publicationYearOf(item.metadata?.date);
    const bound = imslpFileLicenceFor(filename, licences);
    const licence = bound ?? workLevelLicence(licences);
    if (!licence) {
        return { ok: false, reason: 'no_licence', origin: 'ia', filename };
    }
    const verdict = licenceVerdict({
        label: licence.licenseLabel,
        restriction: licence.restriction,
        euHosted: licence.euHosted,
        // An unbound scan must clear US-PD on its own publication year.
        year: bound ? year : (year ?? US_PD_BEFORE_YEAR),
    });
    if (!verdict.accept) {
        return { ok: false, reason: verdict.reason, origin: 'ia', filename };
    }
    const size = Number(file.size ?? 0);
    if (size > MAX_PDF_BYTES) {
        return { ok: false, reason: 'too_large', origin: 'ia', filename };
    }
    return {
        ok: true,
        origin: 'ia',
        workTitle: work.title,
        filename,
        pdfUrl: iaFileUrl(item.metadata.identifier, filename),
        candidateUrl: null,
        sourceUrl: `https://archive.org/details/${item.metadata.identifier}`,
        licenceTag: verdict.tag,
        usPd: verdict.usPd,
        editorCredit: null,
        pianoSolo: (item.metadata?.subject ?? []).includes('For piano'),
        pieceTitle: item.metadata?.title ?? '',
        byteLength: size || null,
    };
};

export const imslpWorkPageUrl = (title) =>
    `https://imslp.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`;

/** Same ImagefromIndex URL the live `tryDownloadPdf` hits. */
export const imslpImagefromIndexUrl = (filename) =>
    `https://imslp.org/wiki/Special:ImagefromIndex/${encodeURIComponent(filename)}`;

/**
 * Best complete non-arrangement IMSLP edition of a work, licence-filtered.
 * The CLI downloads it via wait-page → CDN parse (no 15s sleep). One file.
 *
 * @param {{ title: string }} work
 * @param {Array<object> | null | undefined} editions  `imslpEditions(...)`
 * @param {Map<string, { licenseLabel: string | null, restriction: string | null, euHosted: boolean }> | null | undefined} licences
 */
export const imslpResolution = (work, editions, licences) => {
    const best = bestImslpEdition(editions ?? []);
    if (!best?.filename) {
        return { ok: false, reason: 'no_source', origin: 'imslp', filename: '-', workTitle: work.title };
    }
    const filename = best.filename;
    if ((best.pages && best.pages > MAX_PAGES) || (best.sizeMb && best.sizeMb * 1024 * 1024 > MAX_PDF_BYTES)) {
        return { ok: false, reason: 'too_large', origin: 'imslp', filename, workTitle: work.title };
    }
    const bound = imslpFileLicenceFor(filename, licences);
    const licence = bound ?? workLevelLicence(licences);
    if (!licence) {
        return { ok: false, reason: 'no_licence', origin: 'imslp', filename, workTitle: work.title };
    }
    const year = publicationYearOf(best.publisher) ?? publicationYearOf(best.copyright) ?? publicationYearOf(best.misc);
    const verdict = licenceVerdict({
        label: licence.licenseLabel,
        restriction: licence.restriction,
        euHosted: licence.euHosted,
        year: bound ? year : (year ?? US_PD_BEFORE_YEAR),
    });
    if (!verdict.accept) {
        return { ok: false, reason: verdict.reason, origin: 'imslp', filename, workTitle: work.title };
    }
    const editor = best.editor ? cleanWikitext(best.editor) || null : null;
    return {
        ok: true,
        origin: 'imslp',
        workTitle: work.title,
        filename,
        pdfUrl: null,
        imslpFile: true,
        candidateUrl: null,
        sourceUrl: imslpWorkPageUrl(work.title),
        licenceTag: verdict.tag,
        usPd: verdict.usPd,
        editorCredit: editor ? `${editor} (IMSLP)` : 'IMSLP',
        pianoSolo: true,
        pieceTitle: work.title,
        byteLength: best.sizeMb ? Math.round(best.sizeMb * 1024 * 1024) : null,
    };
};

/**
 * IMSLP's own nginx "site ripping ban script" (HTTP 403 HTML on ImagefromIndex).
 * Distinct from the wait page, a PDF, and the MTCaptcha / friendlytest wall.
 * Seed-only: live `tryDownloadPdf` / `classifyDownloadBody` do not use this.
 */
export const IMSLP_RIPPING_BAN_MARKERS = Object.freeze([
    'site ripping ban',
    'ripping ban script',
    'site ripping is forbidden',
    'every reload refreshes the ban',
]);

const utf8Body = (body) => {
    if (body == null) {
        return '';
    }
    if (typeof body === 'string') {
        return body;
    }
    return Buffer.from(body).toString('utf8');
};

/**
 * True for an ImagefromIndex (or CDN) response that is IMSLP's ripping ban.
 * HTTP 403 is enough — further GETs refresh the ban length. The known ban
 * HTML is also enough, even on 200, so a status-blind body still trips.
 *
 * @param {{ status?: number | null, body?: string | Uint8Array | null }} [input]
 */
export const isImslpRippingBan = ({ status = null, body = '' } = {}) => {
    if (status === 403) {
        return true;
    }
    const lower = utf8Body(body).toLowerCase();
    return IMSLP_RIPPING_BAN_MARKERS.some((marker) => lower.includes(marker));
};

/**
 * Seed-only classifier for one IMSLP file GET. 403 / ripping-ban HTML is a
 * circuit-break (`ripping_ban`); otherwise the same wait-page → CDN step as
 * live `tryDownloadPdf`. Not used by the Edge download.
 *
 * @param {number | null | undefined} status
 * @param {Uint8Array} bytes
 * @returns {{ action: 'accept' } | { action: 'cdn', url: string } | { action: 'circuit', code: 'bot_check' | 'ripping_ban' } | { action: 'fail', code: string }}
 */
export const classifyImslpResponse = (status, bytes) => {
    if (isImslpRippingBan({ status, body: bytes })) {
        return { action: 'circuit', code: 'ripping_ban' };
    }
    return nextImslpDownloadStep(bytes);
};

/**
 * Decide what to do with an ImagefromIndex response. Same order as live
 * `tryDownloadPdf`: accept a PDF immediately; treat ripping-ban HTML and
 * bot-check / MTCaptcha as a circuit-breaker; otherwise parse
 * `#sm_dl_wait[data-id]` for the CDN URL. Wait-page HTML is not classified
 * as `bot_check` (that helper treats all HTML as a bot wall, which would
 * skip the CDN parse). HTTP 403 is handled by `classifyImslpResponse`.
 *
 * @param {Uint8Array} bytes
 * @returns {{ action: 'accept' } | { action: 'cdn', url: string } | { action: 'circuit', code: 'bot_check' | 'ripping_ban' } | { action: 'fail', code: string }}
 */
export const nextImslpDownloadStep = (bytes) => {
    if (bytes.length > MAX_PDF_BYTES) {
        return { action: 'fail', code: 'too_large' };
    }
    if (looksLikePdf(bytes)) {
        return { action: 'accept' };
    }
    const html = Buffer.from(bytes).toString('utf8');
    const lower = html.toLowerCase();
    if (isImslpRippingBan({ body: lower })) {
        return { action: 'circuit', code: 'ripping_ban' };
    }
    // A friendlyredirect / MTCaptcha wall never carries the wait span; check that first so a
    // genuine wait page (~19 kB of chrome before `sm_dl_wait`) is never mistaken for a wall.
    if (
        !lower.includes('sm_dl_wait') &&
        (lower.includes('bot check') || lower.includes('mtcaptcha') || lower.includes('friendlytest'))
    ) {
        return { action: 'circuit', code: 'bot_check' };
    }
    const cdnUrl = extractCdnUrlFromWaitPage(html);
    if (cdnUrl) {
        return { action: 'cdn', url: cdnUrl };
    }
    if (lower.includes('disclaimer') || lower.includes('imslpdisclaimer')) {
        return { action: 'fail', code: 'disclaimer' };
    }
    return { action: 'fail', code: 'not_pdf' };
};

/**
 * Honour `Retry-After` in full (seconds or HTTP date). IMSLP asking for a long
 * pause is exactly the signal to obey; only a missing/garbled header falls back.
 */
export const retryAfterMs = (header, { fallbackMs = 30_000, now = Date.now(), floorMs = 500 } = {}) => {
    if (!header) {
        return fallbackMs;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.max(floorMs, Math.round(seconds * 1000));
    }
    const at = Date.parse(header);
    return Number.isFinite(at) ? Math.max(floorMs, at - now) : fallbackMs;
};

/** Back off after a bot check / captcha / disclaimer wall: 15 min, 1 h, 6 h; the next one pauses the source. */
export const IMSLP_BACKOFF_MS = Object.freeze([15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]);
export const IMSLP_PAUSE_AFTER = 3;
/** How long an auto-pause recorded in playalong_corpus_control lasts. */
export const IMSLP_AUTO_PAUSE_MS = 24 * 60 * 60_000;

/**
 * Circuit breaker for the IMSLP source. Pure state: `now` is injected so the
 * schedule can be tested without a clock. A block backs the source off for
 * IMSLP_BACKOFF_MS[n-1]; the IMSLP_PAUSE_AFTER-th consecutive block pauses it
 * for IMSLP_AUTO_PAUSE_MS (the CLI writes that to playalong_corpus_control).
 * `ripping_ban` skips the ladder and pauses for 24h on the first hit — further
 * ImagefromIndex GETs refresh IMSLP's ban. Any successful download resets the
 * streak. Never a tight loop: while parked, `available()` is false and the
 * caller must not hit the network. Mutopia / OpenScore / IA are not this
 * breaker; they keep running.
 */
export const createImslpBreaker = ({
    now = Date.now,
    backoffMs = IMSLP_BACKOFF_MS,
    pauseAfter = IMSLP_PAUSE_AFTER,
    pauseMs = IMSLP_AUTO_PAUSE_MS,
} = {}) => {
    const state = { consecutiveBlocks: 0, parkedUntil: null, paused: false, pauseReason: null };
    return {
        state,
        available: () => !state.paused && (state.parkedUntil === null || state.parkedUntil <= now()),
        recordSuccess: () => {
            state.consecutiveBlocks = 0;
            state.parkedUntil = null;
        },
        /** @returns {{ paused: boolean, parkedUntil: number, delayMs: number, reason: string }} */
        recordBlock: (code, detail = '') => {
            state.consecutiveBlocks += 1;
            const n = state.consecutiveBlocks;
            const immediatePause = code === 'ripping_ban';
            if (immediatePause || n >= pauseAfter) {
                state.paused = true;
                state.pauseReason = immediatePause
                    ? `${code}${detail ? `: ${detail}` : ''}`
                    : `${code} x${n}${detail ? `: ${detail}` : ''}`;
                state.parkedUntil = now() + pauseMs;
                return { paused: true, parkedUntil: state.parkedUntil, delayMs: pauseMs, reason: state.pauseReason };
            }
            const delayMs = backoffMs[Math.min(n, backoffMs.length) - 1];
            state.parkedUntil = now() + delayMs;
            return { paused: false, parkedUntil: state.parkedUntil, delayMs, reason: `${code} (${n}/${pauseAfter})` };
        },
        /** Resume from a pause recorded by an earlier run. */
        pauseUntil: (untilMs, reason) => {
            state.paused = true;
            state.parkedUntil = untilMs;
            state.pauseReason = reason ?? 'paused';
        },
    };
};

/** Crawler identity for imslp.org file fetches; `contactUnset` should be shouted, not tolerated. */
export const DEFAULT_IMSLP_CRAWLER_USER_AGENT = 'Cleffy-corpus/1.0 (+https://cleffy.app; contact: unset)';
export const crawlerUserAgent = (env = process.env) => {
    const value = (env.IMSLP_CRAWLER_USER_AGENT ?? '').trim() || DEFAULT_IMSLP_CRAWLER_USER_AGENT;
    const contactUnset = /contact:?\s*<?unset>?/i.test(value) || !/[\w.+-]+@[\w-]+\.[\w.-]+/.test(value);
    return { value, contactUnset };
};

// ---------------------------------------------------------------------------
// IMSLP metadata (identity + licence tags + opt-in file fetch)
// ---------------------------------------------------------------------------

/** `action=parse` for the rendered work page — the one place per-file tags live. */
export const imslpParseUrl = (title) => {
    const url = new URL(IMSLP_API);
    url.searchParams.set('action', 'parse');
    url.searchParams.set('page', title);
    url.searchParams.set('prop', 'text|wikitext');
    url.searchParams.set('redirects', '1');
    url.searchParams.set('format', 'json');
    return url.toString();
};

/**
 * Pages that redirect to this work page — IMSLP's former titles for it. IA
 * mirrored IMSLP in 2012 under those, so each alias is another exact record id.
 */
export const imslpRedirectsUrl = (title) => {
    const url = new URL(IMSLP_API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'backlinks');
    url.searchParams.set('bltitle', title);
    url.searchParams.set('blfilterredir', 'redirects');
    url.searchParams.set('bllimit', '50');
    url.searchParams.set('format', 'json');
    return url.toString();
};

/** Former titles from a backlinks response, same-composer only (no arrangements by others). */
export const imslpRedirectAliases = (title, response) => {
    const composer = fold(composerSurnameOf(title) ?? '');
    const out = [];
    for (const link of response?.query?.backlinks ?? []) {
        const alias = link?.title;
        if (typeof alias !== 'string' || alias === title || link.ns !== 0) {
            continue;
        }
        if (composer !== '' && fold(composerSurnameOf(alias) ?? '') !== composer) {
            continue;
        }
        out.push(alias);
    }
    return out;
};

// ---------------------------------------------------------------------------
// Wikipedia pageviews (demand proxy) — metadata only, cached by the CLI
// ---------------------------------------------------------------------------

export const WIKI_API = 'https://en.wikipedia.org/w/api.php';
export const WIKI_PAGEVIEWS_API =
    'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user';
/** Polite spacing for uncached Wikipedia / Wikimedia calls (the search API throttles at ~10/s). */
export const WIKI_DELAY_MS = 400;

/** `Beethoven, Ludwig van` → `Ludwig van Beethoven`; `Strauss Jr., Johann` → `Johann Strauss Jr.`. */
export const composerArticleName = (title) => {
    const name = composerNameOf(title);
    if (!name) {
        return null;
    }
    const [last, first] = name.split(',').map((p) => p.trim());
    return first ? `${first} ${last}` : last;
};

/** Search text: the title without catalogue numbers (they derail Wikipedia's search) plus the surname. */
export const wikiSearchQuery = (title) => {
    let text = workTitleOf(title)
        .normalize('NFKD')
        .replace(/[\u2010-\u2015\u2212]/g, '-');
    for (const { re } of REF_PATTERNS) {
        re.lastIndex = 0;
        text = text.replace(re, ' ');
    }
    text = text
        .replace(/\([^()]*\)/g, ' ')
        .replace(/\b\d+[a-z]\b/g, ' ')
        .replace(/[,;:/]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return `${text} ${composerSurnameOf(title) ?? ''}`.trim();
};

export const wikiSearchUrl = (query) => {
    const url = new URL(WIKI_API);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srlimit', '3');
    url.searchParams.set('format', 'json');
    return url.toString();
};

/** Last 12 complete months, as the pageviews API wants them (YYYYMMDD00). */
export const pageviewsWindow = (now = new Date()) => {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 12, 1));
    const stamp = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}0100`;
    return { start: stamp(start), end: stamp(end) };
};

export const wikiPageviewsUrl = (article, { start, end } = pageviewsWindow()) =>
    `${WIKI_PAGEVIEWS_API}/${encodeURIComponent(article.replace(/ /g, '_'))}/monthly/${start}/${end}`;

/** Average monthly views from a pageviews response; 0 when the article has none. */
export const monthlyAverageViews = (response) => {
    const items = response?.items ?? [];
    if (items.length === 0) {
        return 0;
    }
    return Math.round(items.reduce((sum, item) => sum + Number(item.views ?? 0), 0) / items.length);
};

const wordCovered = (word, have) => {
    if (have.has(word)) {
        return true;
    }
    for (const h of have) {
        if (word.length >= 5 && h.length >= 5 && (h.startsWith(word) || word.startsWith(h))) {
            return true;
        }
    }
    return false;
};

const numberOf = (text) => {
    const match = /\bNos?\.?\s*(\d+)/i.exec(text);
    return match ? Number(match[1]) : null;
};

/** Parenthetical qualifiers that mark a non-musical namesake. */
const NON_MUSIC_QUALIFIER_RE =
    /\b(film|movie|poem|novel|book|band|play|painting|sculpture|series|game|album|single|song|tv|television|video|character|comics|company|ship|horse|disambiguation|\d{4})\b/;

/** Parenthetical qualifiers Wikipedia uses that are not a composer's name. */
const ARTICLE_QUALIFIERS = new Set([
    'opera',
    'ballet',
    'oratorio',
    'cantata',
    'song',
    'album',
    'film',
    'band',
    'play',
    'novel',
    'poem',
    'hymn',
    'anthem',
    'music',
    'composition',
    'piece',
    'disambiguation',
    'symphony',
    'suite',
    'concerto',
    'sonata',
    'overture',
]);

/** Genre words (stemmed like significantWords): a sonata article is not a concerto's. */
const GENRE_WORDS = new Set(
    [
        'sonata',
        'sonatina',
        'concerto',
        'symphony',
        'quartet',
        'quintet',
        'trio',
        'nocturne',
        'prelude',
        'fugue',
        'etude',
        'waltz',
        'mazurka',
        'polonaise',
        'ballade',
        'scherzo',
        'impromptu',
        'rhapsody',
        'variations',
        'suite',
        'mass',
        'requiem',
        'overture',
        'fantasia',
        'fantaisie',
        'toccata',
        'partita',
        'serenade',
        'cantata',
        'oratorio',
        'opera',
        'lieder',
        'invention',
        'bagatelle',
        'intermezzo',
        'romance',
        'march',
        'minuet',
        'gigue',
        'sarabande',
        'rondo',
    ].map(stem),
);

const genresOf = (words) => words.filter((w) => GENRE_WORDS.has(w));

/**
 * Is this search hit the work's article? Never the composer's own article, a
 * "List of …" page or a bare genre article ("Fugue"). Then: an exact catalogue
 * reference wins; a differing `No. N` or a differing genre word loses; an
 * article naming the composer needs one shared title word (the surname does
 * not count); an article that does not name the composer must cover every
 * title word and be mostly about them ("Für Elise", "Goldberg Variations" —
 * not the anthem behind a variation set, not BWV 565 for another toccata).
 */
export const wikiArticleMatches = (workTitle, articleTitle) => {
    const article = fold(articleTitle);
    if (/^list of\b/.test(article)) {
        return false;
    }
    const composer = composerArticleName(workTitle);
    if (composer && article === fold(composer)) {
        return false;
    }
    const surname = fold(composerSurnameOf(workTitle) ?? '');
    if (surname && article === surname) {
        return false;
    }
    // A bare genre page ("Fugue", "Nocturne") is about the form, not a work.
    if (GENRE_WORDS.has(stem(article.replace(/[^a-z]/g, '')))) {
        return false;
    }
    const articleWords = significantWords(`${articleTitle} (x)`).filter((w) => w !== stem(surname));
    // "Clair de lune (poem)" / "The Magic Flute (2022 film)" are not the music.
    const qualifier = /\(([^()]+)\)\s*$/.exec(articleTitle)?.[1]?.trim() ?? '';
    if (qualifier && NON_MUSIC_QUALIFIER_RE.test(fold(qualifier))) {
        return false;
    }
    // "Piano Sonata No. 2 (Chopin)" is not Beethoven's Op.2 No.2.
    if (qualifier && surname && !fold(qualifier).includes(surname)) {
        const qualifierWords = fold(qualifier).split(' ');
        const looksLikeName = /^[A-Z\u00C0-\u024F]/.test(qualifier) && qualifierWords.length <= 3;
        if (looksLikeName && !qualifierWords.some((w) => ARTICLE_QUALIFIERS.has(w) || GENRE_WORDS.has(stem(w)))) {
            return false;
        }
    }
    const wantRefs = catalogRefsFromText(workTitleOf(workTitle));
    if (wantRefs.length > 0 && catalogEquals(wantRefs, catalogRefsFromText(articleTitle))) {
        return true;
    }
    const wantNo = numberOf(workTitleOf(workTitle));
    const haveNo = numberOf(articleTitle);
    if (wantNo !== null && haveNo !== null && wantNo !== haveNo) {
        return false;
    }
    // `(ballet)` / `(suite)` qualifiers in the IMSLP title are not title words.
    const words = significantWords(`${workTitleOf(workTitle).replace(/\([^()]*\)/g, ' ')} (x)`).filter(
        (w) => w !== stem(surname),
    );
    if (words.length === 0) {
        return false;
    }
    const have = new Set(articleWords);
    const wantGenres = genresOf(words);
    const haveGenres = genresOf(articleWords);
    if (wantGenres.length > 0 && haveGenres.length > 0 && !wantGenres.some((g) => haveGenres.includes(g))) {
        return false;
    }
    // The article must be mostly about this work's words either way ("Cello
    // Concerto (Elgar)" is not the Concert Allegro).
    const want = new Set(words);
    const articleCovered = articleWords.filter((w) => wordCovered(w, want)).length;
    if (articleWords.length > 0 && articleCovered * 2 <= articleWords.length) {
        return false;
    }
    if (surname && article.includes(surname)) {
        return words.some((w) => wordCovered(w, have));
    }
    return words.every((w) => wordCovered(w, have));
};

/** Pick the article for a work from a search response, or null. */
export const wikiArticleFor = (workTitle, searchResponse) => {
    for (const hit of searchResponse?.query?.search ?? []) {
        if (typeof hit?.title === 'string' && wikiArticleMatches(workTitle, hit.title)) {
            return hit.title;
        }
    }
    return null;
};

// ---------------------------------------------------------------------------
// IMSLP edition signals (from one `action=parse&prop=text|wikitext` call)
// ---------------------------------------------------------------------------

/** @typedef {{ filename: string, description: string, imageType: string | null, editor: string | null, arranger: string | null, publisher: string | null, misc: string | null, copyright: string | null }} ImslpFileBlockEntry */

const wikitextField = (block, name) => {
    const match = new RegExp(`\\|\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=([^\\n]*)`, 'i').exec(block);
    return match ? match[1].trim() : null;
};

/** Every PDF named in the page's `#fte:imslpfile` blocks, with the block's edition fields. */
export const parseImslpFileBlocks = (wikitext) => {
    const out = [];
    const blocks = String(wikitext ?? '').split('{{#fte:imslpfile');
    for (const block of blocks.slice(1)) {
        const body = block.split('\n}}')[0] ?? block;
        const imageType = wikitextField(body, 'Image Type');
        const editor = wikitextField(body, 'Editor');
        const arranger = wikitextField(body, 'Arranger');
        const publisher = wikitextField(body, 'Publisher Information');
        const misc = wikitextField(body, 'Misc. Notes');
        const copyright = wikitextField(body, 'Copyright');
        for (const match of body.matchAll(/\|\s*File\s*Name\s*(\d+)\s*=\s*([^\n|]+)/gi)) {
            const filename = (match[2] ?? '').trim();
            if (!/\.pdf$/i.test(filename)) {
                continue;
            }
            const description = wikitextField(body, `File Description ${match[1]}`) ?? '';
            out.push({ filename, description, imageType, editor, arranger, publisher, misc, copyright });
        }
    }
    return out;
};

/** @typedef {{ filename: string, fileId: string | null, sizeMb: number | null, pages: number | null, rating: number | null, downloads: number | null, description: string, typesetLine: boolean | null }} ImslpFileStats */

/** Per-file stats from the rendered page: id, size, pages, rating, downloads, "typeset by" / "scanned by". */
export const parseImslpFileStats = (html) => {
    const out = new Map();
    const chunks = String(html ?? '').split('we_file_dlarrwrap');
    for (const chunk of chunks.slice(1)) {
        const file = /title="File:([^"]+)">#(\d+)<\/a>(?:\s*-\s*([\d.]+)\s*MB)?(?:,\s*(\d+)\s*pp)?/.exec(chunk);
        if (!file) {
            continue;
        }
        const filename = file[1]
            .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'");
        const description =
            /we_file_dlarrow">&#160;<\/span><\/span>([^<]*)<\/span><\/a>/.exec(chunk)?.[1]?.trim() ?? '';
        const rating = /current-rating-\d+'[^>]*>([\d.]+)\/10/.exec(chunk)?.[1];
        const downloads = /Total number of downloads:\s*([\d,]+)/.exec(chunk)?.[1];
        const typesetLine = /PDF typeset by/i.test(chunk) ? true : /PDF scanned by/i.test(chunk) ? false : null;
        out.set(filename, {
            filename,
            fileId: file[2] ?? null,
            sizeMb: file[3] ? Number(file[3]) : null,
            pages: file[4] ? Number(file[4]) : null,
            rating: rating ? Number(rating) : null,
            downloads: downloads ? Number(downloads.replace(/,/g, '')) : null,
            description,
            typesetLine,
        });
    }
    return out;
};

const COMPLETE_SCORE_RE = /complete score|full score|score \(complete\)|^score$/i;
const PARTIAL_SCORE_RE =
    /\bparts?\b|selections?|excerpt|extract|arrang|transcri|piano reduction|vocal score|movement|no\.\s*\d|nos?\.\s*\d/i;

/** @typedef {ImslpFileBlockEntry & Partial<ImslpFileStats> & { typeset: boolean | null, complete: boolean, score: number }} ImslpEdition */

/**
 * Edition quality, higher is better: typeset ≫ normal scan ≫ manuscript;
 * complete score required (parts / arrangements are pushed to the bottom);
 * then community rating, then log downloads, then a size tie-break (smaller
 * scans OMR faster). Matches the order in the research note.
 */
export const editionScore = (edition) => {
    let score = 0;
    if (edition.typeset === true) {
        score += 100;
    } else if (edition.imageType && /manuscript/i.test(edition.imageType)) {
        score += 0;
    } else {
        score += 30;
    }
    score += edition.complete ? 50 : -500;
    if (edition.arranger) {
        score -= 500;
    }
    if (edition.rating) {
        score += edition.rating * 10;
    }
    if (edition.downloads) {
        score += 10 * Math.log10(1 + edition.downloads);
    }
    if (edition.sizeMb) {
        score -= Math.min(10, edition.sizeMb / 5);
    }
    return Math.round(score * 10) / 10;
};

/** Merge wikitext blocks and rendered stats into scored editions (PDFs only). */
export const imslpEditions = (wikitext, html) => {
    const stats = parseImslpFileStats(html);
    const seen = new Set();
    const out = [];
    for (const entry of parseImslpFileBlocks(wikitext)) {
        const canonical = entry.filename.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
        if (seen.has(canonical)) {
            continue;
        }
        seen.add(canonical);
        const stat = stats.get(canonical) ?? stats.get(entry.filename) ?? null;
        const description = entry.description || stat?.description || '';
        const typeset = entry.imageType ? /typeset/i.test(entry.imageType) : (stat?.typesetLine ?? null);
        const complete = COMPLETE_SCORE_RE.test(description) && !PARTIAL_SCORE_RE.test(description);
        const edition = { ...entry, ...(stat ?? {}), filename: canonical, description, typeset, complete };
        out.push({ ...edition, score: editionScore(edition) });
    }
    return out.sort((a, b) => b.score - a.score);
};

/** The edition Max would pick by hand: best complete, non-arrangement score. */
export const bestImslpEdition = (editions) => editions.find((e) => e.complete && !e.arranger) ?? null;

/** `{{LinkEd|Carl|Mikuli|1819|1897}}<br>{{FE}} (German)` → `Carl Mikuli; First edition (German)`. */
export const cleanWikitext = (value) => {
    let text = String(value ?? '');
    // Innermost templates first so nested `{{P|…|{{HMB|…}}|…}}` collapses cleanly.
    for (let pass = 0; pass < 4 && /\{\{/.test(text); pass++) {
        text = text.replace(/\{\{([^{}]*)\}\}/g, (_, inner) => {
            const parts = inner.split('|').map((p) => p.trim());
            switch (parts[0]) {
                case 'LinkEd':
                    return `${parts[1] ?? ''} ${parts[2] ?? ''}`.trim();
                case 'FE':
                    return 'First edition';
                case 'P':
                    return parts[1] ?? '';
                default:
                    return '';
            }
        });
    }
    return text
        .replace(/<br\s*\/?>/gi, '; ')
        .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
        .replace(/\[\[([^\]]*)\]\]/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/\s*;\s*$/, '')
        .trim();
};

/** Compact, storable view of an IMSLP edition. */
export const editionSummary = (edition) =>
    edition
        ? {
              filename: edition.filename,
              fileId: edition.fileId ?? null,
              imageType:
                  edition.imageType ??
                  (edition.typeset === true ? 'Typeset' : edition.typeset === false ? 'Normal Scan' : null),
              description: edition.description,
              editor: edition.editor ? cleanWikitext(edition.editor) || null : null,
              rating: edition.rating ?? null,
              downloads: edition.downloads ?? null,
              pages: edition.pages ?? null,
              sizeMb: edition.sizeMb ?? null,
              score: edition.score,
          }
        : null;

/** The IMSLP edition a source file is a copy of (loose name match), or null. */
export const matchImslpEdition = (filename, editions) => {
    const key = looseFilenameKey(filename);
    if (key === '') {
        return null;
    }
    return editions.find((e) => looseFilenameKey(e.filename) === key) ?? null;
};

/**
 * What goes on the ledger / store row: the chosen file's own signals, the
 * IMSLP edition it corresponds to (if any), the best IMSLP edition, and
 * whether they agree. `matchesBest === false` flags a work for a manual
 * `--from-dir` later.
 */
export const editionSignals = (res, editions) => {
    const best = bestImslpEdition(editions ?? []);
    const matched = res ? matchImslpEdition(res.filename, editions ?? []) : null;
    const chosen = res
        ? {
              origin: res.origin,
              filename: res.filename,
              imageType:
                  res.origin === 'mutopia' || res.origin === 'openscore'
                      ? 'Typeset'
                      : (matched?.imageType ?? (matched?.typeset === true ? 'Typeset' : 'Normal Scan')),
              complete:
                  res.origin === 'ia' || res.origin === 'imslp'
                      ? (matched?.complete ?? true)
                      : !IA_PART_OR_ARRANGEMENT_RE.test(res.filename.replace(/\.pdf$/i, '')),
              rating: matched?.rating ?? null,
              downloads: matched?.downloads ?? null,
          }
        : null;
    // A Mutopia / OpenScore typeset is at least as good as any IMSLP scan; only
    // an IMSLP *typeset* best edition can beat it.
    const matchesBest =
        best === null
            ? null
            : matched
              ? matched.filename === best.filename
              : chosen !== null && chosen.imageType === 'Typeset' && best.typeset !== true;
    return {
        chosen,
        matchedImslp: editionSummary(matched),
        bestImslp: editionSummary(best),
        matchesBest,
        imslpEditions: (editions ?? []).length,
    };
};

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** @typedef {{ title: string, tier: number, prior: number, composer: string | null, instrument: string | null, pin?: boolean }} RankedWork */

/**
 * Composer surnames in demand order: first appearance in POPULAR_WORKS, then
 * the era table. Folded.
 */
export const canonicalComposerOrder = (popular, extraSurnames = CANONICAL_SURNAMES) => {
    const order = [];
    const seen = new Set();
    const push = (name) => {
        const key = fold(name);
        if (key !== '' && !seen.has(key)) {
            seen.add(key);
            order.push(key);
        }
    };
    for (const work of popular) {
        push(composerSurnameOf(work.title) ?? work.composer);
    }
    for (const name of extraSurnames) {
        push(name);
    }
    return order;
};

/**
 * Cold-start + demand ranking.
 *
 * Tier 0: POPULAR_WORKS in list order (prior N..1) then eval pins. Tier 1:
 * catalog works `For piano` by a canonical composer, POPULAR composer order,
 * then `touched desc`. Score: see RANK_WEIGHTS; a title with downloads that is
 * in neither set is inserted (tier 1). `popularity` maps title →
 * { workViews, composerViews } (Wikipedia monthly averages).
 *
 * @param {{ popular: Array<{ title: string, composer?: string, instrument?: string }>,
 *           pins?: Array<{ title: string }>,
 *           catalog?: Array<{ page_title: string, composer: string | null, categories: string[], touched: string | null }>,
 *           demand?: Map<string, number>, corpusUse?: Map<string, number> }} input
 * @returns {RankedWork[]}
 */
/**
 * Ranking weights. Score =
 *   RANK_WEIGHTS.download · in-app IMSLP imports of the title
 * + RANK_WEIGHTS.use      · playalong_corpus.use_count
 * + RANK_WEIGHTS.work     · log10(1 + monthly Wikipedia views of the work article)
 * + RANK_WEIGHTS.composer · log10(1 + monthly Wikipedia views of the composer article)
 * + RANK_WEIGHTS.prior    · POPULAR_WORKS prior (131..1 for the curated list, else 0)
 * Real in-app demand dominates; Wikipedia fame orders everything else; the
 * curated prior breaks ties inside a fame band.
 */
export const RANK_WEIGHTS = Object.freeze({ download: 1000, use: 100, work: 100, composer: 25, prior: 3 });

export const popularityScore = ({ workViews = 0, composerViews = 0 } = {}, weights = RANK_WEIGHTS) =>
    weights.work * Math.log10(1 + Math.max(0, workViews)) +
    weights.composer * Math.log10(1 + Math.max(0, composerViews));

export const rankWorks = ({
    popular,
    pins = [],
    catalog = [],
    demand = new Map(),
    corpusUse = new Map(),
    popularity = new Map(),
    weights = RANK_WEIGHTS,
}) => {
    const byTitle = new Map();
    const n = popular.length;
    popular.forEach((work, index) => {
        if (!byTitle.has(work.title)) {
            byTitle.set(work.title, {
                title: work.title,
                tier: 0,
                prior: n - index,
                composer: composerSurnameOf(work.title) ?? work.composer ?? null,
                instrument: work.instrument ?? null,
            });
        }
    });
    for (const pin of pins) {
        if (!byTitle.has(pin.title)) {
            byTitle.set(pin.title, {
                title: pin.title,
                tier: 0,
                prior: 0,
                composer: composerSurnameOf(pin.title),
                instrument: 'piano',
                pin: true,
            });
        }
    }

    const composerOrder = canonicalComposerOrder(popular);
    const composerRank = new Map(composerOrder.map((name, index) => [name, index]));
    const fill = [];
    for (const work of catalog) {
        if (byTitle.has(work.page_title) || !Array.isArray(work.categories) || !work.categories.includes('For piano')) {
            continue;
        }
        const surname = fold(composerSurnameOf(work.page_title) ?? (work.composer ?? '').split(',')[0]);
        const rank = composerRank.get(surname);
        if (rank === undefined) {
            continue;
        }
        fill.push({ work, rank, touched: work.touched ?? '' });
    }
    fill.sort((a, b) => a.rank - b.rank || (a.touched < b.touched ? 1 : a.touched > b.touched ? -1 : 0));
    for (const { work } of fill) {
        byTitle.set(work.page_title, {
            title: work.page_title,
            tier: 1,
            prior: 0,
            composer: composerSurnameOf(work.page_title),
            instrument: 'piano',
        });
    }

    for (const [title, downloads] of demand) {
        if (downloads > 0 && !byTitle.has(title)) {
            byTitle.set(title, { title, tier: 1, prior: 0, composer: composerSurnameOf(title), instrument: null });
        }
    }

    const ordered = [...byTitle.values()];
    const position = new Map(ordered.map((w, i) => [w.title, i]));
    const scoreOf = (w) =>
        weights.download * (demand.get(w.title) ?? 0) +
        weights.use * (corpusUse.get(w.title) ?? 0) +
        popularityScore(popularity.get(w.title), weights) +
        weights.prior * w.prior;
    ordered.sort((a, b) => scoreOf(b) - scoreOf(a) || position.get(a.title) - position.get(b.title));
    return ordered.map((w) => ({
        ...w,
        score: Math.round(scoreOf(w) * 10) / 10,
        downloads: demand.get(w.title) ?? 0,
        useCount: corpusUse.get(w.title) ?? 0,
        workViews: popularity.get(w.title)?.workViews ?? 0,
        composerViews: popularity.get(w.title)?.composerViews ?? 0,
    }));
};

/**
 * Demand from `documents.title` rows (IMSLP imports store the work page title;
 * uploads store a file name, which has no `(Last, First)` suffix). The corpus
 * owner's own documents are excluded by the caller's query.
 */
export const demandFromDocumentTitles = (titles) => {
    const counts = new Map();
    for (const title of titles) {
        if (typeof title !== 'string' || composerSurnameOf(title) === null) {
            continue;
        }
        counts.set(title, (counts.get(title) ?? 0) + 1);
    }
    return counts;
};

// ---------------------------------------------------------------------------
// Eval pins → Mutopia pieces
// ---------------------------------------------------------------------------

/** `https://www.mutopiaproject.org/ftp/BachJS/BWV772/bach-invention-01/x.mid` → piece dir. */
export const mutopiaPieceDirFromUrl = (url) => {
    try {
        const path = new URL(url).pathname;
        const parts = path.split('/').filter(Boolean);
        if (parts[0] !== 'ftp') {
            return null;
        }
        parts.pop();
        if (parts.length < 3) {
            return null;
        }
        return parts.join('/');
    } catch {
        return null;
    }
};

/**
 * Mutopia piece dirs referenced by the eval corpus (`pdf.url` or
 * `reference.url` on mutopiaproject.org). IMSLP URLs are ignored on purpose.
 */
export const evalPinPieceDirs = (pins) => {
    const dirs = new Set();
    for (const pin of pins) {
        for (const url of [pin?.pdf?.url, pin?.reference?.url]) {
            if (typeof url === 'string' && /mutopiaproject\.org\/ftp\//.test(url)) {
                const dir = mutopiaPieceDirFromUrl(url);
                if (dir) {
                    dirs.add(dir);
                }
            }
        }
    }
    return [...dirs].sort();
};

/**
 * Reverse resolution: which IMSLP work page is this Mutopia piece? POPULAR
 * titles by catalog refs first (BWV Anh.114 lives under Pezold there), then
 * catalog titles whose composer is the piece's composer.
 */
export const titleForMutopiaPiece = (piece, rdf, popular, catalogWorks = []) => {
    const haveRefs = expandCatalogRefs([
        ...catalogRefsFromText(rdf.opus),
        ...catalogRefsFromMutopiaDir(piece.catalogDir),
        ...catalogRefsFromText(piece.piece.replace(/[_-]/g, ' ')),
    ]);
    // Narrowest matching reference wins: `Prelude in C major, BWV 939` over
    // a `BWV 939-943` collection page.
    const exact = (candidates) => {
        let best = null;
        for (const title of candidates) {
            const wantRefs = catalogRefsFromText(workTitleOf(title));
            if (wantRefs.length === 0 || haveRefs.length === 0 || !catalogMatches(wantRefs, haveRefs)) {
                continue;
            }
            const span = Math.min(...wantRefs.map((r) => (r.nEnd ?? r.n) - r.n));
            if (best === null || span < best.span) {
                best = { title, span };
            }
        }
        return best?.title;
    };
    const popularByComposer = popular
        .map((w) => w.title)
        .filter((title) => composerMatchesMutopiaId(composerSurnameOf(title) ?? '', piece.composerId));
    const fromPopularComposer = exact(popularByComposer);
    if (fromPopularComposer) {
        return fromPopularComposer;
    }
    // Across composers only for Bach catalogue numbers, which are unique (the
    // BWV Anh. pieces IMSLP credits to Pezold); an `Op.68` belongs to many.
    if (haveRefs.every((r) => r.type === 'BWV' || r.type === 'Anh')) {
        const fromPopularAny = exact(popular.map((w) => w.title));
        if (fromPopularAny) {
            return fromPopularAny;
        }
    }
    const catalogByComposer = catalogWorks
        .filter((w) => composerMatchesMutopiaId(composerSurnameOf(w.page_title) ?? '', piece.composerId))
        .map((w) => w.page_title);
    const fromCatalog = exact(catalogByComposer);
    if (fromCatalog) {
        return fromCatalog;
    }
    const byWords =
        popularByComposer.find((title) => titleWordsMatch(title, `${rdf.title} ${rdf.moreInfo}`)) ??
        catalogByComposer.find((title) => titleWordsMatch(title, `${rdf.title} ${rdf.moreInfo}`));
    return byWords ?? null;
};

// ---------------------------------------------------------------------------
// Ledger state machine (`playalong_corpus_seed.status`)
// ---------------------------------------------------------------------------

export const LEDGER_TRANSITIONS = Object.freeze({
    pending: ['fetched', 'skipped', 'failed', 'paused'],
    paused: ['pending', 'fetched', 'skipped', 'failed'],
    fetched: ['queued', 'failed', 'skipped'],
    queued: ['ready', 'failed'],
    failed: ['pending', 'fetched', 'skipped', 'failed'],
    skipped: ['pending', 'fetched'],
    ready: [],
});

export const canTransition = (from, to) => (LEDGER_TRANSITIONS[from] ?? []).includes(to);

/**
 * Whether a rerun should touch this ledger row.
 * @returns {{ process: boolean, reason: string }}
 */
export const shouldProcess = (row, { retrySkipped = false } = {}) => {
    const attempts = Number(row.attempts ?? 0);
    switch (row.status) {
        case 'ready':
            return { process: false, reason: 'already_ready' };
        case 'queued':
            return { process: false, reason: 'in_flight' };
        case 'pending':
        case 'paused':
        case 'fetched':
            return { process: true, reason: 'resume' };
        case 'failed':
            return attempts < MAX_ATTEMPTS
                ? { process: true, reason: 'retry' }
                : { process: false, reason: 'attempts_exhausted' };
        case 'skipped':
            return retrySkipped ? { process: true, reason: 'retry_skipped' } : { process: false, reason: 'skipped' };
        default:
            return { process: false, reason: `unknown_status:${row.status}` };
    }
};

/**
 * Reconcile a `queued` row against the worker's outcome.
 * @returns {{ status: 'ready' | 'failed', error: string | null } | null}
 */
export const reconcileQueued = (job, analysis) => {
    if (analysis?.status === 'ready' || job?.status === 'succeeded') {
        return { status: 'ready', error: null };
    }
    if (job?.status === 'failed_permanent' || job?.status === 'dead') {
        return { status: 'failed', error: job.last_error ?? analysis?.error ?? 'omr_failed' };
    }
    if (analysis?.status === 'failed' && (!job || !['queued', 'running'].includes(job.status))) {
        return { status: 'failed', error: analysis.error ?? 'omr_failed' };
    }
    return null;
};

/**
 * Whether a source should be tried for this run. `--source` filters; the
 * per-origin backoff (consecutive upstream failures) parks a source.
 */
export const sourceEnabled = (origin, { sources = BULK_ORIGINS, parked = new Set() } = {}) =>
    sources.includes(origin) && !parked.has(origin);

export const parseSources = (value) => {
    if (!value || value === 'all') {
        return [...BULK_ORIGINS];
    }
    const wanted = String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    for (const w of wanted) {
        if (!ORIGIN_ORDER.includes(w)) {
            throw new Error(`--source must be one of ${ORIGIN_ORDER.join('|')}|all (got ${w})`);
        }
    }
    return ORIGIN_ORDER.filter((o) => wanted.includes(o));
};

/** Exponential per-source backoff (1s, 2s, 4s … capped) with a park threshold. */
export const backoffDelayMs = (consecutiveFailures, { baseMs = 1000, maxMs = 60_000 } = {}) =>
    Math.min(maxMs, baseMs * 2 ** Math.max(0, consecutiveFailures - 1));

export const PARK_AFTER_FAILURES = 5;

/** Ledger statuses that count as "this work already has an accepted file". */
export const COVERED_STATUSES = Object.freeze(['fetched', 'queued', 'ready']);

export const isWorkCovered = (rows) => [...(rows ?? [])].some((row) => COVERED_STATUSES.includes(row.status));

/** `--source imslp` (and only imslp): fill-in, never a second pipeline. */
export const isImslpOnlySources = (sources) =>
    Array.isArray(sources) && sources.length > 0 && sources.every((s) => s === 'imslp');

/**
 * Whether this run should resolve the work.
 *
 * Coverage is per work, any origin: one `fetched`/`queued`/`ready` row covers
 * it. IMSLP-only is fill-in — skip covered works even with `--retry-skipped`
 * so a Mutopia typeset is never displaced. Bulk sources may still retry extra
 * files on a covered work. A `skipped` row only blocks when its origin is one
 * of the sources in play, so an IMSLP pass reaches works the bulk mirrors
 * skipped without `--retry-skipped`.
 *
 * @param {Iterable<{ status: string, attempts?: number | string | null }>} rows
 * @param {{ retrySkipped?: boolean, sources?: readonly string[], fetchOnly?: boolean }} options
 */
export const shouldVisitWork = (rows, { retrySkipped = false, sources = BULK_ORIGINS, fetchOnly = false } = {}) => {
    const list = [...(rows ?? [])];
    const covered = isWorkCovered(list);
    if (covered && isImslpOnlySources(sources)) {
        return { visit: false, reason: 'already_covered' };
    }
    const retryable = list.filter((row) => {
        if (!shouldProcess(row, { retrySkipped }).process) {
            return false;
        }
        if (fetchOnly && row.status === 'fetched') {
            return false;
        }
        return true;
    });
    if (covered && retryable.length === 0) {
        return { visit: false, reason: 'already_covered' };
    }
    // A skip recorded by a source that is not in play now (or the `none` marker
    // of a run without this source) must not block a new source's pass.
    const blocking = list.filter((row) => row.status !== 'skipped' || sources.includes(row.origin));
    if (blocking.length > 0 && retryable.length === 0 && !covered) {
        return { visit: false, reason: 'not_retryable' };
    }
    return { visit: true, reason: covered ? 'retry_extra' : 'uncovered' };
};

// ---------------------------------------------------------------------------
// Dry-run planning + progress
// ---------------------------------------------------------------------------

/**
 * Choose the resolutions to act on for one work: first enabled origin with an
 * accepted file wins (Mutopia → OpenScore → IA → IMSLP); piano-solo Mutopia
 * pieces first; capped per work. IMSLP queues at most one file (the best
 * edition). Skips from every origin are kept for the ledger.
 *
 * @param {Array<object>} resolutions  mutopiaResolution / openscoreResolution / iaResolution outputs
 * @param {{ sources?: string[] }} options
 * @returns {{ queue: object[], skips: object[], origin: string | null }}
 */
export const planWork = (resolutions, { sources = BULK_ORIGINS } = {}) => {
    const skips = resolutions.filter((r) => !r.ok && sources.includes(r.origin));
    for (const origin of ORIGIN_ORDER) {
        if (!sources.includes(origin)) {
            continue;
        }
        const hits = resolutions.filter((r) => r.ok && r.origin === origin);
        if (hits.length === 0) {
            continue;
        }
        hits.sort((a, b) => Number(b.pianoSolo) - Number(a.pianoSolo) || a.filename.localeCompare(b.filename));
        const cap = origin === 'imslp' ? 1 : MAX_FILES_PER_WORK;
        return { queue: hits.slice(0, cap), skips, origin };
    }
    return { queue: [], skips, origin: null };
};

/** Coverage of a title set by winning origin (the dry-run summary). */
export const coverageByOrigin = (plans, titles) => {
    const out = { mutopia: 0, openscore: 0, ia: 0, imslp: 0, none: 0, total: 0 };
    for (const title of titles) {
        out.total += 1;
        const plan = plans.get(title);
        if (plan?.origin) {
            out[plan.origin] += 1;
        } else {
            out.none += 1;
        }
    }
    return out;
};

export const progressEvent = ({
    ready = 0,
    queued = 0,
    fetched = 0,
    skipped = 0,
    failed = 0,
    target = 0,
    batchId = null,
    ...extra
}) =>
    JSON.stringify({
        event: 'corpus_seed',
        ready,
        queued,
        fetched,
        skipped,
        failed,
        target,
        batch_id: batchId,
        ...extra,
    });

export const workEvent = ({ workTitle, status, origin = null, filename = null, pdfSha256 = null, reason = null }) =>
    JSON.stringify({ event: 'corpus_seed', workTitle, status, origin, filename, pdfSha256, reason });

/** Count distinct work titles at or past `queued` — what `--limit` floors. */
export const coveredWorkCount = (rows) => {
    const titles = new Set();
    for (const row of rows) {
        if (row.status === 'queued' || row.status === 'ready' || row.status === 'fetched') {
            titles.add(row.work_title);
        }
    }
    return titles.size;
};
