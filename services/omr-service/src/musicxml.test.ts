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

    it('converts dotted-quarter and eighth beat units too', () => {
        const mark = (unit: string, dots: number, perMinute: number) =>
            wrap(
                `<measure number="1">${ATTRS_44}<direction><direction-type><metronome><beat-unit>${unit}</beat-unit>${'<beat-unit-dot/>'.repeat(dots)}<per-minute>${perMinute}</per-minute></metronome></direction-type></direction>${note('C', 4, 16)}</measure>`,
            );
        expect(parseMusicXmlString(mark('quarter', 1, 60)).defaultBpm).toBe(90); // dotted-quarter = 60 (6/8 feel)
        expect(parseMusicXmlString(mark('eighth', 0, 120)).defaultBpm).toBe(60); // eighth = 120
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

    it('prefers a later Piano grand staff over sparse Voice dummy parts', () => {
        // Audiveris often emits Voice/Voice before Piano; document order must not win.
        const voiceMeasure = (id: string, step: string, octave: number) =>
            `<part id="${id}"><measure number="1">${ATTRS_44}${note(step, octave, 16)}</measure>
             <measure number="2">${ATTRS_44}<note><rest/><duration>16</duration><voice>1</voice></note></measure></part>`;
        const pianoAttrs = `<attributes><divisions>4</divisions><staves>2</staves><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;
        const xml = `<?xml version="1.0"?>
          <score-partwise version="4.0">
            <part-list>
              <score-part id="P1"><part-name>Voice</part-name></score-part>
              <score-part id="P2"><part-name>Voice</part-name></score-part>
              <score-part id="P3"><part-name>Piano</part-name></score-part>
            </part-list>
            ${voiceMeasure('P1', 'G', 4)}
            ${voiceMeasure('P2', 'E', 4)}
            <part id="P3">
              <measure number="1">${pianoAttrs}
                ${note('C', 5, 8, '<staff>1</staff>')}
                ${note('E', 5, 8, '<staff>1</staff>')}
                ${note('C', 3, 16, '<staff>2</staff>')}
              </measure>
              <measure number="2">${pianoAttrs}
                ${note('D', 5, 16, '<staff>1</staff>')}
                ${note('G', 2, 16, '<staff>2</staff>')}
              </measure>
            </part>
          </score-partwise>`;
        const score = parseMusicXmlString(xml);
        expect(score.warnings).toContain('multi_part_collapsed');
        expect(score.notes.map((n) => n.p).sort((a, b) => a - b)).toEqual([43, 48, 72, 74, 76]);
        expect(score.notes.some((n) => n.h === 1)).toBe(true);
        // Voice pitches (G4=67, E4=64) must not appear.
        expect(score.notes.every((n) => n.p !== 67 && n.p !== 64)).toBe(true);
        expect(score.measures).toHaveLength(2);
    });

    it('keeps Piano alone when a denser vocal line is listed first (art song)', () => {
        const xml = `<?xml version="1.0"?>
          <score-partwise version="4.0">
            <part-list>
              <score-part id="P1"><part-name>Voice</part-name></score-part>
              <score-part id="P2"><part-name>Piano</part-name></score-part>
            </part-list>
            <part id="P1"><measure number="1">${ATTRS_44}
              ${note('A', 4, 4)}${note('B', 4, 4)}${note('C', 5, 4)}${note('D', 5, 4)}
            </measure></part>
            <part id="P2"><measure number="1">
              <attributes><divisions>4</divisions><staves>2</staves>
                <time><beats>4</beats><beat-type>4</beat-type></time>
              </attributes>
              ${note('C', 4, 16, '<staff>1</staff>')}
              <backup><duration>16</duration></backup>
              ${note('C', 3, 16, '<staff>2</staff>')}
            </measure></part>
          </score-partwise>`;
        const score = parseMusicXmlString(xml);
        expect(score.warnings).toContain('multi_part_collapsed');
        expect(score.notes).toEqual([
            { t: 0, d: 1920, p: 60, h: 0 },
            { t: 0, d: 1920, p: 48, h: 1 },
        ]);
    });

    it('flags a lone single-staff part as all right hand', () => {
        const xml = `<?xml version="1.0"?><score-partwise>
            <part-list><score-part id="P1"/></part-list>
            <part id="P1"><measure number="1">${ATTRS_44}${note('C', 4, 16)}</measure></part>
        </score-partwise>`;
        expect(parseMusicXmlString(xml).warnings).toContain('single_staff_all_rh');
    });

    it('applies alter to pitches', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <note><pitch><step>F</step><octave>4</octave><alter>1</alter></pitch><duration>16</duration><voice>1</voice></note>
            </measure>`,
        );
        expect(parseMusicXmlString(xml).notes).toEqual([{ t: 0, d: 1920, p: 66, h: 0 }]);
    });

    it('plays grace notes as crushed attacks stealing time before their principal', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <note><rest/><duration>4</duration><voice>1</voice></note>
                <note><grace/><pitch><step>D</step><octave>4</octave></pitch><voice>1</voice></note>
                <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
                <note><rest/><duration>8</duration><voice>1</voice></note>
            </measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.notes).toEqual([
            { t: 370, d: 110, p: 62, h: 0, v: 0.58 }, // acciaccatura, just before the beat
            { t: 480, d: 480, p: 64, h: 0 },
        ]);
        expect(score.warnings).not.toContain('grace_notes_skipped');
    });

    it('shapes velocities from printed dynamics', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <direction><direction-type><dynamics><p/></dynamics></direction-type></direction>
                ${note('C', 4, 4)}
                <direction><direction-type><dynamics><f/></dynamics></direction-type></direction>
                ${note('D', 4, 4)}
                <note><rest/><duration>8</duration><voice>1</voice></note>
            </measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(score.notes).toEqual([
            { t: 0, d: 480, p: 60, h: 0, v: 0.46 },
            { t: 480, d: 480, p: 62, h: 0, v: 0.82 },
        ]);
    });

    it('sforzando punches a single attack — shared by its whole chord', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <direction><direction-type><dynamics><mf/></dynamics></direction-type></direction>
                ${note('C', 4, 4)}
                <direction><direction-type><dynamics><sfz/></dynamics></direction-type></direction>
                <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
                <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
                ${note('F', 4, 8)}
            </measure>`,
        );
        const velocities = parseMusicXmlString(xml).notes.map((n) => n.v);
        expect(velocities).toEqual([0.7, 0.9, 0.9, 0.7]); // mf, sfz chord (both), back to mf
    });

    it('merges a tie whose stop was renumbered into another voice (system break)', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><tie type="start"/></note>
            </measure>
            <measure number="2">
                <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>3</voice><tie type="stop"/></note>
            </measure>`,
        );
        expect(parseMusicXmlString(xml).notes).toEqual([{ t: 0, d: 3840, p: 72, h: 0 }]);
    });

    it('refuses to merge a "tie" whose halves are not rhythmically adjacent', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}
                <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><tie type="start"/></note>
                <note><rest/><duration>8</duration><voice>1</voice></note>
            </measure>
            <measure number="2">
                <note><pitch><step>C</step><octave>5</octave></pitch><duration>8</duration><voice>2</voice><tie type="stop"/></note>
                <note><rest/><duration>8</duration><voice>2</voice></note>
            </measure>`,
        );
        // The open half ends at 960 but the "stop" starts at 1920 — two notes.
        expect(parseMusicXmlString(xml).notes).toEqual([
            { t: 0, d: 960, p: 72, h: 0 },
            { t: 1920, d: 960, p: 72, h: 0 },
        ]);
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
