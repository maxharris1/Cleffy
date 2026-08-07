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

/**
 * Sounding duration of an unarticulated note: real playing leaves a little air
 * between notes that are not slurred, so `d` is 90% of the notated value unless
 * a marking says otherwise. Expectations below use this rather than bare
 * constants, so the intent stays legible.
 */
const plain = (notated: number): number => Math.round(notated * 0.9);

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
        // the stop adds one more quarter → 480+480+480 = 1440 notated. A tie chain
        // is gated once, when it closes.
        expect(score.notes.find((n) => n.p === 60)).toMatchObject({ t: 0, d: plain(1440) });
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
        expect(score.notes.find((n) => n.p === 48 && n.h === 1)).toMatchObject({ t: 0, d: plain(2400) });
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
            { t: 0, d: plain(1920), p: 72, h: 0 },
            { t: 0, d: plain(1920), p: 36, h: 1 },
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
            { t: 0, d: plain(1920), p: 60, h: 0 },
            { t: 0, d: plain(1920), p: 48, h: 1 },
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
        expect(parseMusicXmlString(xml).notes).toEqual([{ t: 0, d: plain(1920), p: 66, h: 0 }]);
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
            { t: 370, d: 110, p: 62, h: 0, v: 0.6 }, // acciaccatura — never gated
            { t: 480, d: plain(480), p: 64, h: 0 },
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
            { t: 0, d: plain(480), p: 60, h: 0, v: 0.46 },
            { t: 480, d: plain(480), p: 62, h: 0, v: 0.82 },
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
        expect(parseMusicXmlString(xml).notes).toEqual([{ t: 0, d: plain(3840), p: 72, h: 0 }]);
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
            { t: 0, d: plain(960), p: 72, h: 0 },
            { t: 1920, d: plain(960), p: 72, h: 0 },
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

/**
 * Dynamics. `divisions=4`, so a duration unit is a 16th (120 ticks) and a bar
 * of 4/4 is 1920. Staff 1 is the right hand (h=0), staff 2 the left (h=1).
 */
