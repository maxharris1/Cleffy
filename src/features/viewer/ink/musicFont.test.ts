import { afterEach, describe, expect, it, vi } from 'vitest';

import { SYSTEM_FONT_FAMILY } from '@/features/import/textFit';
import {
    annotationNeedsMusicFont,
    editedTextPayload,
    ensureMusicFontLoaded,
    isMusicFontReady,
    MUSIC_FONT_FAMILY,
    onMusicFontReady,
    pdfFallbackGlyphs,
    resetMusicFontStateForTests,
    textDrawSpec,
    textForEditor,
} from '@/features/viewer/ink/musicFont';
import type { Annotation } from '@/types/models';

const textAnnotation = (text: string, hw?: 1): Annotation => ({
    id: 'a',
    docId: 'd',
    page: 0,
    kind: 'text',
    color: '#1f2937',
    payload: { x: 0.1, y: 0.1, text, size: 0.02, ...(hw ? { hw } : {}) },
    createdBy: null,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
    seq: 0,
});

afterEach(() => {
    resetMusicFontStateForTests();
    vi.unstubAllGlobals();
});

describe('textDrawSpec', () => {
    it('maps converted dynamics to SMuFL glyphs in the music face', () => {
        expect(textDrawSpec('mf', true)).toEqual({
            family: MUSIC_FONT_FAMILY,
            style: 'normal',
            glyphs: '\uE52D',
            music: true,
        });
        expect(textDrawSpec('sfz', true).glyphs).toBe('\uE539');
        expect(textDrawSpec('tr', true).glyphs).toBe('\uE566');
    });

    it('passes stored SMuFL codepoints (accent, fermata) straight through', () => {
        expect(textDrawSpec('\uE4A0', true)).toMatchObject({
            family: MUSIC_FONT_FAMILY,
            glyphs: '\uE4A0',
            music: true,
        });
    });

    it('sets converted teaching words in italics and everything else upright system-ui', () => {
        expect(textDrawSpec('cresc.', true)).toEqual({
            family: SYSTEM_FONT_FAMILY,
            style: 'italic',
            glyphs: 'cresc.',
            music: false,
        });
        expect(textDrawSpec('use wrist', true)).toMatchObject({ family: SYSTEM_FONT_FAMILY, style: 'normal' });
        expect(textDrawSpec('3', true)).toMatchObject({ family: SYSTEM_FONT_FAMILY, glyphs: '3', music: false });
    });

    it('leaves typed notes alone — a typed "mf" is ordinary text', () => {
        expect(textDrawSpec('mf', false)).toEqual({
            family: SYSTEM_FONT_FAMILY,
            style: 'normal',
            glyphs: 'mf',
            music: false,
        });
        expect(annotationNeedsMusicFont(textAnnotation('mf'))).toBe(false);
        expect(annotationNeedsMusicFont(textAnnotation('mf', 1))).toBe(true);
        expect(annotationNeedsMusicFont(textAnnotation('use wrist', 1))).toBe(false);
    });

    it('maps SMuFL marks to editable ASCII and drops hw when the user retypes', () => {
        expect(textForEditor('\uE4A0')).toBe('>');
        expect(textForEditor('\uE4C0')).toBe('fermata');
        expect(textForEditor('mf')).toBe('mf');
        expect(editedTextPayload({ x: 0, y: 0, text: 'mf', size: 0.02, hw: 1 }, 'mf')).toBe('unchanged');
        expect(editedTextPayload({ x: 0, y: 0, text: '\uE4A0', size: 0.02, hw: 1 }, '>')).toBe('unchanged');
        expect(editedTextPayload({ x: 0.1, y: 0.2, text: 'mf', size: 0.02, hw: 1 }, 'p')).toEqual({
            x: 0.1,
            y: 0.2,
            text: 'p',
            size: 0.02,
        });
        expect(editedTextPayload({ x: 0, y: 0, text: 'mf', size: 0.02, hw: 1 }, '')).toBe('delete');
        expect(pdfFallbackGlyphs('mf', textDrawSpec('mf', true))).toBe('mf');
        expect(pdfFallbackGlyphs('\uE4A0', textDrawSpec('\uE4A0', true))).toBe('>');
    });
});

describe('ensureMusicFontLoaded', () => {
    it('loads through document.fonts once, then reports ready and fires the hook', async () => {
        const load = vi.fn(async () => [{}] as unknown as FontFace[]);
        vi.stubGlobal('document', Object.assign(document, { fonts: { load } }));
        const ready = vi.fn();
        onMusicFontReady(ready);

        const [a, b] = await Promise.all([ensureMusicFontLoaded(), ensureMusicFontLoaded()]);
        expect(a).toBe(true);
        expect(b).toBe(true);
        expect(load).toHaveBeenCalledTimes(1);
        expect(load).toHaveBeenCalledWith(`16px "${MUSIC_FONT_FAMILY}"`);
        expect(isMusicFontReady()).toBe(true);
        expect(ready).toHaveBeenCalledTimes(1);
        expect(await ensureMusicFontLoaded()).toBe(true);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('reports failure (and stays not-ready) when the face cannot load', async () => {
        const load = vi.fn(async () => [] as FontFace[]);
        vi.stubGlobal('document', Object.assign(document, { fonts: { load } }));
        expect(await ensureMusicFontLoaded()).toBe(false);
        expect(isMusicFontReady()).toBe(false);
    });
});
