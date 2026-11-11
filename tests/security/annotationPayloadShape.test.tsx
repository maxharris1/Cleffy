import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/react';
import type { PDFPageProxy } from 'pdfjs-dist';
import { describe, expect, it } from 'vitest';

import { SUGGESTED_FINGERING_COLOR } from '../../src/features/fingering/applyFingerings';
import { extractBornDigital } from '../../src/features/import/bornDigital';
import { buildProposals } from '../../src/features/import/proposals';
import { segmentPage } from '../../src/features/import/segmentation';
import { MAX_MUSIC_TEXT_SIZE, MAX_TEXT_SIZE, MIN_TEXT_SIZE } from '../../src/features/import/textFit';
import { MAX_STROKE_W } from '../../src/features/import/vectorize';
import { STROKE_COLORS } from '../../src/state/store';
import { INK_BLUE, INK_RED, makeRaster, paintRect } from '../../src/test/rasterFixtures';
import { TextEditorOverlay } from '../../src/features/viewer/ink/TextEditorOverlay';
import type { AnnotationStore } from '../../src/sync/annotationStore';
import {
    clampTextNote,
    MAX_PAGE_COORD,
    MAX_TEXT_NOTE_CHARS,
    MIN_PAGE_COORD,
    type Annotation,
} from '../../src/types/models';

/**
 * The server now refuses malformed annotation payloads and colours (migration
 * 20261010120301_annotation_payload_shape; behaviour proved in
 * tests/sql/annotation_payload_shape.sql). A refused write is rolled back by
 * the sync outbox, so the one thing that must never happen is the client's own
 * writers drifting outside what the server accepts. These pin the client's
 * ranges against the migration's, and run real import proposals through a
 * mirror of the check.
 */

const MIGRATION = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20261010120301_annotation_payload_shape.sql'),
    'utf8',
);

const MAX_PAYLOAD_BYTES = 1048576;
const MAX_TEXT_CHARS = MAX_TEXT_NOTE_CHARS;
const COORD_MIN = MIN_PAGE_COORD;
const COORD_MAX = MAX_PAGE_COORD;
const COLOR_RE = /^#[0-9A-Fa-f]{3,8}$/;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const flagOk = (p: Record<string, unknown>, key: string, allowed: unknown[]): boolean =>
    !(key in p) || allowed.includes(p[key]);

/** annotation_payload_valid, restated in TypeScript for the client-side checks below. */
const serverAccepts = (annotation: Pick<Annotation, 'kind' | 'color' | 'payload'>): boolean => {
    const p = annotation.payload as unknown as Record<string, unknown>;
    if (!COLOR_RE.test(annotation.color) || JSON.stringify(p).length > MAX_PAYLOAD_BYTES) {
        return false;
    }
    if (annotation.kind === 'stroke' || annotation.kind === 'highlight') {
        const pts = p.pts;
        return (
            Array.isArray(pts) &&
            pts.length >= 3 &&
            pts.length % 3 === 0 &&
            pts.every((v) => isNum(v) && v >= COORD_MIN && v <= COORD_MAX) &&
            isNum(p.w) &&
            p.w > 0 &&
            p.w <= 1 &&
            flagOk(p, 'sp', [1]) &&
            flagOk(p, 'src', [1])
        );
    }
    return (
        isNum(p.x) &&
        p.x >= COORD_MIN &&
        p.x <= COORD_MAX &&
        isNum(p.y) &&
        p.y >= COORD_MIN &&
        p.y <= COORD_MAX &&
        isNum(p.size) &&
        p.size > 0 &&
        p.size <= 1 &&
        typeof p.text === 'string' &&
        p.text.length <= MAX_TEXT_CHARS &&
        ['src', 'sf', 'hw', 'bold'].every((key) => flagOk(p, key, [1])) &&
        flagOk(p, 'italic', [0, 1]) &&
        flagOk(p, 'font', ['sans', 'serif'])
    );
};