describe('dynamics resolution', () => {
    const GRAND = `<attributes><divisions>4</divisions><staves>2</staves><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;

    const dyn = (mark: string, staff?: number): string =>
        `<direction><direction-type><dynamics><${mark}/></dynamics></direction-type>${staff ? `<staff>${staff}</staff>` : ''}</direction>`;

    const sn = (step: string, octave: number, duration: number, staff: number, extra = ''): string =>
        `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${duration}</duration><voice>${staff}</voice><staff>${staff}</staff>${extra}</note>`;

    /** Four quarters in the right hand, then a whole note in the left. */
    const twoHandBar = (lead = '', afterBackup = ''): string =>
        `<measure>${lead}${sn('C', 5, 4, 1)}${sn('D', 5, 4, 1)}${sn('E', 5, 4, 1)}${sn('F', 5, 4, 1)}` +
        `<backup><duration>16</duration></backup>${afterBackup}${sn('C', 3, 16, 2)}</measure>`;

    const at = (score: ReturnType<typeof parseMusicXmlString>, hand: 0 | 1, tick: number) =>
        score.notes.filter((n) => n.h === hand && n.t >= tick && n.t < tick + 1920).map((n) => n.v);

    it('does not let the lower staff dynamic govern the next bar of the upper staff', () => {
        // The headline regression: MusicXML writes [staff 1] <backup> [staff 2],
        // so the left hand's mark used to be the last one seen in the bar and
        // silently became the right hand's dynamic from the next bar onward.
        const xml = wrap(
            twoHandBar(`${GRAND}${dyn('f', 1)}`, dyn('p', 2)) + twoHandBar() + twoHandBar(),
        );
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 0)).toEqual([0.82, 0.82, 0.82, 0.82]);
        expect(at(score, 1, 0)).toEqual([0.46]);
        // Bars 2 and 3 carry no marks at all — both hands must hold their own.
        expect(at(score, 0, 1920)).toEqual([0.82, 0.82, 0.82, 0.82]);
        expect(at(score, 1, 1920)).toEqual([0.46]);
        expect(at(score, 0, 3840)).toEqual([0.82, 0.82, 0.82, 0.82]);
        expect(at(score, 1, 3840)).toEqual([0.46]);
    });

    it('applies an unattributed dynamic to both hands', () => {
        const xml = wrap(twoHandBar(`${GRAND}${dyn('ff')}`) + twoHandBar());
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 1920)).toEqual([0.92, 0.92, 0.92, 0.92]);
        expect(at(score, 1, 1920)).toEqual([0.92]);
    });

    it('still reaches the left hand when the writer only ever marks staff 1', () => {
        // Audiveris often attributes every dynamic to the upper staff. That is
        // indistinguishable from a score with one dynamic line, so broadcast —
        // scoping strictly per staff would leave the left hand with nothing.
        const xml = wrap(
            twoHandBar(`${GRAND}${dyn('pp', 1)}`) +
                twoHandBar(dyn('f', 1)) +
                twoHandBar(dyn('p', 1)) +
                twoHandBar(dyn('ff', 1)),
        );
        const score = parseMusicXmlString(xml);
        expect(at(score, 1, 0)).toEqual([0.34]);
        expect(at(score, 1, 1920)).toEqual([0.82]);
        expect(at(score, 1, 5760)).toEqual([0.92]);
        expect(score.warnings).toContain('dynamics_not_staff_split');
    });

    it('does not warn about staff splitting when the writer does distinguish hands', () => {
        const xml = wrap(twoHandBar(`${GRAND}${dyn('f', 1)}`, dyn('p', 2)) + twoHandBar());
        expect(parseMusicXmlString(xml).warnings).not.toContain('dynamics_not_staff_split');
    });

    it('keeps an established left-hand dynamic when a later mark names only staff 1', () => {
        // Independence is sticky: a lone staff-1 ff in bar 3 must not silently
        // overwrite the p the left hand was given in bar 1.
        const xml = wrap(
            twoHandBar(`${GRAND}${dyn('f', 1)}`, dyn('p', 2)) + twoHandBar() + twoHandBar(dyn('ff', 1)),
        );
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 3840)).toEqual([0.92, 0.92, 0.92, 0.92]);
        expect(at(score, 1, 3840)).toEqual([0.46]);
    });

    it('re-unifies both hands on an unattributed dynamic after a split', () => {
        // In a file that attributes when it means to, a mark with no staff is a
        // whole-texture marking and overrides the separation.
        const xml = wrap(
            twoHandBar(`${GRAND}${dyn('f', 1)}`, dyn('p', 2)) + twoHandBar(dyn('pp')) + twoHandBar(),
        );
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 3840)).toEqual([0.34, 0.34, 0.34, 0.34]);
        expect(at(score, 1, 3840)).toEqual([0.34]);
    });

    it('treats cross-staff marks a sixteenth apart as one gesture', () => {
        // The staff-2 mark sits after a backup of 15 units, i.e. 120 ticks into
        // the bar — engraved on the same beat, quantized apart.
        const xml = wrap(
            `<measure>${GRAND}${dyn('f', 1)}${sn('C', 5, 4, 1)}${sn('D', 5, 4, 1)}${sn('E', 5, 4, 1)}${sn('F', 5, 4, 1)}` +
                `<backup><duration>15</duration></backup>${dyn('p', 2)}${sn('C', 3, 12, 2)}</measure>` +
                twoHandBar(),
        );
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 1920)).toEqual([0.82, 0.82, 0.82, 0.82]);
        expect(at(score, 1, 1920)).toEqual([0.46]);
    });

    it('lands an sf-family accent on the staff it names, not the next note in document order', () => {
        // The sfz is attributed to staff 1 but written after the backup, so in
        // document order the next note is a LEFT-hand one. It belongs to the
        // right hand's whole note, which is engraved under it.
        const xml = wrap(
            `<measure>${GRAND}${dyn('p', 1)}${sn('C', 5, 16, 1)}` +
                `<backup><duration>16</duration></backup>${dyn('p', 2)}${dyn('sfz', 1)}` +
                `${sn('C', 3, 4, 2)}${sn('D', 3, 4, 2)}${sn('E', 3, 4, 2)}${sn('F', 3, 4, 2)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 0)).toEqual([0.66]);
        expect(at(score, 1, 0)).toEqual([0.46, 0.46, 0.46, 0.46]);
    });

    it('punches every note of a chord an sfz falls on', () => {
        const xml = wrap(
            `<measure>${GRAND}${dyn('p', 1)}${dyn('sfz', 1)}${sn('C', 5, 8, 1)}` +
                `<note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><staff>1</staff></note>` +
                `<note><chord/><pitch><step>G</step><octave>5</octave></pitch><duration>8</duration><voice>1</voice><staff>1</staff></note>` +
                `${sn('A', 5, 8, 1)}</measure>`,
        );
        const score = parseMusicXmlString(xml);
        expect(at(score, 0, 0)).toEqual([0.66, 0.66, 0.66, 0.46]);
    });

    it('leaves velocity unset when the score prints no dynamics at all', () => {
        const score = parseMusicXmlString(wrap(twoHandBar(GRAND)));
        expect(score.notes.every((n) => n.v === undefined)).toBe(true);
    });

    describe('hairpins', () => {
        const wedge = (type: string, staff?: number, num = 1): string =>
            `<direction><direction-type><wedge type="${type}" number="${num}"/></direction-type>${staff ? `<staff>${staff}</staff>` : ''}</direction>`;

        const words = (text: string, staff?: number): string =>
            `<direction><direction-type><words>${text}</words></direction-type>${staff ? `<staff>${staff}</staff>` : ''}</direction>`;

        /** One 4/4 bar of four right-hand quarters, with hooks before/after. */
        const rhBar = (lead = '', tail = ''): string =>
            `<measure>${lead}${sn('C', 5, 4, 1)}${sn('D', 5, 4, 1)}${sn('E', 5, 4, 1)}${sn('F', 5, 4, 1)}${tail}</measure>`;

        const rh = (score: ReturnType<typeof parseMusicXmlString>) =>
            score.notes.filter((n) => n.h === 0).map((n) => n.v);

        it('interpolates between the dynamic before and the one after', () => {
            const xml = wrap(
                rhBar(`${GRAND}${dyn('p')}${wedge('crescendo')}`, wedge('stop')) + rhBar(dyn('f')),
            );
            const got = rh(parseMusicXmlString(xml));
            expect(got[0]).toBe(0.46); // p, at the wedge start
            expect(got[4]).toBe(0.82); // f, at the wedge end
            // Everything between rises, strictly.
            const middle = got.slice(0, 5) as number[];
            for (let i = 1; i < middle.length; i++) {
                expect(middle[i]!).toBeGreaterThan(middle[i - 1]!);
            }
        });

        it('reads a textual cresc. as a hairpin', () => {
            const xml = wrap(rhBar(`${GRAND}${dyn('p')}${words('cresc.')}`) + rhBar(dyn('f')));
            const got = rh(parseMusicXmlString(xml)) as number[];
            expect(got[0]).toBe(0.46);
            expect(got[1]!).toBeGreaterThan(0.46);
            expect(got[1]!).toBeLessThan(0.82);
        });

        it('reads dim. and decresc. as diminuendos', () => {
            for (const text of ['dim.', 'decresc.', 'morendo']) {
                const xml = wrap(rhBar(`${GRAND}${dyn('f')}${words(text)}`) + rhBar(dyn('pp')));
                const got = rh(parseMusicXmlString(xml)) as number[];
                expect(got[1]!).toBeLessThan(0.82);
            }
        });

        it('is not fooled by ordinary words that merely start similarly', () => {
            const xml = wrap(rhBar(`${GRAND}${dyn('p')}${words('dolce')}`) + rhBar());
            expect(rh(parseMusicXmlString(xml)).every((v) => v === 0.46)).toBe(true);
        });

        it('holds its arrival when no dynamic is printed after the hairpin', () => {
            // Without materialising the target, the note after the wedge would
            // snap back to where the crescendo started.
            const xml = wrap(rhBar(`${GRAND}${dyn('p')}${wedge('crescendo')}`, wedge('stop')) + rhBar());
            const got = rh(parseMusicXmlString(xml)) as number[];
            const arrival = got[4]!;
            expect(arrival).toBeGreaterThan(0.46);
            expect(got.slice(4).every((v) => v === arrival)).toBe(true);
        });

        it('treats a dynamic inside a hairpin as a waypoint', () => {
            const xml = wrap(
                rhBar(`${GRAND}${dyn('p')}${wedge('crescendo')}`) + rhBar(dyn('mf'), wedge('stop')) + rhBar(dyn('f')),
            );
            const got = rh(parseMusicXmlString(xml)) as number[];
            expect(got[0]).toBe(0.46);
            expect(got[4]).toBe(0.7); // mf lands exactly, mid-hairpin
            expect(got[8]).toBe(0.82); // f at the end
            expect(got[2]!).toBeGreaterThan(0.46);
            expect(got[2]!).toBeLessThan(0.7);
        });

        it('does not let a diminuendo fade below ppp', () => {
            const xml = wrap(rhBar(`${GRAND}${dyn('pp')}${wedge('diminuendo')}`, wedge('stop')) + rhBar());
            const got = rh(parseMusicXmlString(xml)) as number[];
            expect(Math.min(...got)).toBeGreaterThanOrEqual(0.26);
        });

        it('gives an unclosed hairpin a musical length rather than the whole piece', () => {
            const bars = Array.from({ length: 20 }, (_, i) =>
                rhBar(i === 0 ? `${GRAND}${dyn('p')}${wedge('crescendo')}` : ''),
            ).join('');
            const got = rh(parseMusicXmlString(wrap(bars))) as number[];
            // Eight bars of four quarters = 32 notes; past that it must be level.
            const tail = got.slice(34);
            expect(new Set(tail).size).toBe(1);
        });

        it('keeps hairpins on the hand they were printed under', () => {
            const xml = wrap(
                twoHandBar(`${GRAND}${dyn('p', 1)}${wedge('crescendo', 1)}`, dyn('p', 2)) +
                    twoHandBar(dyn('f', 1), '') +
                    twoHandBar(),
            );
            const score = parseMusicXmlString(xml);
            // Right hand swells into the f; left hand stays put at p throughout.
            expect(at(score, 0, 1920)).toEqual([0.82, 0.82, 0.82, 0.82]);
            expect(at(score, 1, 0)).toEqual([0.46]);
            expect(at(score, 1, 1920)).toEqual([0.46]);
        });
    });
});

