import type { FontSpec } from '@/features/import/textFit';
import {
    canvasFont,
    MAX_MUSIC_TEXT_SIZE,
    MAX_TEXT_SIZE,
    measureInkText,
    resetInkTextMetricsCache,
    SYSTEM_FONT_FAMILY,
} from '@/features/import/textFit';
import type { Bbox } from '@/features/viewer/geometry';
import { isTextPayload, type Annotation, type TextFont, type TextPayload } from '@/types/models';

/**
 * The music-text face for converted handwriting. Typed notes are untouched:
 * every decision here is keyed off the `hw` provenance flag plus the token.
 *
 * Symbols are STORED as ASCII where one exists (`mf`, `tr`) so peers on an
 * old build, exports without the font, and the text editor all still read
 * them; the renderer maps them to SMuFL codepoints at draw time. Marks with
 * no ASCII spelling (accent, fermata) are stored as their codepoint.
 */

export const MUSIC_FONT_FAMILY = 'Bravura Text';
/** Served from public/ — fetched on first use (canvas) and for PDF export. */
export const MUSIC_FONT_URL = '/fonts/BravuraText.woff2';

/**
 * Serif for prose notes. Bodoni is already shipped for the app's display
 * face (including italic); the default text face is already a sans, so
 * there is no third family.
 */
export const SERIF_FONT_FAMILY = '"Bodoni Moda Variable", ui-serif, Georgia, "Times New Roman", serif';

const proseFamily = (font: TextFont | undefined): string => {
    switch (font) {
        case 'serif':
            return SERIF_FONT_FAMILY;
        case 'sans':
        case undefined:
            return SYSTEM_FONT_FAMILY;
        default: {
            const unexpected: never = font;
            return unexpected;
        }
    }
};

/** Dynamics / ornament tokens → SMuFL text-font glyphs. */
const SMUFL_BY_TOKEN: Record<string, string> = {
    p: '\uE520',
    m: '\uE521',
    f: '\uE522',
    r: '\uE523',
    s: '\uE524',
    z: '\uE525',
    pp: '\uE52B',
    mp: '\uE52C',
    mf: '\uE52D',
    pf: '\uE52E',
    ff: '\uE52F',
    fp: '\uE534',
    sf: '\uE536',
    sfz: '\uE539',
    tr: '\uE566',
};

/** Teaching words that engraved scores set in italics. */
const ITALIC_TOKENS: ReadonlySet<string> = new Set(['cresc.', 'dim.', 'decresc.', 'rit.', 'ped.', 'sim.']);

/** SMuFL private-use range (U+E000–U+F8FF). */
const isSmufl = (text: string): boolean => text.length > 0 && /^[\uE000-\uF8FF]+$/.test(text);

/** What to draw a text payload with. `glyphs` is the string to actually paint. */
export interface TextDrawSpec extends FontSpec {
    glyphs: string;
    /** True when `family` is the music font (needs loading; embeds in PDF). */
    music: boolean;
}

/** Prose style carried on a text payload. Music tokens do not read it. */
export type ProseStyle = Pick<TextPayload, 'font' | 'bold' | 'italic'>;

const proseItalic = (text: string, hw: boolean, italic: ProseStyle['italic']): boolean => {
    if (italic === 1) {
        return true;
    }
    if (italic === 0) {
        return false;
    }
    return hw && ITALIC_TOKENS.has(text);
};

/**
 * What to paint. A converted dynamic, accent, or fermata stays on the music
 * face no matter which prose font, bold, or italic is stored beside it.
 */
export const textDrawSpec = (text: string, hw: boolean, prose: ProseStyle = {}): TextDrawSpec => {
    if (hw) {
        const mapped = SMUFL_BY_TOKEN[text];
        if (mapped !== undefined) {
            return { family: MUSIC_FONT_FAMILY, style: 'normal', glyphs: mapped, music: true };
        }
        if (isSmufl(text)) {
            return { family: MUSIC_FONT_FAMILY, style: 'normal', glyphs: text, music: true };
        }
    }
    const italic = proseItalic(text, hw, prose.italic);
    const bold = prose.bold === 1;
    return {
        family: proseFamily(prose.font),
        style: italic ? 'italic' : 'normal',
        ...(bold ? { weight: 'bold' as const } : {}),
        glyphs: text,
        music: false,
    };
};

