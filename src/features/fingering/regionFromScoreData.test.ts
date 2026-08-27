import { describe, expect, it } from 'vitest';

import { regionFromScoreData } from '@/features/fingering/regionFromScoreData';
import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import type { ScoreData } from '@/types/scoreData';

/** System 0 on page 0: measures 0–2 (x 0.08–0.92, y 0.1–0.28). */
const SYS0_RECT = { x: 0.1, y: 0.12, w: 0.8, h: 0.14 };

describe('regionFromScoreData', () => {
    it('maps a contiguous system-0 selection to tick-ordered events with zero bboxes', () => {
        // Cover m0 pickup + m1 (chord at t=480) — leave m2 out via x span.
        const rect = { x: 0.08, y: 0.12, w: 0.5, h: 0.14 };
        const region = regionFromScoreData('doc', 0, rect, tinyScore);
        expect(region).not.toBeNull();
        expect(region!.source).toBe('omr');
        expect(region!.notes.length).toBeGreaterThan(0);
        expect(region!.notes.every((n) => n.bbox.w === 0 && n.bbox.h === 0)).toBe(true);

        // Pickup C5 then the m1 chord (E5+G5 RH, C3 LH) share event groups by tick.
        const byEvent = new Map<number, number[]>();
        for (const n of region!.notes) {
            const group = byEvent.get(n.eventIndex) ?? [];
            group.push(n.midi);
            byEvent.set(n.eventIndex, group);
        }
        const events = [...byEvent.entries()].sort((a, b) => a[0] - b[0]);
        expect(events.map(([i]) => i)).toEqual([...events.keys()].map((_, i) => i));
        expect(events[0]?.[1].sort((a, b) => a - b)).toEqual([72]);
        expect(events[1]?.[1].sort((a, b) => a - b)).toEqual([48, 76, 79]);
    });

    it('orders multi-system selections by tick, not page x', () => {
        // Tall rect covering system 0 and system 1 on page 0.
        const rect = { x: 0.08, y: 0.1, w: 0.84, h: 0.5 };
        const region = regionFromScoreData('doc', 0, rect, tinyScore);
        expect(region).not.toBeNull();
        const eventTicks: number[] = [];
        let prevIndex = -1;
        for (const n of [...region!.notes].sort((a, b) => a.eventIndex - b.eventIndex || a.midi - b.midi)) {
            if (n.eventIndex !== prevIndex) {
                // Reconstruct tick order: eventIndex must be non-decreasing and
                // correspond to ascending ScoreData start ticks.
                eventTicks.push(n.eventIndex);
                prevIndex = n.eventIndex;
            }
        }
        expect(eventTicks).toEqual([...eventTicks].sort((a, b) => a - b));
        // First event is pickup (t=0); a later event includes the sys1 note at t=4320.
        expect(region!.notes.some((n) => n.midi === 72 && n.eventIndex === 0)).toBe(true);
        expect(region!.notes.some((n) => n.midi === 48 && n.eventIndex > 0)).toBe(true);
    });

    it('returns null for an empty intersection (wrong page / y-band)', () => {
        expect(regionFromScoreData('doc', 0, { x: 0.1, y: 0.9, w: 0.2, h: 0.05 }, tinyScore)).toBeNull();
        expect(regionFromScoreData('doc', 9, SYS0_RECT, tinyScore)).toBeNull();
    });

    it('reads a repeated system once instead of falling through to vision', () => {
        // Simulate an unrolled repeat of system 0: measures 0-2 perform twice,
        // the second pass carrying the SAME geometry and srcIndex at later ticks.
        // A marquee is spatial, so it collects both passes.
        const src = tinyScore.measures.slice(0, 3);
        const spanTicks = src[2]!.tick + src[2]!.dTicks - src[0]!.tick;
        const shift = tinyScore.totalTicks;
        const secondPass = src.map((m, i) => ({ ...m, srcIndex: i, tick: m.tick + shift }));
        const repeatedNotes = tinyScore.notes
            .filter((n) => n.t < src[0]!.tick + spanTicks)
            .map((n) => ({ ...n, t: n.t + shift }));
        const score: ScoreData = {
            ...tinyScore,
            measures: [
                ...tinyScore.measures.map((m, i) => ({ ...m, srcIndex: i })),
                ...secondPass,
            ].sort((a, b) => a.tick - b.tick),
            notes: [...tinyScore.notes, ...repeatedNotes].sort((a, b) => a.t - b.t),
            totalTicks: shift + spanTicks,
        };

        const linear = regionFromScoreData('doc', 0, SYS0_RECT, tinyScore);
        const repeated = regionFromScoreData('doc', 0, SYS0_RECT, score);

        // Without the printed-bar dedupe this is null — the tick span would run
        // from the first pass to the second and read as a hole, silently costing
        // the free OMR reading and spending a vision call instead.
        expect(repeated).not.toBeNull();
        // ...and the bar is read ONCE: same notes as the un-repeated score.
        expect(repeated!.notes.length).toBe(linear!.notes.length);
    });

    it('returns null when the score has no_geometry', () => {
        const score: ScoreData = { ...tinyScore, warnings: ['no_geometry'] };
        expect(regionFromScoreData('doc', 0, SYS0_RECT, score)).toBeNull();
    });

    it('returns null on partial coverage (geometry-less measure in the tick span)', () => {
        // Drop geometry from m2 so a full system-0 x-span cannot cover continuously.
        const measures = tinyScore.measures.map((m, i) =>
            i === 2 ? { ...m, page: -1, sys: -1, x0: 0, x1: 0 } : m,
        );
        const score: ScoreData = {
            ...tinyScore,
            measures,
            warnings: ['measure_geometry_mismatch'],
        };
        expect(regionFromScoreData('doc', 0, SYS0_RECT, score)).toBeNull();
    });

    it('returns null when measure_geometry_mismatch leaves a hole inside the span', () => {
        const measures = tinyScore.measures.map((m, i) =>
            i === 1 ? { ...m, page: -1, sys: -1, x0: 0, x1: 0 } : m,
        );
        const score: ScoreData = {
            ...tinyScore,
            measures,
            warnings: ['measure_geometry_mismatch'],
        };
        // Selecting only m0 (narrow) still sees m1 in tick continuity if we expand —
        // a selection overlapping m0+m2 x-ranges fails x-coverage / tick gap.
        const rect = { x: 0.08, y: 0.12, w: 0.84, h: 0.14 };
        expect(regionFromScoreData('doc', 0, rect, score)).toBeNull();
    });

    it('assigns upper/lower staff from hand and defaults spelling to sharps', () => {
        const rect = { x: 0.24, y: 0.12, w: 0.34, h: 0.14 };
        const region = regionFromScoreData('doc', 0, rect, tinyScore);
        expect(region).not.toBeNull();
        const rh = region!.notes.find((n) => n.midi === 76);
        const lh = region!.notes.find((n) => n.midi === 48);
        expect(rh?.staff).toBe('upper');
        expect(lh?.staff).toBe('lower');
        expect(rh?.name).toBe('E5');
        expect(region!.keySignature).toBe(0);
        // v1 ScoreData has no per-staff bands → zero bboxes (apply gated).
        expect(rh?.bbox.w).toBe(0);
    });

    it('synthesizes notehead bboxes when v2 staff bands are present', () => {
        const score: ScoreData = {
            ...tinyScore,
            version: 2,
            systems: tinyScore.systems.map((s) => ({
                ...s,
                staves: [
                    { y0: s.y0 + 0.02, y1: s.y0 + 0.08 },
                    { y0: s.y1 - 0.08, y1: s.y1 - 0.02 },
                ],
            })),
            clefs: [
                { tick: 0, staff: 0, sign: 'G', line: 2 },
                { tick: 0, staff: 1, sign: 'F', line: 4 },
            ],
            keySignatures: [{ tick: 0, fifths: 0 }],
        };
        const rect = { x: 0.24, y: 0.12, w: 0.34, h: 0.14 };
        const region = regionFromScoreData('doc', 0, rect, score);
        expect(region).not.toBeNull();
        const staff = score.systems[0]!.staves![0]!;
        const interline = (staff.y1 - staff.y0) / 4;
        const stepH = interline / 2;
        // Treble lines from bottom: E4 G4 B4 D5 F5. E5 is the top space = 7 diatonic
        // steps above the bottom line (not 8 — F5 is the top line).
        const e5 = region!.notes.find((n) => n.midi === 76);
        expect(e5?.bbox.w).toBeGreaterThan(0);
        const e5Cy = e5!.bbox.y + e5!.bbox.h / 2;
        expect(e5Cy).toBeCloseTo(staff.y1 - 7 * stepH, 5);
        expect(e5Cy).toBeCloseTo(staff.y0 + stepH, 5); // one step below top line
    });

    it('omits LH notes when the marquee only covers the upper staff band', () => {
        const score: ScoreData = {
            ...tinyScore,
            version: 2,
            systems: tinyScore.systems.map((s) => ({
                ...s,
                staves: [
                    { y0: s.y0 + 0.01, y1: s.y0 + 0.07 },
                    { y0: s.y1 - 0.07, y1: s.y1 - 0.01 },
                ],
            })),
            clefs: [
                { tick: 0, staff: 0, sign: 'G', line: 2 },
                { tick: 0, staff: 1, sign: 'F', line: 4 },
            ],
        };
        const upper = score.systems[0]!.staves![0]!;
        const rect = { x: 0.24, y: upper.y0, w: 0.34, h: upper.y1 - upper.y0 };
        const region = regionFromScoreData('doc', 0, rect, score);
        expect(region).not.toBeNull();
        expect(region!.notes.every((n) => n.staff === 'upper')).toBe(true);
        expect(region!.notes.some((n) => n.midi === 48)).toBe(false);
    });
});
