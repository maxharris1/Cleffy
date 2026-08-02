import { describe, expect, it } from 'vitest';

import { parseMusicXmlString } from './musicxml.js';

const wrap = (measures: string, extraParts = ''): string => `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"/><score-part id="P2"/></part-list>
  <part id="P1">${measures}</part>${extraParts}
</score-partwise>`;

const ATTRS_44 = `<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;

const note = (step: string, octave: number, duration: number, extra = ''): string =>
    `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>1</voice>${extra}</note>`;

describe('parseMusicXmlString', () => {
    it('reads tempo from <sound tempo>', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}<direction><sound tempo="72.4"/></direction>${note('C', 4, 16)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.defaultBpm).toBe(72);
    });

    it('reads tempo from <per-minute> when <sound> is absent', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>132</per-minute></metronome></direction-type></direction>${note('C', 4, 16)}</measure>`,
        );
        expect(parseMusicXmlString(xml).defaultBpm).toBe(132);
    });

    it('converts non-quarter <beat-unit> metronome marks to quarter-note BPM', () => {
        const half = wrap(
            `<measure number="1">${ATTRS_44}<direction><direction-type><metronome><beat-unit>half</beat-unit><per-minute>60</per-minute></metronome></direction-type></direction>${note('C', 4, 16)}</measure>`,
        );
        expect(parseMusicXmlString(half).defaultBpm).toBe(120);

        const dotted = wrap(
            `<measure number="1">${ATTRS_44}<direction><direction-type><metronome><beat-unit>half</beat-unit><beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type></direction>${note('C', 4, 16)}</measure>`,
        );
        expect(parseMusicXmlString(dotted).defaultBpm).toBe(180);
    });

    it('pads underfull non-pickup measures to the active time signature', () => {
        // One quarter in 4/4 → pad to 1920 ticks so later bars stay on the grid.
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 4)}</measure><measure number="2">${note('E', 4, 16)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.measures.map((m) => m.dTicks)).toEqual([1920, 1920]);
        expect(score.measures[1]?.tick).toBe(1920);
        expect(score.warnings).toContain('measure_underfull');
    });

    it('extends open ties across underfull padding', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                ${note('C', 4, 4, '<tie type="start"/>')}
                ${note('D', 4, 4)}
                ${note('E', 4, 4)}
            </measure>
            <measure number="2">${note('C', 4, 4, '<tie type="stop"/>')}${note('G', 4, 12)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        // Content was 3 quarters; pad adds 480. Open C4 tie absorbs the pad, then
        // the stop adds one more quarter → 480+480+480 = 1440.
        expect(score.notes.find((n) => n.p === 60)).toMatchObject({ t: 0, d: 1440 });
        expect(score.measures[1]?.tick).toBe(1920);
    });

    it('extends secondary-part open ties when the lead timeline is padded', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 5, 4)}${note('D', 5, 4)}${note('E', 5, 4)}</measure>
             <measure number="2">${note('G', 5, 16)}</measure>`,
            `<part id="P2"><measure number="1">${ATTRS_44}${note('C', 3, 8, '<tie type="start"/>')}</measure>
             <measure number="2">${note('C', 3, 4, '<tie type="stop"/>')}${note('G', 2, 12)}</measure></part>`,
        );
        const score = parseMusicXmlString(xml);
        // Lead m1 underfull (1440→1920). LH half (960) pads by 960 to the
        // timeline, then the stop adds one quarter → 960+960+480 = 2400.
        expect(score.notes.find((n) => n.p === 48 && n.h === 1)).toMatchObject({ t: 0, d: 2400 });
        expect(score.measures[0]?.dTicks).toBe(1920);
    });

    it('keeps pickup (measure 0 / implicit) content length', () => {
        const xml = wrap(
            `<measure number="0" implicit="yes">${ATTRS_44}${note('C', 4, 4)}</measure><measure number="1">${note('E', 4, 16)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.measures[0]).toMatchObject({ n: 0, dTicks: 480 });
        expect(score.measures[1]?.tick).toBe(480);
        expect(score.warnings).not.toContain('measure_underfull');
    });

    it('maps a second single-staff part to the left hand', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 5, 16)}</measure>`,
            `<part id="P2"><measure number="1">${ATTRS_44}${note('C', 2, 16)}</measure></part>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.notes).toEqual([
            { t: 0, d: 1920, p: 72, h: 0 },
            { t: 0, d: 1920, p: 36, h: 1 },
        ]);
        expect(score.warnings).not.toContain('single_staff_all_rh');
    });

    it('flags a lone single-staff part as all right hand', () => {
        const xml = `<?xml version="1.0"?><score-partwise>
            <part-list><score-part id="P1"/></part-list>
            <part id="P1"><measure number="1">${ATTRS_44}${note('C', 4, 16)}</measure></part>
        </score-partwise>`;
        expect(parseMusicXmlString(xml).warnings).toContain('single_staff_all_rh');
    });

    it('applies alter to pitches and skips grace notes with a warning', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <note><grace/><pitch><step>D</step><octave>4</octave></pitch><voice>1</voice></note>
                <note><pitch><step>F</step><octave>4</octave><alter>1</alter></pitch><duration>16</duration><voice>1</voice></note>
            </measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.notes).toEqual([{ t: 0, d: 1920, p: 66, h: 0 }]);
        expect(score.warnings).toContain('grace_notes_skipped');
    });

    it('warns on repeat barlines but keeps a linear timeline', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 16)}<barline location="right"><repeat direction="backward"/></barline></measure>
             <measure number="2">${note('D', 4, 16)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.warnings).toContain('repeats_ignored');
        expect(score.measures.map((m) => m.tick)).toEqual([0, 1920]);
    });

    it('gives an empty measure a full bar of the active signature', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 16)}</measure><measure number="2"></measure><measure number="3">${note('E', 4, 16)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.measures.map((m) => m.tick)).toEqual([0, 1920, 3840]);
    });

    it('offsets everything by tickOffset (movement concatenation)', () => {
        const xml = wrap(`<measure number="1">${ATTRS_44}${note('C', 4, 16)}</measure>`);
        const score = parseMusicXmlString(xml, 10000);
        expect(score.notes[0]?.t).toBe(10000);
        expect(score.measures[0]?.tick).toBe(10000);
        expect(score.totalTicks).toBe(11920);
    });

    it('numbers unnumbered measures sequentially', () => {
        const xml = wrap(`<measure>${ATTRS_44}${note('C', 4, 16)}</measure><measure>${note('D', 4, 16)}</measure>`);
        expect(parseMusicXmlString(xml).measures.map((m) => m.n)).toEqual([1, 2]);
    });
});
