import { describe, expect, it } from 'vitest';

import { SYSTEM_FONT_FAMILY } from '@/features/import/textFit';
import {
    MUSIC_FONT_FAMILY,
    SERIF_FONT_FAMILY,
    editedTextPayload,
    styledTextPayload,
    textDrawSpec,
} from '@/features/viewer/ink/musicFont';
import { parseDbChange } from '@/sync/wire';
import type { TextPayload } from '@/types/models';

const prose = (overrides: Partial<TextPayload> = {}): TextPayload => ({
    x: 0.1,
    y: 0.2,
    text: 'use wrist',
    size: 0.02,
    hw: 1,
    ...overrides,
});

const broadcast = (payload: TextPayload) =>
    parseDbChange({
        operation: 'UPDATE',
        schema: 'public',
        table: 'annotations',
        record: {
            id: 'note',
            document_id: 'doc',
            page: 0,
            kind: 'text',
            color: '#1f2937',
            payload,
            created_by: 'user-1',
            created_at: '2026-09-21T00:00:00.000Z',
            updated_at: '2026-09-21T00:00:00.000Z',
            deleted_at: null,
            seq: 4,
        },
    });

describe('prose font, bold, and italic', () => {
    it('round-trips font, bold, and italic through the realtime schema', () => {
        const payload = prose({ font: 'serif', bold: 1, italic: 1 });
        const row = broadcast(payload);
        expect(row?.payload).toEqual(payload);

        const roman = prose({ text: 'cresc.', font: 'sans', italic: 0 });
        expect(broadcast(roman)?.payload).toEqual(roman);
    });

    it('keeps the style when the letters change and drops hw', () => {
        expect(editedTextPayload(prose({ font: 'serif', bold: 1, italic: 1 }), 'slow')).toEqual({
            x: 0.1,
            y: 0.2,
            text: 'slow',
            size: 0.02,
            font: 'serif',
            bold: 1,
            italic: 1,
        });
    });

    it('music tokens ignore the prose font', () => {
        const styled = { font: 'serif' as const, bold: 1 as const, italic: 1 as const };
        for (const text of ['mf', 'sfz', 'tr', '\uE4A0', '\uE4C0']) {
            const payload = prose({ text, ...styled });
            expect(styledTextPayload(payload, { font: 'serif', bold: true, italic: true })).toBe(payload);
            expect(textDrawSpec(text, true, payload)).toMatchObject({
                family: MUSIC_FONT_FAMILY,
                style: 'normal',
                glyphs: text === 'mf' ? '\uE52D' : text === 'sfz' ? '\uE539' : text === 'tr' ? '\uE566' : text,
                music: true,
            });
            expect(textDrawSpec(text, true, payload).weight).toBeUndefined();
        }
        const typed = prose({ text: 'mf', hw: undefined, ...styled });
        expect(textDrawSpec('mf', false, typed)).toMatchObject({
            family: SERIF_FONT_FAMILY,
            style: 'italic',
            weight: 'bold',
            glyphs: 'mf',
            music: false,
        });
    });

    it('sets converted prose and typed notes in the chosen face', () => {
        const next = styledTextPayload(prose(), { font: 'serif', bold: true, italic: true });
        expect(next).toMatchObject({ text: 'use wrist', hw: 1, font: 'serif', bold: 1, italic: 1 });
        expect(textDrawSpec(next.text, true, next)).toMatchObject({
            family: SERIF_FONT_FAMILY,
            style: 'italic',
            weight: 'bold',
            music: false,
        });

        const sans = styledTextPayload(next, { font: 'sans', bold: false, italic: false });
        expect(sans.font).toBeUndefined();
        expect(sans.bold).toBeUndefined();
        expect(sans.italic).toBeUndefined();
        expect(textDrawSpec(sans.text, true, sans)).toMatchObject({
            family: SYSTEM_FONT_FAMILY,
            style: 'normal',
            music: false,
        });
        expect(textDrawSpec('hello', false)).toMatchObject({ family: SYSTEM_FONT_FAMILY, style: 'normal' });
    });

    it('keeps a converted teaching word italic until the user forces roman', () => {
        const cresc = prose({ text: 'cresc.' });
        expect(textDrawSpec('cresc.', true).style).toBe('italic');
        const roman = styledTextPayload(cresc, { italic: false });
        expect(roman.italic).toBe(0);
        expect(textDrawSpec(roman.text, true, roman).style).toBe('normal');
        const back = styledTextPayload(roman, { italic: true });
        expect(back.italic).toBeUndefined();
        expect(textDrawSpec(back.text, true, back).style).toBe('italic');
        expect(back.font).toBeUndefined();
    });
});
