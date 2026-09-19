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
    /** Plate number (`{{P}}` field 7) when present. */
    plate: string | null;
    /** `{{Urtext}}` sits on this file's publisher line. */
    urtext: boolean;
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
            break;
        }
        blocks.push(wikitext.slice(start + BLOCK_OPEN.length, end - 2));
        cursor = end;
    }
    return blocks;
};

/**
 * Split a block body into `Key=value` fields. Fields start on their own line
 * with `|`; template pipes inside a value never follow a newline, so the
 * newline-then-pipe split is safe.
 */
const parseFields = (body: string): Map<string, string> => {
    const fields = new Map<string, string>();
    for (const raw of body.split(/\n\|/)) {
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
const parsePublisherInfo = (value: string): PublisherInfo => {
    const urtext = /\{\{\s*Urtext\s*\}\}/i.test(value);
    const match = value.match(/\{\{P\|((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/);
    if (!match) {
        return { publisher: null, year: null, plate: null, urtext };
    }
    const args = splitTemplateArgs(match[1] ?? '');
    const official = stripMarkup(args[0] ?? '');
    const imprint = stripMarkup(args[1] ?? '');
    const dateText = `${args[3] ?? ''} ${args[4] ?? ''}`;
    const yearMatch = dateText.match(/\d{4}/);
    const plate = stripMarkup(args[6] ?? '');
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
                description: description || null,
            });
        }
    }
    return out;
};