/** Articulation. `divisions=4`, so a quarter is 4 units = 480 ticks. */
describe('articulation', () => {
    const arts = (...marks: string[]): string =>
        `<notations><articulations>${marks.map((m) => `<${m}/>`).join('')}</articulations></notations>`;

    const slur = (type: string): string => `<notations><slur type="${type}" number="1"/></notations>`;

    const oneBar = (notes: string): string => wrap(`<measure number="1">${ATTRS_44}${notes}</measure>`);

    const durs = (xml: string) => parseMusicXmlString(xml).notes.map((n) => n.d);
    const vels = (xml: string) => parseMusicXmlString(xml).notes.map((n) => n.v);

    it('shortens a staccato note without moving anything', () => {
        const score = parseMusicXmlString(
            oneBar(`${note('C', 4, 4, arts('staccato'))}${note('D', 4, 4)}${note('E', 4, 8)}`),
        );
        expect(score.notes.map((n) => n.d)).toEqual([240, plain(480), plain(960)]);
        // The onsets are untouched — gating changes length, never placement.
        expect(score.notes.map((n) => n.t)).toEqual([0, 480, 960]);
    });

    it('applies one gate per marking, never a product', () => {
        const xml = oneBar(
            `${note('C', 4, 4, arts('staccatissimo'))}` +
                `${note('D', 4, 4, arts('staccato'))}` +
                `${note('E', 4, 4, arts('tenuto'))}` +
                `${note('F', 4, 4)}`,
        );
        expect(durs(xml)).toEqual([120, 240, 480, 432]);
    });

    it('treats dots under a slur as portato, not staccato', () => {
        // staccato x slur would be 0.5 x 1.0 or 0.5 — both wrong. Portato is its own row.
        const xml = oneBar(
            `<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice>` +
                `<notations><articulations><staccato/></articulations><slur type="start" number="1"/></notations></note>` +
                `<note><pitch><step>D</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice>` +
                `<notations><slur type="stop" number="1"/></notations></note>`,
        );
        expect(durs(xml)[0]).toBe(336); // 480 * 0.7
    });

    it('does not shorten notes under a slur, but releases the one that ends it', () => {
        const xml = oneBar(
            `${note('C', 4, 4, slur('start'))}${note('D', 4, 4)}${note('E', 4, 4, slur('stop'))}${note('F', 4, 4)}`,
        );
        expect(durs(xml)).toEqual([480, 480, plain(480), plain(480)]);
    });

    it('carries a slur across a barline', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 8, slur('start'))}${note('D', 4, 8)}</measure>` +
                `<measure number="2">${note('E', 4, 8)}${note('F', 4, 8, slur('stop'))}</measure>`,
        );
        expect(durs(xml)).toEqual([960, 960, 960, plain(960)]);
    });

    it('raises velocity for accents without shortening them', () => {
        const xml = oneBar(
            `<direction><direction-type><dynamics><p/></dynamics></direction-type></direction>` +
                `${note('C', 4, 4, arts('accent'))}${note('D', 4, 4, arts('strong-accent'))}${note('E', 4, 8)}`,
        );
        expect(vels(xml)).toEqual([0.61, 0.71, 0.46]);
        expect(durs(xml)).toEqual([plain(480), plain(480), plain(960)]);
    });

    it('takes the larger of a printed accent and an sf direction, not the sum', () => {
        // p + sfz(0.2) and p + accent(0.15) stacked would reach 0.81, well past f.
        const xml = oneBar(
            `<direction><direction-type><dynamics><p/></dynamics></direction-type></direction>` +
                `<direction><direction-type><dynamics><sfz/></dynamics></direction-type></direction>` +
                `${note('C', 4, 4, arts('accent'))}${note('D', 4, 12)}`,
        );
        expect(vels(xml)).toEqual([0.66, 0.46]);
    });

    it('keeps a staccato note audible however short the value', () => {
        const xml = oneBar(`${note('C', 4, 1, arts('staccatissimo'))}${note('D', 4, 15)}`);
        expect(durs(xml)[0]).toBeGreaterThanOrEqual(60);
    });

    it('gives chord members the marking of the note they hang off', () => {
        const xml = oneBar(
            `${note('C', 4, 4, arts('staccato'))}` +
                `<note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>` +
                `<note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>` +
                `${note('B', 4, 12)}`,
        );
        expect(durs(xml)).toEqual([240, 240, 240, plain(1440)]);
    });

    it('gates a tie chain once, from the marking that closes it', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 8, '<tie type="start"/>')}${note('D', 4, 8)}</measure>` +
                `<measure number="2">${note('C', 4, 8, `<tie type="stop"/>${arts('staccato')}`)}${note('E', 4, 8)}</measure>`,
        );
        const held = parseMusicXmlString(xml).notes.find((n) => n.t === 0 && n.p === 60);
        expect(held?.d).toBe(960); // 1920 notated, halved once at the close
    });

    it('ignores a staccato on the first link of a tie chain', () => {
        // Audiveris routinely copies the first note's marking forward; a tie is
        // one sounding event and its release is whatever closes it.
        const xml = wrap(
            `<measure number="1">${ATTRS_44}${note('C', 4, 8, `<tie type="start"/>${arts('staccato')}`)}${note('D', 4, 8)}</measure>` +
                `<measure number="2">${note('C', 4, 8, '<tie type="stop"/>')}${note('E', 4, 8)}</measure>`,
        );
        const held = parseMusicXmlString(xml).notes.find((n) => n.t === 0 && n.p === 60);
        expect(held?.d).toBe(plain(1920));
    });

    it('never gates a grace note', () => {
        const xml = oneBar(
            `<note><rest/><duration>4</duration><voice>1</voice></note>` +
                `<note><grace/><pitch><step>D</step><octave>4</octave></pitch><voice>1</voice></note>` +
                `${note('E', 4, 4, arts('staccato'))}${note('F', 4, 8)}`,
        );
        expect(durs(xml)[0]).toBe(110);
    });
});

