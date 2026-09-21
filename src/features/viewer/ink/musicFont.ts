import type { FontSpec } from '@/features/import/textFit';
import {
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

/**
 * Visual bounds of a text payload as drawn — measured glyph box, not an
 * em-per-character guess — in normalized page coords (`aspect` = page height
 * / width). A converted accent gets an accent-sized box; a typed word gets
 * the box of its letters.
 */
export const textBoundsNorm = (payload: TextPayload, aspect: number): Bbox => {
    const { x, y, size, hw } = payload;
    const spec = textDrawSpec(payload.text, hw === 1, payload);
    const lines = spec.glyphs.split('\n');
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
