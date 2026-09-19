import type { FontSpec } from '@/features/import/textFit';
import { SYSTEM_FONT_FAMILY } from '@/features/import/textFit';
import { isTextPayload, type Annotation } from '@/types/models';

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

export const textDrawSpec = (text: string, hw: boolean): TextDrawSpec => {
    if (hw) {
        const mapped = SMUFL_BY_TOKEN[text];
        if (mapped !== undefined) {
            return { family: MUSIC_FONT_FAMILY, style: 'normal', glyphs: mapped, music: true };
        }
        if (isSmufl(text)) {
            return { family: MUSIC_FONT_FAMILY, style: 'normal', glyphs: text, music: true };
        }
        if (ITALIC_TOKENS.has(text)) {
            return { family: SYSTEM_FONT_FAMILY, style: 'italic', glyphs: text, music: false };
        }
    }
    return { family: SYSTEM_FONT_FAMILY, style: 'normal', glyphs: text, music: false };
};

/** Does this annotation draw with the music face (so an export must embed it)? */
export const annotationNeedsMusicFont = (annotation: Annotation): boolean =>
    isTextPayload(annotation.payload) && textDrawSpec(annotation.payload.text, annotation.payload.hw === 1).music;

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