/**
 * Meter reconciliation. Ticks: 480/quarter, so 6/8 = 1440 and 9/8 = 2160.
 * `divisions=4` means a duration unit is a 16th, i.e. 120 ticks.
 */
describe('meter reconciliation', () => {
    const ATTRS = (num: number, den: number) =>
        `<attributes><divisions>4</divisions><time><beats>${num}</beats><beat-type>${den}</beat-type></time></attributes>`;

    /** One bar holding `units` sixteenths, as a single chain of quarter-ish notes. */
    const bar = (units: number, first = ''): string =>
        `<measure>${first}<note><pitch><step>C</step><octave>4</octave></pitch><duration>${units}</duration><voice>1</voice></note></measure>`;

    const spanOf = (declaredNum: number, declaredDen: number, lengths: number[]): string =>
        wrap(lengths.map((u, i) => bar(u, i === 0 ? ATTRS(declaredNum, declaredDen) : '')).join(''));

    it('corrects a signature the over-length bars outvote, and re-signs the timeline', () => {
        // 12 bars of true 9/8 (18 sixteenths = 2160 ticks) declared as 6/8.
        const score = parseMusicXmlString(spanOf(6, 8, Array.from({ length: 12 }, () => 18)));
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 9, den: 8 }]);
        expect(score.measures.every((m) => m.dTicks === 2160)).toBe(true);
        expect(score.warnings).toContain('meter_corrected');
        // Corrected bars are exactly full, so they are neither over nor under.
        expect(score.warnings).not.toContain('measure_overfull');
        expect(score.warnings).not.toContain('measure_underfull');
    });

    it('corrects on the real-world mix, where the MODE is the wrong length', () => {
        // Schubert D.780 No. 2 measured: of 94 bars, 49 exceed the declared 1440,
        // 35 sit exactly on it and only 18 reach the true 2160. A modal test would
        // pick 1440 and leave the movement broken; the over-length population is
        // what carries the signal.
        const lengths = [
            ...Array.from({ length: 18 }, () => 18), // 2160 — true 9/8
            ...Array.from({ length: 14 }, () => 14), // 1680 — over, scattered
            ...Array.from({ length: 10 }, () => 16), // 1920 — over, scattered
            ...Array.from({ length: 7 }, () => 17), // 2040 — over, scattered
            ...Array.from({ length: 35 }, () => 12), // 1440 — exactly the declared bar
            ...Array.from({ length: 9 }, () => 10), // 1200 — under-read
        ];
        const score = parseMusicXmlString(spanOf(6, 8, lengths));
        expect(score.warnings).toContain('meter_corrected');
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 9, den: 8 }]);
    });

    it('leaves a genuine signature alone when its bars agree', () => {
        const score = parseMusicXmlString(spanOf(6, 8, Array.from({ length: 12 }, () => 12)));
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 6, den: 8 }]);
        expect(score.warnings).not.toContain('meter_corrected');
        expect(score.warnings).not.toContain('meter_suspect');
    });

    it('is not fooled by a handful of overfull misreads', () => {
        const lengths = [...Array.from({ length: 30 }, () => 12), ...Array.from({ length: 4 }, () => 18)];
        const score = parseMusicXmlString(spanOf(6, 8, lengths));
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 6, den: 8 }]);
        expect(score.warnings).not.toContain('meter_corrected');
    });

    it('warns but does not act when the disagreement is not a simple misread', () => {
        // 1800 vs 1440 is 5:4 — not a ratio a signature misread produces.
        const score = parseMusicXmlString(spanOf(6, 8, Array.from({ length: 12 }, () => 15)));
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 6, den: 8 }]);
        expect(score.warnings).toContain('meter_suspect');
        expect(score.warnings).not.toContain('meter_corrected');
    });

    it('warns but does not act when the over-length bars do not cluster', () => {
        const score = parseMusicXmlString(spanOf(6, 8, [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]));
        expect(score.warnings).toContain('meter_suspect');
        expect(score.warnings).not.toContain('meter_corrected');
    });

    it('does not correct a span too short to judge', () => {
        const score = parseMusicXmlString(spanOf(6, 8, [18, 18, 18, 18, 18]));
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 6, den: 8 }]);
        expect(score.warnings).not.toContain('meter_corrected');
    });

    it('reads 4/4 misdeclared as 2/4', () => {
        const score = parseMusicXmlString(spanOf(2, 4, Array.from({ length: 12 }, () => 16)));
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 4, den: 4 }]);
        expect(score.warnings).toContain('meter_corrected');
    });

    it('judges each meter span separately', () => {
        // 10 genuine 3/4 bars, then a change to 6/8 whose bars are really 9/8.
        const first = Array.from({ length: 10 }, (_, i) => bar(12, i === 0 ? ATTRS(3, 4) : '')).join('');
        const second = Array.from({ length: 12 }, (_, i) => bar(18, i === 0 ? ATTRS(6, 8) : '')).join('');
        const score = parseMusicXmlString(wrap(first + second));
        expect(score.timeSignatures).toEqual([
            { tick: 0, num: 3, den: 4 },
            { tick: 14400, num: 9, den: 8 },
        ]);
        expect(score.measures.slice(0, 10).every((m) => m.dTicks === 1440)).toBe(true);
        expect(score.measures.slice(10).every((m) => m.dTicks === 2160)).toBe(true);
    });

    it('excludes pickups and the final bar from the vote', () => {
        // 12 full 6/8 bars, a short pickup at the front and a short final bar.
        // Neither should drag the span toward a correction.
        const lengths = Array.from({ length: 12 }, () => 12);
        const inner = lengths.map((u, i) => bar(u, i === 0 ? ATTRS(6, 8) : '')).join('');
        const xml = wrap(
            `<measure number="0" implicit="yes">${ATTRS(6, 8)}<note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note></measure>` +
                inner +
                bar(4),
        );
        const score = parseMusicXmlString(xml);
        expect(score.timeSignatures).toEqual([{ tick: 0, num: 6, den: 8 }]);
        expect(score.warnings).not.toContain('meter_corrected');
        expect(score.measures[0]?.dTicks).toBe(480); // pickup keeps its real length
    });
});