/** True when this note is a music-font token, so prose style must not change its face. */
export const ignoresProseFont = (payload: TextPayload): boolean => textDrawSpec(payload.text, payload.hw === 1).music;

export type TextStylePatch = {
    font?: TextFont;
    bold?: boolean;
    italic?: boolean;
};

/**
 * Apply a font, bold, or italic change. Music tokens are returned unchanged.
 * Returns the same object when the stored style already matches.
 */
export const styledTextPayload = (payload: TextPayload, patch: TextStylePatch): TextPayload => {
    if (ignoresProseFont(payload)) {
        return payload;
    }
    const next: TextPayload = { ...payload };
    if (patch.font !== undefined) {
        if (patch.font === 'serif') {
            next.font = 'serif';
        } else if (payload.font === 'sans') {
            next.font = 'sans';
        } else {
            delete next.font;
        }
    }
    if (patch.bold !== undefined) {
        if (patch.bold) {
            next.bold = 1;
        } else {
            delete next.bold;
        }
    }
    if (patch.italic !== undefined) {
        const implicitItalic = payload.hw === 1 && ITALIC_TOKENS.has(payload.text);
        if (patch.italic) {
            if (implicitItalic) {
                delete next.italic;
            } else {
                next.italic = 1;
            }
        } else if (implicitItalic) {
            next.italic = 0;
        } else {
            delete next.italic;
        }
    }
    if (next.font === payload.font && next.bold === payload.bold && next.italic === payload.italic) {
        return payload;
    }
    return next;
};

/** Readable spelling for the text editor (SMuFL marks are tofu in system-ui). */
export const textForEditor = (text: string): string => {
    if (text === '\uE4A0') {
        return '>';
    }
    if (text === '\uE4C0') {
        return 'fermata';
    }
    return text;
};

/**
 * Apply a text-editor commit to a converted/typed payload. Changing the
 * letters drops `hw` so a retyped `p` is not a Bravura *p* without consent.
 */
export const editedTextPayload = (existing: TextPayload, trimmed: string): 'delete' | 'unchanged' | TextPayload => {
    if (trimmed === '') {
        return 'delete';
    }
    if (trimmed === textForEditor(existing.text)) {
        return 'unchanged';
    }
    const next: TextPayload = { x: existing.x, y: existing.y, text: trimmed, size: existing.size };
    if (existing.src === 1) {
        next.src = 1;
    }
    if (existing.sf === 1) {
        next.sf = 1;
    }
    if (existing.font !== undefined) {
        next.font = existing.font;
    }
    if (existing.bold === 1) {
        next.bold = 1;
    }
    if (existing.italic === 0 || existing.italic === 1) {
        next.italic = existing.italic;
    }
    return next;
};

/** ASCII (or a named alias) to paint when the music face is missing from a PDF. */
export const pdfFallbackGlyphs = (text: string, spec: TextDrawSpec): string => {
    if (!spec.music) {
        return spec.glyphs;
    }
    return textForEditor(text);
};

/** Does this annotation draw with the music face (so an export must embed it)? */
export const annotationNeedsMusicFont = (annotation: Annotation): boolean =>
    isTextPayload(annotation.payload) &&
    textDrawSpec(annotation.payload.text, annotation.payload.hw === 1, annotation.payload).music;

/** Largest `size` a text may be scaled to: music glyphs fill a fraction of their em, so they get more room. */
export const maxTextSizeFor = (payload: TextPayload): number =>
    textDrawSpec(payload.text, payload.hw === 1, payload).music ? MAX_MUSIC_TEXT_SIZE : MAX_TEXT_SIZE;

/** Line pitch as a multiple of the font size (shared by renderer, hit test and export). */
export const TEXT_LINE_HEIGHT = 1.25;

/** Gap (page widths) a prose note's wrapped lines keep from the page's right edge. */
export const TEXT_NOTE_EDGE = 0.02;
/** Room (page widths) a new note keeps to its right: one tapped at the edge starts further in. */
export const MIN_TEXT_NOTE_WIDTH = 0.25;
/** Narrowest wrap (em): an older note hard against the edge overruns it rather than stacking letters. */
const MIN_WRAP_EM = 6;
/** Advance guess per character where the canvas cannot measure (jsdom). */
const FALLBACK_ADVANCE_EM = 0.55;

