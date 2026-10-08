/**
 * IMSLP per-file edition metadata from work-page wikitext.
 *
 * Each PDF on a work page belongs to a `{{#fte:imslpfile ...}}` block whose
 * `Publisher Information` field carries the `{{P|Official name|…}}` publisher
 * template and, for scholarly editions, a bare `{{Urtext}}` tag. File pages
 * themselves expose none of this, so the work page is the only source.
 *
 * NO imports — loaded by Deno (with the `.ts` extension) and by vitest
 * (without it), so the parser is testable against saved wikitext fixtures.
 */

export interface ImslpFileMeta {
    /** Official IMSLP publisher name (`{{P}}` field 1, imprint as fallback). */
    publisher: string | null;
    /** Publication year when `{{P}}` states one. */
    year: number | null;
    /** Plate number (`{{P}}` field 7, or field 6 when that slot holds HN/BA-style plates). */
    plate: string | null;
    /** `{{Urtext}}` or `{{Urtext|…}}` sits on this file's publisher line. */
    urtext: boolean;
    /** The block names an Arranger / Transcriber (including `Arranger 2`). */
    arrangement: boolean;
    /** `File Description N`, e.g. "Complete Score". */
    description: string | null;
}

/**
 * `prop=images` titles use the space form with an upper-cased first letter;
 * `File Name N` values are usually written with underscores. Normalize both
 * sides so the map lookup matches regardless of spelling.
 */
export const fileBlockKey = (filename: string): string => {
    const spaced = filename.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (!spaced) {
        return spaced;
    }
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

export const NO_FILE_META: ImslpFileMeta = {
    publisher: null,
    year: null,
    plate: null,
    urtext: false,
    arrangement: false,
    description: null,
};

/** Look up parsed meta, or the empty defaults when the image was not in any block. */
export const fileMetaFor = (fileMeta: Map<string, ImslpFileMeta>, filename: string): ImslpFileMeta =>
    fileMeta.get(fileBlockKey(filename)) ?? NO_FILE_META;

const BLOCK_OPEN = '{{#fte:imslpfile';

/** Slice out every `{{#fte:imslpfile … }}` block, tolerating nested templates. */
const extractBlocks = (wikitext: string): string[] => {
    const blocks: string[] = [];
    let cursor = 0;
    while (cursor < wikitext.length) {
        const start = wikitext.indexOf(BLOCK_OPEN, cursor);
        if (start < 0) {
            break;
        }
        let depth = 0;
        let end = -1;
        for (let i = start; i < wikitext.length - 1; i++) {
            const pair = wikitext.slice(i, i + 2);
            if (pair === '{{') {
                depth++;
                i++;
            } else if (pair === '}}') {
                depth--;
                i++;
                if (depth === 0) {
                    end = i + 1;
                    break;
                }
            }
        }
        if (end < 0) {
            // Skip the broken opener and keep scanning — one unclosed block
            // must not drop later well-formed Henle/Bärenreiter blocks.
            cursor = start + BLOCK_OPEN.length;
            continue;
        }
        blocks.push(wikitext.slice(start + BLOCK_OPEN.length, end - 2));
        cursor = end;
    }
    return blocks;
};

/**
 * Split a block body into `Key=value` fields. Pipes inside `{{ }}` / `[[ ]]`
 * stay in the value, so both the usual multiline `|Key=` form and a one-line
 * `{{#fte:imslpfile|File Name 1=a.pdf|…}}` parse.
 */
const parseFields = (body: string): Map<string, string> => {
    const fields = new Map<string, string>();
    for (const raw of splitTemplateArgs(body)) {
        const eq = raw.indexOf('=');
        if (eq < 0) {
            continue;
        }
        const key = raw.slice(0, eq).trim();
        const value = raw.slice(eq + 1).trim();
        if (key) {
            fields.set(key, value);
        }
    }
    return fields;
};

const isArrangerField = (key: string): boolean => /^(Arranger|Transcriber)(?:\s+\d+)?$/i.test(key);

/** Split `{{P|a|b|…}}` arguments, keeping nested-template pipes intact. */
const splitTemplateArgs = (inner: string): string[] => {
    const args: string[] = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < inner.length; i++) {
        const pair = inner.slice(i, i + 2);
        if (pair === '{{' || pair === '[[') {
            depth++;
            current += pair;
            i++;
        } else if (pair === '}}' || pair === ']]') {
            depth--;
            current += pair;
            i++;
        } else if (inner[i] === '|' && depth === 0) {
            args.push(current);
            current = '';
        } else {
            current += inner[i];
        }
    }
    args.push(current);
    return args.map((a) => a.trim());
};

