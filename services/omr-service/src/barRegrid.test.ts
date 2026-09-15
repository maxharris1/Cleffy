import { describe, expect, it } from 'vitest';

import { parseMusicXmlString } from './musicxml.js';

const wrap = (measures: string): string => `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"/></part-list>
  <part id="P1">${measures}</part>
</score-partwise>`;

/** divisions=4 → a quarter is 4, a sixteenth is 1; ticks are ×120. A 2/4 bar is 8. */
const ATTRS_24 = `<attributes><divisions>4</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>`;
const ATTRS_44 = `<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;

interface NoteOpts {
    type?: string;
    dots?: number;
    beam?: string;
    voice?: number;
    stem?: 'up' | 'down';
    tie?: 'start' | 'stop';
}

const note = (step: string, octave: number, duration: number, x: number, opts: NoteOpts = {}): string =>
    `<note default-x="${x}">` +
    `<pitch><step>${step}</step><octave>${octave}</octave></pitch>` +
    `<duration>${duration}</duration>` +
    (opts.tie ? `<tie type="${opts.tie}"/>` : '') +
    `<voice>${opts.voice ?? 1}</voice>` +
    (opts.type ? `<type>${opts.type}</type>` : '') +
    '<dot/>'.repeat(opts.dots ?? 0) +
    (opts.stem ? `<stem>${opts.stem}</stem>` : '') +
    (opts.beam ? `<beam number="1">${opts.beam}</beam>` : '') +
    (opts.tie ? `<notations><tied type="${opts.tie}"/></notations>` : '') +
    `</note>`;

const rest = (duration: number, x: number, voice = 1): string =>
    `<note default-x="${x}"><rest/><duration>${duration}</duration><voice>${voice}</voice></note>`;

const backup = (duration: number): string => `<backup><duration>${duration}</duration></backup>`;
const forward = (duration: number): string => `<forward><duration>${duration}</duration></forward>`;

const plain = (notated: number): number => Math.round(notated * 0.9);

const onsetsIn = (score: ReturnType<typeof parseMusicXmlString>, measure: number): number[] => {
    const m = score.measures[measure];
    if (!m) {
        return [];
    }
    return [...new Set(score.notes.filter((n) => n.t >= m.tick && n.t < m.tick + m.dTicks).map((n) => n.t - m.tick))];
};

/**
 * The upper line of a WTC-prelude bar: an eighth rest and six sixteenths,
 * printed at x = 10, 50, 70, 90, 110, 130, 150 — one 2/4 bar.
 */
const upperLine =
    rest(2, 10) +
    note('G', 4, 1, 50, { type: '16th', stem: 'up', beam: 'begin' }) +
    note('C', 5, 1, 70, { type: '16th', stem: 'up', beam: 'end' }) +
    note('E', 5, 1, 90, { type: '16th', stem: 'up', beam: 'begin' }) +
    note('G', 4, 1, 110, { type: '16th', stem: 'up', beam: 'continue' }) +
    note('C', 5, 1, 130, { type: '16th', stem: 'up', beam: 'continue' }) +
    note('E', 5, 1, 150, { type: '16th', stem: 'up', beam: 'end' });

describe('bar regrid', () => {
    it('rebuilds a bar whose writer ran two printed voices into one', () => {
        // The page prints three voices: the line above, a sustained C under it,
        // and an inner E entering a sixteenth in and held. The writer threaded
        // the C and the E into one <voice>, so the E starts after the C ENDS and
        // the bar runs to 15 sixteenths of 8. Every head is positioned, and the
        // stem flip is where the two printed voices were joined.
        const merged =
            note('C', 4, 8, 12, { type: 'half', stem: 'down', voice: 5 }) +
            note('E', 4, 3, 30, { type: 'eighth', dots: 1, stem: 'up', tie: 'start', voice: 5 }) +
            note('E', 4, 4, 90, { type: 'quarter', stem: 'up', tie: 'stop', voice: 5 });
        const inner = rest(1, 11, 2);
        const score = parseMusicXmlString(
            wrap(`<measure number="1">${ATTRS_24}${upperLine}${backup(8)}${inner}${backup(1)}${merged}</measure>`),
        );

        expect(score.warnings).toContain('bar_regridded');
        expect(score.warnings).not.toContain('measure_overfull');
        expect(score.measures[0]?.dTicks).toBe(960);
        expect(onsetsIn(score, 0)).toEqual([0, 120, 240, 360, 480, 600, 720, 840]);
        // The sustained C keeps its printed length and starts the bar.
        expect(score.notes.find((n) => n.p === 60)).toMatchObject({ t: 0, d: plain(960) });
        // The tied inner E enters one sixteenth in and holds to the barline.
        expect(score.notes.find((n) => n.p === 64)).toMatchObject({ t: 120, d: plain(840) });
    });

    it('closes the gap a tie shows was a dot the engine did not see', () => {
        // Same page, but the writer threaded the voices correctly and read the
        // inner voice's dotted eighth as a plain eighth. Its quarter is printed
        // at x=90, in the column the upper line attacks on the second beat, so
        // the page puts it a sixteenth later than the writer did — and the tie
        // says the eighth before it must reach that far.
        const innerVoice =
            rest(1, 11, 5) +
            note('E', 4, 2, 30, { type: 'eighth', stem: 'up', tie: 'start', voice: 5 }) +
            note('E', 4, 4, 90, { type: 'quarter', stem: 'up', tie: 'stop', voice: 5 });
        const bass = note('C', 4, 8, 12, { type: 'half', stem: 'down', voice: 6 });
        const score = parseMusicXmlString(
            wrap(`<measure number="1">${ATTRS_24}${upperLine}${backup(8)}${innerVoice}${backup(7)}${bass}</measure>`),
        );

        expect(score.warnings).toContain('bar_regridded');
        expect(score.measures[0]?.dTicks).toBe(960);
        expect(onsetsIn(score, 0)).toEqual([0, 120, 240, 360, 480, 600, 720, 840]);
        expect(score.notes.find((n) => n.p === 64)).toMatchObject({ t: 120, d: plain(840) });
    });

    it('leaves a bar alone when the page does not pin the onsets', () => {
        // A whole note under a quarter the writer entered a bar and a beat late.
        // The bar is overfull, but the quarter's own column could sit on any of
        // three beats and nothing printed picks one, so the bar is left as read.
        const score = parseMusicXmlString(
            wrap(
                `<measure number="1">${ATTRS_44}` +
                    note('C', 4, 16, 10, { type: 'whole', stem: 'down' }) +
                    backup(16) +
                    forward(20) +
                    note('G', 4, 4, 200, { type: 'quarter', stem: 'up', voice: 2 }) +
                    `</measure>`,
            ),
        );

        expect(score.warnings).not.toContain('bar_regridded');
        expect(onsetsIn(score, 0)).toEqual([0, 2400]);
    });

    it('does not touch a bar whose onsets already agree with the page', () => {
        const score = parseMusicXmlString(
            wrap(
                `<measure number="1">${ATTRS_24}${upperLine}${backup(8)}` +
                    note('C', 4, 8, 12, { type: 'half', stem: 'down', voice: 5 }) +
                    `</measure>`,
            ),
        );

        expect(score.warnings).not.toContain('bar_regridded');
        expect(score.measures[0]?.dTicks).toBe(960);
        expect(onsetsIn(score, 0)).toEqual([0, 240, 360, 480, 600, 720, 840]);
    });
});

describe('rhythm repair extent', () => {
    it('refuses a rest that would fill a voice out past the barline', () => {
        // A whole note fills the bar; a second voice enters on beat 2 with a
        // beamed pair and stops. Its sum is short by three beats, but it has
        // already released ON beat 3 — adding the rest would carry the bar to
        // seven beats. (No default-x anywhere, so the regrid never looks.)
        const score = parseMusicXmlString(
            wrap(
                `<measure number="1">${ATTRS_44}` +
                    `<note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note>` +
                    backup(16) +
                    forward(4) +
                    `<note><pitch><step>G</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>eighth</type><beam number="1">begin</beam></note>` +
                    `<note><pitch><step>A</step><octave>3</octave></pitch><duration>2</duration><voice>2</voice><type>eighth</type><beam number="1">end</beam></note>` +
                    `</measure>` +
                    `<measure number="2"><note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type></note></measure>`,
            ),
        );

        expect(score.rhythmRepairs).toBe(0);
        expect(score.measures[0]?.dTicks).toBe(1920);
        expect(onsetsIn(score, 0)).toEqual([0, 480, 720]);
    });
});