/** Widest a prose note's line may be, in em: up to the page's right edge, less the margin. */
export const textWrapEm = (payload: Pick<TextPayload, 'x' | 'size'>): number =>
    Math.max(MIN_WRAP_EM, (1 - TEXT_NOTE_EDGE - payload.x) / Math.max(payload.size, 1e-6));

let advanceProbe: CanvasRenderingContext2D | null | undefined;
const advanceCache = new Map<string, number>();

/** Advance width of a string / font size (one shared probe canvas, cached). */
const advanceEm = (text: string, font: FontSpec): number => {
    const key = `${canvasFont(font, 100)}|${text}`;
    const hit = advanceCache.get(key);
    if (hit !== undefined) {
        return hit;
    }
    if (advanceProbe === undefined) {
        try {
            advanceProbe = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
        } catch {
            advanceProbe = null;
        }
    }
    let em = Array.from(text).length * FALLBACK_ADVANCE_EM;
    if (advanceProbe) {
        advanceProbe.font = canvasFont(font, 100);
        const width = advanceProbe.measureText(text).width;
        if (Number.isFinite(width)) {
            em = width / 100;
        }
    }
    if (advanceCache.size > 2000) {
        advanceCache.clear();
    }
    advanceCache.set(key, em);
    return em;
};

const graphemes = (text: string): string[] =>
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
        ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment)
        : Array.from(text);

