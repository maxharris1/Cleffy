import { describe, expect, it } from 'vitest';

import { keyAlter } from './keyRepair.js';
import { parseMusicXmlString } from './musicxml.js';

const wrap = (measures: string, extraParts = '', partList = '<score-part id="P1"/>'): string =>
    `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list>${partList}</part-list>
  <part id="P1">${measures}</part>${extraParts}
</score-partwise>`;

const ATTRS = (fifths: number, extra = ''): string =>
    `<attributes><divisions>4</divisions><key><fifths>${fifths}</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>${extra}</attributes>`;

const note = (
    step: string,
    octave: number,
    duration: number,
    staff: number,
    extra: { alter?: number; accidental?: string; type?: string; beam?: string } = {},
): string => {
    const alter = extra.alter !== undefined ? `<alter>${extra.alter}</alter>` : '';
    const acc = extra.accidental ? `<accidental>${extra.accidental}</accidental>` : '';
    const type = extra.type ? `<type>${extra.type}</type>` : '';
    const beam = extra.beam ? `<beam number="1">${extra.beam}</beam>` : '';
    return `<note><pitch><step>${step}</step>${alter}<octave>${octave}</octave></pitch><duration>${duration}</duration><voice>${staff}</voice>${type}${acc}${beam}<staff>${staff}</staff></note>`;
};

const closing = (n: number): string =>
    `<measure number="${n}">${note('C', 4, 16, 1)}${`<backup><duration>16</duration></backup>`}${note('C', 2, 16, 2)}</measure>`;

describe('keyAlter', () => {
    it('puts sharps on F C G D for four sharps, and nothing on E', () => {
        expect(keyAlter(3, 4)).toBe(1); // F
        expect(keyAlter(0, 4)).toBe(1); // C
        expect(keyAlter(4, 4)).toBe(1); // G
        expect(keyAlter(1, 4)).toBe(1); // D
        expect(keyAlter(2, 4)).toBe(0); // E
        expect(keyAlter(6, -1)).toBe(-1); // Bb
        expect(keyAlter(0, 0)).toBe(0);
    });
});