describe('the server’s payload check and the client agree', () => {
    it('the migration carries the bounds this file mirrors', () => {
        expect(MIGRATION).toContain(`<= ${MAX_PAYLOAD_BYTES}`);
        expect(MIGRATION).toContain(`<= ${MAX_TEXT_CHARS}`);
        expect(MIGRATION).toContain(`between ${COORD_MIN} and ${COORD_MAX}`);
        expect(MIGRATION).toContain(`@ < ${COORD_MIN} || @ > ${COORD_MAX}`);
        expect(MIGRATION).toContain(`'^#[0-9A-Fa-f]{3,8}$'`);
        expect(MIGRATION).toContain(`'"sans"'::jsonb, '"serif"'::jsonb`);
    });

    it('every palette colour, and the fingering colour, is one the server takes', () => {
        for (const color of [...STROKE_COLORS, SUGGESTED_FINGERING_COLOR]) {
            expect(color).toMatch(COLOR_RE);
        }
    });

    it('the client’s own size ceilings sit inside the server’s', () => {
        expect(MIN_TEXT_SIZE).toBeGreaterThan(0);
        expect(Math.max(MAX_TEXT_SIZE, MAX_MUSIC_TEXT_SIZE)).toBeLessThanOrEqual(1);
        expect(MAX_STROKE_W).toBeLessThanOrEqual(1);
    });

    it('imported ink and imported text pass the check', () => {
        const raster = makeRaster(512, 256);
        paintRect(raster, 100, 30, 10, 14, INK_BLUE);
        paintRect(raster, 118, 30, 10, 14, INK_BLUE);
        // Touching the page edges, where normalized coordinates reach 0 and 1.
        paintRect(raster, 0, 0, 6, 40, INK_RED);
        paintRect(raster, 506, 216, 6, 40, INK_RED);
        const seg = segmentPage(raster, 0);
        const [d1, d2] = seg.clusters.map((c) => c.id);

        const ink = buildProposals('doc-1', seg, null).flatMap((item) => item.annotations);
        const text = buildProposals('doc-1', seg, {
            clusters: [
                { id: d1 ?? '', kind: 'digit', text: '3', confidence: 'high' },
                { id: d2 ?? '', kind: 'text', text: 'cresc.', confidence: 'high' },
            ],
            runs: [],
        }).flatMap((item) => item.annotations);

        expect(ink.length).toBeGreaterThan(0);
        expect(text.some((a) => a.kind === 'text')).toBe(true);
        for (const annotation of [...ink, ...text]) {
            expect(serverAccepts(annotation), JSON.stringify(annotation.payload)).toBe(true);
        }
    });

    it('the mirror refuses what the SQL proof refuses', () => {
        const stroke = { kind: 'stroke' as const, color: '#1f2937' };
        expect(serverAccepts({ ...stroke, payload: { pts: [0.1, 0.1], w: 0.005 } })).toBe(false);
        expect(serverAccepts({ ...stroke, payload: { pts: [0.1, 0.1, 0.5], w: 0 } })).toBe(false);
        expect(serverAccepts({ ...stroke, color: 'red', payload: { pts: [0.1, 0.1, 0.5], w: 0.005 } })).toBe(false);
        expect(
            serverAccepts({ kind: 'text', color: '#1f2937', payload: { x: 5, y: 0.1, text: 'p', size: 0.02 } }),
        ).toBe(false);
    });
});

describe('client writers stay inside the server’s text and coordinate bounds', () => {
    it('the text note editor stops at the server’s length cap', () => {
        const store = { subscribe: () => () => undefined, get: () => undefined } as unknown as AnnotationStore;
        render(
            <TextEditorOverlay
                intent={{ pageIndex: 0, nx: 0.1, ny: 0.1, existing: null }}
                layout={{ top: 0, left: 0, width: 600, height: 800 }}
                view={{ scale: 1, scrollX: 0, scrollY: 0 }}
                store={store}
                onCommit={() => undefined}
                onCancel={() => undefined}
            />,
        );
        expect((screen.getByLabelText('Text note') as HTMLTextAreaElement).maxLength).toBe(MAX_TEXT_CHARS);
    });

    it('clampTextNote cuts to the cap without splitting a surrogate pair', () => {
        expect(clampTextNote('cresc.')).toBe('cresc.');
        expect(clampTextNote('a'.repeat(MAX_TEXT_CHARS + 50))).toHaveLength(MAX_TEXT_CHARS);
        const emoji = `${'a'.repeat(MAX_TEXT_CHARS - 1)}\u{1F3B5}`;
        const cut = clampTextNote(emoji);
        expect(cut).toBe('a'.repeat(MAX_TEXT_CHARS - 1));
        expect(
            serverAccepts({ kind: 'text', color: '#1f2937', payload: { x: 0.1, y: 0.1, text: cut, size: 0.02 } }),
        ).toBe(true);
    });

    it('born-digital marks placed off the page, or overlong, still pass the check', async () => {
        // Viewport at scale 1 on a 600x800 page, PDF y up: (x, y) -> (x, 800 - y).
        const page = {
            getViewport: () => ({
                width: 600,
                height: 800,
                convertToViewportPoint: (x: number, y: number) => [x, 800 - y],
            }),
            getAnnotations: () =>
                Promise.resolve([
                    // Two pages to the right and below the crop box.
                    { subtype: 'FreeText', rect: [1500, -2000, 1600, -1980], contents: 'far away' },
                    { subtype: 'FreeText', rect: [50, 700, 300, 720], contents: 'x'.repeat(MAX_TEXT_CHARS + 10) },
                    // One list wholly off the page, one crossing its edge to a point a page further.
                    {
                        subtype: 'Ink',
                        rect: [0, 0, 600, 800],
                        inkLists: [
                            [
                                [2000, 400],
                                [2100, 420],
                            ],
                            [
                                [550, 400],
                                [1900, 400],
                            ],
                        ],
                    },
                ]),
        } as unknown as PDFPageProxy;

        const { items } = await extractBornDigital(page, 0, 'doc-1');
        const annotations = items.flatMap((item) => item.annotations);
        expect(annotations.filter((a) => a.kind === 'text')).toHaveLength(2);
        expect(annotations.filter((a) => a.kind === 'stroke')).toHaveLength(1);
        for (const annotation of annotations) {
            expect(serverAccepts(annotation), JSON.stringify(annotation.payload).slice(0, 200)).toBe(true);
        }
    });
});