/** Graphemes a line may break before or after without a space (emoji, CJK), as the browser does. */
const BREAK_AROUND =
    /[\p{Extended_Pictographic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** Closing and trailing punctuation never starts a line; opening punctuation never ends one. */
const NO_BREAK_BEFORE = /^[\p{Pe}\p{Pf}\p{Po}]/u;
const NO_BREAK_AFTER = /[\p{Ps}\p{Pi}]$/u;

/**
 * A space-free run cut at the places the browser may also break it: around
 * emoji and CJK, and after a hyphen inside a word (`a-b`, not `-5`).
 */
const breakSegments = (word: string): string[] => {
    const parts = graphemes(word);
    const out: string[] = [];
    let current = '';
    parts.forEach((g, i) => {
        const prev = parts[i - 1] ?? '';
        const opportunity =
            BREAK_AROUND.test(g) || BREAK_AROUND.test(prev) || (prev === '-' && i >= 2 && g !== '-' && !/^\d/.test(g));
        if (current !== '' && opportunity && !NO_BREAK_BEFORE.test(g) && !NO_BREAK_AFTER.test(prev)) {
            out.push(current);
            current = '';
        }
        current += g;
    });
    if (current !== '') {
        out.push(current);
    }
    return out;
};

/**
 * Greedy wrap of one line at `maxEm`: breaks between words (and around emoji
 * and CJK, see breakSegments), and inside a word (by grapheme, so an emoji or
 * accented letter is never split) only when the word alone is wider than the
 * line — the same way the editor's textarea wraps.
 */
const wrapLine = (line: string, maxEm: number, measureEm: (s: string) => number): string[] => {
    const fits = (s: string) => measureEm(s) <= maxEm;
    const out: string[] = [];
    let current = '';
    const tokens = line.split(/(\s+)/).flatMap((t) => (t.trim() === '' ? [t] : breakSegments(t)));
    for (const token of tokens) {
        if (token === '') {
            continue;
        }
        const candidate = current + token;
        if (fits(candidate.trimEnd())) {
            current = candidate;
            continue;
        }
        if (current.trim() !== '') {
            out.push(current.trimEnd());
        }
        current = '';
        if (token.trim() === '') {
            continue;
        }
        let rest = token;
        while (!fits(rest)) {
            const parts = graphemes(rest);
            // Longest prefix that fits, at least one grapheme so the loop always advances.
            let lo = 1;
            let hi = parts.length - 1;
            while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                if (fits(parts.slice(0, mid).join(''))) {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            out.push(parts.slice(0, lo).join(''));
            rest = parts.slice(lo).join('');
        }
        current = rest;
    }
    out.push(current.trimEnd());
    return out;
};

/**
 * The lines a text note is drawn as: its own line breaks, and prose wrapped so
 * it stays inside the page (shared by the renderer, hit test and selection
 * box, and the PDF export). Music glyphs are single marks and never wrap.
 * `measureEm` (advance width / font size) defaults to the shared canvas probe;
 * the export passes its embedded font's metrics so the PDF wraps exactly.
 */
export const textNoteLines = (
    payload: TextPayload,
    spec: TextDrawSpec = textDrawSpec(payload.text, payload.hw === 1, payload),
    measureEm: (s: string) => number = (s) => advanceEm(s, spec),
): string[] => {
    const lines = spec.glyphs.split('\n');
    if (spec.music) {
        return lines;
    }
    const maxEm = textWrapEm(payload);
    return lines.flatMap((line) => wrapLine(line, maxEm, measureEm));
};

/**
 * `text` with the lines it wraps to at `maxEm` (instead of at the page edge)
 * made explicit, for a note typed into an editor narrower than the page room
 * so it keeps the breaks the writer saw. Music glyphs come back unchanged.
 */
export const hardWrapText = (payload: TextPayload, maxEm: number): string => {
    const spec = textDrawSpec(payload.text, payload.hw === 1, payload);
    if (spec.music) {
        return payload.text;
    }
    const measureEm = (s: string) => advanceEm(s, spec);
    return spec.glyphs
        .split('\n')
        .flatMap((line) => wrapLine(line, maxEm, measureEm))
        .join('\n');
};

/**
 * Visual bounds of a text payload as drawn — measured glyph box, not an
 * em-per-character guess — in normalized page coords (`aspect` = page height
 * / width). A converted accent gets an accent-sized box; a typed word gets
 * the box of its letters.
 */
export const textBoundsNorm = (payload: TextPayload, aspect: number): Bbox => {
    const { x, y, size, hw } = payload;
    const spec = textDrawSpec(payload.text, hw === 1, payload);
    const lines = textNoteLines(payload, spec);
    let width = 0;
    let top = Infinity;
    let bottom = -Infinity;
    lines.forEach((line, i) => {
        const m = measureInkText(line === '' ? ' ' : line, {
            family: spec.family,
            style: spec.style,
            weight: spec.weight,
        });
        width = Math.max(width, m.widthRatio);
        const lineTop = i * TEXT_LINE_HEIGHT + m.topInset;
        top = Math.min(top, lineTop);
        bottom = Math.max(bottom, lineTop + m.heightRatio);
    });
    if (!Number.isFinite(top)) {
        top = 0;
        bottom = 1;
    }
    // Everything above is in em; scale to page width, then y into page height.
    return [x, y + (top * size) / aspect, x + width * size, y + (bottom * size) / aspect];
};

// ---- loading ---------------------------------------------------------------

type FontStatus = 'idle' | 'loading' | 'ready' | 'failed';
let status: FontStatus = 'idle';
let inflight: Promise<boolean> | null = null;
const readyListeners = new Set<() => void>();

export const isMusicFontReady = (): boolean => status === 'ready';

/** Fires once, after the face becomes usable on canvas (repaint hook). */
export const onMusicFontReady = (listener: () => void): (() => void) => {
    readyListeners.add(listener);
    return () => readyListeners.delete(listener);
};

/**
 * Kick off (or await) the @font-face load. Canvas text does not trigger CSS
 * font loading by itself, so the renderer calls this the first time it meets
 * a converted symbol; until it resolves the symbol is drawn as fallback text.
 */
export const ensureMusicFontLoaded = (): Promise<boolean> => {
    if (status === 'ready') {
        return Promise.resolve(true);
    }
    if (status === 'failed') {
        return Promise.resolve(false);
    }
    if (inflight) {
        return inflight;
    }
    if (typeof document === 'undefined' || !document.fonts?.load) {
        status = 'failed';
        return Promise.resolve(false);
    }
    status = 'loading';
    inflight = document.fonts
        .load(`16px "${MUSIC_FONT_FAMILY}"`)
        .then((faces) => {
            if (faces.length === 0) {
                status = 'failed';
                return false;
            }
            status = 'ready';
            // Measurements taken before the face arrived came from a fallback font.
            resetInkTextMetricsCache(MUSIC_FONT_FAMILY);
            for (const listener of [...readyListeners]) {
                listener();
            }
            return true;
        })
        .catch(() => {
            status = 'failed';
            return false;
        })
        .finally(() => {
            inflight = null;
        });
    return inflight;
};

/** Test hook. */
export const resetMusicFontStateForTests = (): void => {
    status = 'idle';
    inflight = null;
    readyListeners.clear();
};