const stripMarkup = (value: string): string =>
    value
        .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
        .replace(/\[\[([^\]]*)\]\]/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/''+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

interface PublisherInfo {
    publisher: string | null;
    year: number | null;
    plate: string | null;
    urtext: boolean;
}

/**
 * Template:P positional args: 1 official name, 2 imprint, 3 city, 4 date
 * string (`n.d.[1959]`), 5 numeric year, 6 edition number, 7 plate.
 */
const LOOKS_LIKE_PLATE = /^[A-Z]{1,4}\s?\d/i;

const parsePublisherInfo = (value: string): PublisherInfo => {
    const urtext = /\{\{\s*Urtext(?:\s*\|[^}]*)?\s*\}\}/i.test(value);
    const match = value.match(/\{\{P\|((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/);
    if (!match) {
        return { publisher: null, year: null, plate: null, urtext };
    }
    const args = splitTemplateArgs(match[1] ?? '');
    const official = stripMarkup(args[0] ?? '');
    const imprint = stripMarkup(args[1] ?? '');
    const dateText = `${args[3] ?? ''} ${args[4] ?? ''}`;
    const yearMatch = dateText.match(/\d{4}/);
    const plateArg = stripMarkup(args[6] ?? '');
    const editionNo = stripMarkup(args[5] ?? '');
    const plate = plateArg || (LOOKS_LIKE_PLATE.test(editionNo) ? editionNo : '');
    return {
        publisher: official || imprint || null,
        year: yearMatch ? Number(yearMatch[0]) : null,
        plate: plate || null,
        urtext,
    };
};

/**
 * Map every PDF filename on the page (normalized via `fileBlockKey`) to its
 * edition metadata. Files in one block share the publisher line; per-file
 * `Publisher Information N` / `File Description N` override the shared value.
 */
export const parseImslpFileBlocks = (wikitext: string): Map<string, ImslpFileMeta> => {
    const out = new Map<string, ImslpFileMeta>();
    for (const block of extractBlocks(wikitext)) {
        const fields = parseFields(block);
        const shared = parsePublisherInfo(fields.get('Publisher Information') ?? '');
        const arrangement = [...fields.entries()].some(
            ([key, value]) => isArrangerField(key) && value.trim().length > 0,
        );
        for (const [key, filename] of fields) {
            const nameMatch = key.match(/^File Name (\d+)$/);
            if (!nameMatch || !filename) {
                continue;
            }
            const n = nameMatch[1];
            const perFile = fields.get(`Publisher Information ${n}`);
            const info = perFile ? parsePublisherInfo(perFile) : shared;
            const description = stripMarkup(fields.get(`File Description ${n}`) ?? '');
            out.set(fileBlockKey(filename), {
                publisher: info.publisher,
                year: info.year,
                plate: info.plate,
                urtext: info.urtext,
                arrangement,
                description: description || null,
            });
        }
    }
    return out;
};

/**
 * Who IMSLP credits for one file — what a Creative Commons Attribution
 * license obliges a copy to name. Kept apart from ImslpFileMeta (which drives
 * edition ranking in imslp-work) so the picker's response shape is unchanged.
 */
export interface ImslpFileCredits {
    /** `Editor` field: names from `{{LinkEd|First|Last}}`, or plain text. */
    editor: string | null;
    /** `Arranger` / `Transcriber` fields, same treatment. */
    arranger: string | null;
    /** `{{P}}` official name, or a plain-text publisher line ("Viktor Keil, 2024."). */
    publisher: string | null;
    year: number | null;
}

/** Longest credit kept; a field past this is not a name. */
const MAX_CREDIT_CHARS = 200;

const clipCredit = (value: string): string | null => {
    const trimmed = value
        .replace(/\s+/g, ' ')
        .replace(/^[\s,;.]+|[\s,;]+$/g, '')
        .trim();
    if (!trimmed) {
        return null;
    }
    return trimmed.length > MAX_CREDIT_CHARS ? `${trimmed.slice(0, MAX_CREDIT_CHARS - 1)}…` : trimmed;
};

/**
 * Person names out of an Editor/Arranger value. IMSLP links people with
 * `{{LinkEd|First|Last|born|died}}`, `{{LinkArr|…}}` and kin (first two args
 * are the name); other templates (`{{FE}}` "first edition", scan credits) are
 * not names and are dropped; any plain text left over is kept.
 */
const creditNames = (value: string): string | null => {
    const names: string[] = [];
    const rest = value.replace(/\{\{((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/g, (_, inner: string) => {
        const args = splitTemplateArgs(inner);
        const name = args[0] ?? '';
        if (/^Link(Ed|Arr|Name|Comp|Tr|Trans)\b/i.test(name)) {
            const person = [stripMarkup(args[1] ?? ''), stripMarkup(args[2] ?? '')].filter(Boolean).join(' ');
            if (person) {
                names.push(person);
            }
        }
        return ' ';
    });
    const plain = stripMarkup(rest.replace(/<br\s*\/?>/gi, ', '))
        .split(/\s*,\s*/)
        .map((part) => part.trim())
        .filter(Boolean);
    for (const part of plain) {
        names.push(part);
    }
    const unique = [...new Set(names)];
    return unique.length > 0 ? clipCredit(unique.join(', ')) : null;
};

/** Plain-text publisher line once templates are gone ("Viktor Keil, 2024." → "Viktor Keil, 2024"). */
const plainPublisher = (value: string): string | null =>
    clipCredit(stripMarkup(value.replace(/\{\{((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/g, ' ')).replace(/\.$/, ''));

/**
 * Credits for one file on the work page, or null when no file block lists it.
 * Per-file `Publisher Information N` / `Editor N` override the block's shared
 * value, as in parseImslpFileBlocks.
 */
export const fileCreditsFor = (wikitext: string, filename: string): ImslpFileCredits | null => {
    const wanted = fileBlockKey(filename);
    for (const block of extractBlocks(wikitext)) {
        const fields = parseFields(block);
        for (const [key, name] of fields) {
            const nameMatch = key.match(/^File Name (\d+)$/);
            if (!nameMatch || !name || fileBlockKey(name) !== wanted) {
                continue;
            }
            const n = nameMatch[1];
            const publisherField =
                fields.get(`Publisher Information ${n}`) ?? fields.get('Publisher Information') ?? '';
            const info = parsePublisherInfo(publisherField);
            const editorField = fields.get(`Editor ${n}`) ?? fields.get('Editor') ?? '';
            const arrangers = [...fields.entries()]
                .filter(([field]) => isArrangerField(field))
                .map(([, value]) => creditNames(value))
                .filter((v): v is string => Boolean(v));
            return {
                editor: creditNames(editorField),
                arranger: arrangers.length > 0 ? clipCredit([...new Set(arrangers)].join(', ')) : null,
                publisher: info.publisher ? clipCredit(info.publisher) : plainPublisher(publisherField),
                year: info.year,
            };
        }
    }
    return null;
};
