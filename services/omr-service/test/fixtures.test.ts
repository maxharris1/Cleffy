import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildScoreData } from '../src/buildScoreData.js';
import { parseMxlFiles } from '../src/musicxml.js';
import { parseOmrGeometry } from '../src/omrGeometry.js';

/**
 * End-to-end parser test against REAL Audiveris 5.6.1 artifacts, generated
 * from test/fixtures/tiny.musicxml (rendered by verovio → PDF → Audiveris;
 * see the service README to regenerate). Values below were verified by eye
 * against the engraving. Notable genuine-OMR quirk baked into the fixture:
 * Audiveris reads the metronome mark's quarter glyph as a real G5 note in
 * the pickup, so m. 0 is 960 ticks with 2 notes — the pipeline must stay
 * self-consistent (audio and geometry share the same measure timeline),
 * which is exactly what these assertions check.
 */

const mxl = readFileSync(new URL('./fixtures/tiny.mxl', import.meta.url));
const omr = readFileSync(new URL('./fixtures/tiny.omr', import.meta.url));

describe('fixture pipeline (mxl + omr → ScoreData)', () => {
    const musical = parseMxlFiles([mxl]);
    const geometry = parseOmrGeometry(omr);
    const score = buildScoreData(musical, geometry);

    it('extracts the measure timeline (incl. the pickup and the 3/4 change)', () => {
        expect(score.measures).toHaveLength(15);
        expect(score.measures[0]).toMatchObject({ n: 0, tick: 0, dTicks: 960, page: 0, sys: 0 });
        expect(score.measures[4]).toMatchObject({ n: 4, tick: 6720, dTicks: 1440, page: 0, sys: 1 });
        expect(score.measures[8]).toMatchObject({ n: 8, tick: 12480, page: 1, sys: 2 });
        expect(score.measures[14]).toMatchObject({ n: 14, tick: 21120, dTicks: 1440, page: 1, sys: 3 });
        expect(score.totalTicks).toBe(22560);
        expect(score.timeSignatures).toEqual([
            { tick: 0, num: 4, den: 4 },
            { tick: 6720, num: 3, den: 4 },
        ]);
    });

    it('zips every measure to geometry in reading order, skipping the cautionary stack', () => {
        expect(score.warnings).toEqual([]); // 15 stacks ↔ 15 measures, no mismatch
        for (const [index, measure] of score.measures.entries()) {
            expect(measure.sys, `measure ${index} has geometry`).toBeGreaterThanOrEqual(0);
            expect(measure.x1).toBeGreaterThan(measure.x0);
        }
        // Measures within one system tile left→right without overlap.
        for (let i = 1; i < score.measures.length; i++) {
            const prev = score.measures[i - 1];
            const cur = score.measures[i];
            if (prev && cur && prev.sys === cur.sys) {
                expect(cur.x0).toBeCloseTo(prev.x1, 5);
            }
        }
    });

    it('produces four systems across two pages with sane y-bands', () => {
        expect(score.systems).toHaveLength(4);
        expect(score.systems.map((s) => s.page)).toEqual([0, 0, 1, 1]);
        for (const system of score.systems) {
            expect(system.y1).toBeGreaterThan(system.y0);
            expect(system.y0).toBeGreaterThanOrEqual(0);
            expect(system.y1).toBeLessThanOrEqual(1);
        }
    });

    it('splits hands by staff and merges the tie across the barline', () => {
        expect(score.notes).toHaveLength(54);
        expect(score.notes.filter((n) => n.h === 0)).toHaveLength(32);
        expect(score.notes.filter((n) => n.h === 1)).toHaveLength(22);
        // A5 whole tied to A5 whole = one 3840-tick note.
        expect(score.notes.filter((n) => n.d > 1920)).toEqual([{ t: 2880, d: 3840, p: 81, h: 0 }]);
        // The E5+G5 chord shares one onset.
        const chord = score.notes.filter((n) => n.t === 960 && n.h === 0);
        expect(chord.map((n) => n.p).sort((a, b) => a - b)).toEqual([76, 79]);
    });

    it('found no tempo mark (metronome text needs OCR) → defaultBpm null', () => {
        expect(score.defaultBpm).toBeNull();
    });
});