describe('key-signature repair', () => {
    it('drops a single-staff key and restores the G♯ pedal it flattened', () => {
        // m.2: staff 2 is read as C major, so the G♯ pedal is a G natural.
        const xml = wrap(
            `<measure number="1">${ATTRS(4)}${note('C', 4, 16, 1, { alter: 1 })}<backup><duration>16</duration></backup>${note('G', 2, 16, 2, { alter: 1 })}</measure>` +
                `<measure number="2"><attributes><key number="2"><fifths>0</fifths></key></attributes>${note('C', 4, 16, 1, { alter: 1 })}<backup><duration>16</duration></backup>${note('G', 2, 16, 2)}</measure>` +
                `<measure number="3">${note('C', 4, 16, 1, { alter: 1 })}<backup><duration>16</duration></backup>${note('G', 2, 16, 2)}</measure>` +
                closing(4),
        );
        const score = parseMusicXmlString(xml);
        expect(score.warnings).toContain('key_signature_repaired');
        expect(score.keySignatures).toEqual([{ tick: 0, fifths: 4 }]);
        // G2 = 43, G♯2 = 44. The pedal in bars 2 and 3 must be sharp again.
        // No later kept key, so respell continues through the closing bar: that
        // C2 is under four sharps and is not part of the pedal assertion.
        const pedal = score.notes.filter((n) => n.h === 1 && n.t < 3 * 1920);
        expect(pedal.map((n) => n.p)).toEqual([44, 44, 44]);
        expect(score.keyRepairs).toBeGreaterThan(0);
    });

    it('stops respelling at a later kept both-staff key, not at the part end', () => {
        // Staff-2 C major in bar 2 is a misread (drop, restore G♯). Bar 3 is a
        // genuine whole-part C major that does not snap back. Bar 4's C2 must
        // stay C2 — four-sharps respell through the part end would make it C♯.
        const xml = wrap(
            `<measure number="1">${ATTRS(4)}${note('C', 4, 16, 1, { alter: 1 })}<backup><duration>16</duration></backup>${note('G', 2, 16, 2, { alter: 1 })}</measure>` +
                `<measure number="2"><attributes><key number="2"><fifths>0</fifths></key></attributes>${note('C', 4, 16, 1, { alter: 1 })}<backup><duration>16</duration></backup>${note('G', 2, 16, 2)}</measure>` +
                `<measure number="3"><print new-system="yes"/><attributes><key><fifths>0</fifths></key></attributes>${note('C', 4, 16, 1)}<backup><duration>16</duration></backup>${note('C', 2, 16, 2)}</measure>` +
                `<measure number="4">${note('C', 4, 16, 1)}<backup><duration>16</duration></backup>${note('C', 2, 16, 2)}</measure>` +
                `<measure number="5">${note('C', 4, 16, 1)}<backup><duration>16</duration></backup>${note('C', 2, 16, 2)}</measure>` +
                `<measure number="6">${note('C', 4, 16, 1)}<backup><duration>16</duration></backup>${note('C', 2, 16, 2)}</measure>` +
                closing(7),
        );
        const score = parseMusicXmlString(xml);
        expect(score.warnings).toContain('key_signature_repaired');
        expect(score.keySignatures).toEqual([
            { tick: 0, fifths: 4 },
            { tick: 2 * 1920, fifths: 0 },
        ]);
        const lh = score.notes.filter((n) => n.h === 1);
        // bar1 G♯2, bar2 G♯2 (restored), then C2 naturals — not C♯2 (37).
        expect(lh.map((n) => n.p)).toEqual([44, 44, 36, 36, 36, 36, 36]);
    });

    it('keeps a printed natural under a repaired key', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS(4)}${note('C', 4, 16, 1, { alter: 1 })}<backup><duration>16</duration></backup>${note('G', 2, 16, 2, { alter: 1 })}</measure>` +
                `<measure number="2"><attributes><key number="2"><fifths>0</fifths></key></attributes>${note('C', 4, 16, 1, { alter: 1 })}<backup><duration>16</duration></backup>${note('G', 2, 16, 2, { accidental: 'natural' })}</measure>` +
                closing(3),
        );
        const score = parseMusicXmlString(xml);
        const bar2 = score.notes.filter((n) => n.t >= 1920 && n.t < 3840 && n.h === 1);
        expect(bar2[0]?.p).toBe(43);
    });

    it('drops a whole-part key at a system start that reverts within a few bars', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS(4)}${note('C', 4, 16, 1, { alter: 1 })}<backup><duration>16</duration></backup>${note('G', 2, 16, 2, { alter: 1 })}</measure>` +
                `<measure number="2"><print new-system="yes"/><attributes><key><fifths>0</fifths></key></attributes>${note('C', 4, 16, 1)}<backup><duration>16</duration></backup>${note('G', 2, 16, 2)}</measure>` +
                `<measure number="3">${note('C', 4, 16, 1)}<backup><duration>16</duration></backup>${note('G', 2, 16, 2)}</measure>` +
                `<measure number="4"><attributes><key><fifths>4</fifths></key></attributes>${note('C', 4, 16, 1, { alter: 1 })}<backup><duration>16</duration></backup>${note('G', 2, 16, 2, { alter: 1 })}</measure>` +
                closing(5),
        );
        const score = parseMusicXmlString(xml);
        expect(score.warnings).toContain('key_signature_repaired');
        expect(score.keySignatures).toEqual([{ tick: 0, fifths: 4 }]);
        const rh = score.notes.filter((n) => n.h === 0);
        expect(rh.map((n) => n.p)).toEqual([61, 61, 61, 61, 60]);
    });

    it('leaves a genuine both-staff key change that does not revert', () => {
        const xml = wrap(
            `<measure number="1">${ATTRS(4)}${note('C', 4, 16, 1, { alter: 1 })}<backup><duration>16</duration></backup>${note('G', 2, 16, 2, { alter: 1 })}</measure>` +
                `<measure number="2"><print new-system="yes"/><attributes><key><fifths>-1</fifths></key></attributes>${note('B', 4, 16, 1, { alter: -1 })}${`<backup><duration>16</duration></backup>`}${note('B', 2, 16, 2, { alter: -1 })}</measure>` +
                `<measure number="3">${note('B', 4, 16, 1, { alter: -1 })}${`<backup><duration>16</duration></backup>`}${note('B', 2, 16, 2, { alter: -1 })}</measure>` +
                `<measure number="4">${note('B', 4, 16, 1, { alter: -1 })}${`<backup><duration>16</duration></backup>`}${note('B', 2, 16, 2, { alter: -1 })}</measure>` +
                `<measure number="5">${note('B', 4, 16, 1, { alter: -1 })}${`<backup><duration>16</duration></backup>`}${note('B', 2, 16, 2, { alter: -1 })}</measure>` +
                closing(6),
        );
        const score = parseMusicXmlString(xml);
        expect(score.warnings).not.toContain('key_signature_repaired');
        expect(score.keySignatures).toEqual([
            { tick: 0, fifths: 4 },
            { tick: 1920, fifths: -1 },
        ]);
    });
});
