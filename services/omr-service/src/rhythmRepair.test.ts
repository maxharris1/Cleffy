import { describe, expect, it } from 'vitest';

import { parseMusicXmlString } from './musicxml.js';

const wrap = (measures: string): string => `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"/></part-list>
  <part id="P1">${measures}</part>
</score-partwise>`;

/** divisions=4 → a quarter is 4, a sixteenth is 1; ticks are ×120. */
const ATTRS_44 = `<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;

const note = (
    step: string,
    octave: number,
    duration: number,
    opts: { type?: string; dots?: number; beam?: string; chord?: boolean; voice?: number } = {},
): string =>
    `<note>${opts.chord ? '<chord/>' : ''}<pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>${opts.voice ?? 1}</voice>${opts.type ? `<type>${opts.type}</type>` : ''}${'<dot/>'.repeat(opts.dots ?? 0)}${opts.beam ? `<beam number="1">${opts.beam}</beam>` : ''}</note>`;
const rest = (duration: number, voice = 1): string =>
    `<note><rest/><duration>${duration}</duration><voice>${voice}</voice></note>`;
const bar = (n: number, inner: string): string => `<measure number="${n}">${n === 1 ? ATTRS_44 : ''}${inner}</measure>`;

const plain = (notated: number): number => Math.round(notated * 0.9);

const onsetsIn = (score: ReturnType<typeof parseMusicXmlString>, measure: number): number[] => {
    const m = score.measures[measure];
    if (!m) {
        return [];
    }
    return [...new Set(score.notes.filter((n) => n.t >= m.tick && n.t < m.tick + m.dTicks).map((n) => n.t - m.tick))];
};

describe('rhythm repair', () => {
    it('puts back a dot the neighbouring bar shows was there', () => {
        // Bar 1: dotted quarter, eighth, half. Bar 2: the same figure with the
        // dot lost — quarter, eighth, half sums to 1680 of 1920.
        const figure = (dots: number) =>
            `${note('C', 5, dots ? 6 : 4, { type: 'quarter', dots })}${note('D', 5, 2, { type: 'eighth' })}${note('E', 5, 8, { type: 'half' })}`;
        const score = parseMusicXmlString(wrap(bar(1, figure(1)) + bar(2, figure(0))));

        expect(score.warnings).toContain('rhythm_repaired');
        expect(score.warnings).not.toContain('measure_underfull');
        expect(score.rhythmRepairs).toBe(1);
        expect(onsetsIn(score, 1)).toEqual([0, 720, 960]);
        const repaired = score.notes.find((n) => n.t === 1920);
        expect(repaired).toMatchObject({ p: 72, d: plain(720) });
        expect(score.measures[1]).toMatchObject({ tick: 1920, dTicks: 1920 });
    });

    it('halves a note whose flag was missed when that squares up its beam group', () => {
        // Four beamed sixteenths, the second read as an eighth: the group runs
        // 600 ticks instead of a beat, and the bar 2040 instead of 1920.
        const group =
            note('C', 5, 1, { type: '16th', beam: 'begin' }) +
            note('D', 5, 2, { type: 'eighth', beam: 'continue' }) +
            note('E', 5, 1, { type: '16th', beam: 'continue' }) +
            note('F', 5, 1, { type: '16th', beam: 'end' });
        const tail =
            note('G', 5, 4, { type: 'quarter' }) +
            note('A', 5, 4, { type: 'quarter' }) +
            note('B', 5, 4, { type: 'quarter' });
        const score = parseMusicXmlString(wrap(bar(1, group + tail)));

        expect(score.warnings).toContain('rhythm_repaired');
        expect(score.warnings).not.toContain('measure_overfull');
        expect(onsetsIn(score, 0)).toEqual([0, 120, 240, 360, 480, 960, 1440]);
        expect(score.notes.find((n) => n.p === 74)).toMatchObject({ t: 120, d: plain(120) });
        expect(score.totalTicks).toBe(1920);
    });

    it('deletes a rest that was read twice, moving the chord after it back into place', () => {
        // Bar 1 is whole: two quarters, a quarter rest, a chord. Bar 2 has the
        // rest twice; the chord lands on beat 5 of a four-beat bar.
        const chord = note('C', 4, 4, { type: 'quarter' }) + note('E', 4, 4, { type: 'quarter', chord: true });
        const whole = note('G', 4, 4) + note('A', 4, 4) + rest(4) + chord;
        const doubled = note('G', 4, 4) + note('A', 4, 4) + rest(4) + rest(4) + chord;
        const score = parseMusicXmlString(wrap(bar(1, whole) + bar(2, doubled)));

        expect(score.warnings).toContain('rhythm_repaired');
        expect(score.warnings).not.toContain('measure_overfull');
        expect(onsetsIn(score, 1)).toEqual([0, 480, 1440]);
        expect(score.notes.filter((n) => n.t === 1920 + 1440).map((n) => n.p)).toEqual([60, 64]);
        expect(score.measures[1]?.dTicks).toBe(1920);
    });

    it('adds the trailing rest a repeated figure shows was lost', () => {
        // Bar 1: three quarters and a quarter rest. Bar 2: the rest is gone.
        const score = parseMusicXmlString(
            wrap(
                bar(1, note('C', 4, 4) + note('D', 4, 4) + note('E', 4, 4) + rest(4)) +
                    bar(2, note('C', 4, 4) + note('D', 4, 4) + note('E', 4, 4)),
            ),
        );
        expect(score.warnings).toContain('rhythm_repaired');
        expect(score.warnings).not.toContain('measure_underfull');
        expect(score.measures.map((m) => m.dTicks)).toEqual([1920, 1920]);
    });

    it('leaves a bar it has no evidence for to the padder', () => {
        // Three quarters in 4/4 with an unrelated neighbour: doubling any of them
        // would make the sum exact, but nothing says which — so nothing moves.
        const score = parseMusicXmlString(
            wrap(bar(1, note('C', 4, 4) + note('D', 4, 4) + note('E', 4, 4)) + bar(2, note('G', 4, 16))),
        );
        expect(score.warnings).not.toContain('rhythm_repaired');
        expect(score.warnings).toContain('measure_underfull');
        expect(score.rhythmRepairs).toBe(0);
        expect(onsetsIn(score, 0)).toEqual([0, 480, 960]);
    });

    it('does not touch an unbeamed note on beam evidence alone', () => {
        // A lone quarter that could become a dotted quarter to fill the bar; with
        // no beam group and no matching neighbour, the padder handles it.
        const score = parseMusicXmlString(
            wrap(
                bar(1, note('C', 4, 4, { type: 'quarter' }) + note('D', 4, 2) + note('E', 4, 8)) +
                    bar(2, note('G', 4, 16)),
            ),
        );
        expect(score.warnings).not.toContain('rhythm_repaired');
        expect(score.warnings).toContain('measure_underfull');
    });

    it('repairs at most one voice edit per bar and leaves a whole second voice alone', () => {
        // Voice 1 lost a dot (figure repeats in bar 1); voice 2 is exact in both bars.
        const v1 = (dots: number) =>
            `${note('C', 5, dots ? 6 : 4, { type: 'quarter', dots })}${note('D', 5, 2, { type: 'eighth' })}${note('E', 5, 8, { type: 'half' })}`;
        const v2 = `<backup><duration>16</duration></backup>${note('C', 3, 8, { type: 'half', voice: 2 })}${note('G', 3, 8, { type: 'half', voice: 2 })}`;
        const score = parseMusicXmlString(
            wrap(
                bar(1, v1(1) + v2) +
                    bar(
                        2,
                        v1(0) +
                            `<backup><duration>14</duration></backup>${note('C', 3, 8, { type: 'half', voice: 2 })}${note('G', 3, 8, { type: 'half', voice: 2 })}`,
                    ),
            ),
        );

        expect(score.rhythmRepairs).toBe(1);
        expect(score.notes.filter((n) => n.t >= 1920 && n.p < 60).map((n) => n.t - 1920)).toEqual([0, 960]);
        expect(score.notes.filter((n) => n.t >= 1920 && n.p >= 60).map((n) => n.t - 1920)).toEqual([0, 720, 960]);
    });
});
