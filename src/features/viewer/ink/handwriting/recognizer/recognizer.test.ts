import { describe, expect, it } from 'vitest';

import { groupFromHands, HANDS } from '@/features/viewer/ink/handwriting/recognizer/fixtures';
import { cloudDistance, resample, toCloud } from '@/features/viewer/ink/handwriting/recognizer/pointCloud';
import { TEMPLATES } from '@/features/viewer/ink/handwriting/recognizer/templates';
import {
    ACCENT_TEXT,
    ACCEPT_DISTANCE,
    classifyGlyph,
    FERMATA_TEXT,
    recognizeOnDevice,
    splitDigitRun,
} from '@/features/viewer/ink/handwriting/recognizer';

const hand = (name: string) => HANDS[name]!;

describe('point cloud', () => {
    it('resamples any glyph to a fixed number of points', () => {
        expect(resample(hand('one'))).toHaveLength(32);
        expect(resample(hand('four'))).toHaveLength(32);
    });

    it('is invariant to stroke order and direction', () => {
        const four = hand('four');
        const reordered = [[...four[1]!].reverse(), [...four[0]!].reverse()];
        expect(cloudDistance(toCloud(four), toCloud(reordered))).toBeLessThan(0.005);
    });

    it('is invariant to translation and uniform scale', () => {
        const three = hand('three');
        const moved = three.map((s) => s.map(([x, y]): [number, number] => [x * 40 + 300, y * 40 + 900]));
        expect(cloudDistance(toCloud(three), toCloud(moved))).toBeLessThan(0.005);
    });

    it('every template is closest to its own class than to any other class', () => {
        for (const template of TEMPLATES) {
            const cloud = toCloud(template.strokes);
            let nearestOther = Infinity;
            for (const other of TEMPLATES) {
                if (other.cls !== template.cls) {
                    nearestOther = Math.min(nearestOther, cloudDistance(cloud, toCloud(other.strokes)));
                }
            }
            expect(nearestOther, `${template.cls} collides with another class`).toBeGreaterThan(0.009);
        }
    });
});

describe('classifyGlyph (closed-set fixtures)', () => {
    it.each([
        ['one', '1'],
        ['two', '2'],
        ['three', '3'],
        ['four', '4'],
        ['five', '5'],
        ['zero', '0'],
        ['p', 'p'],
        ['f', 'f'],
        ['m', 'm'],
        ['accent', 'accent'],
        ['fermata', 'fermata'],
    ])('reads the %s hand as %s', (name, cls) => {
        const match = classifyGlyph(hand(name));
        expect(match?.cls).toBe(cls);
        expect(match!.distance).toBeLessThanOrEqual(ACCEPT_DISTANCE);
    });

    it.each(['hairpin', 'cross', 'dash', 'spiral'])('abstains on %s (not in the set)', (name) => {
        expect(classifyGlyph(hand(name))).toBeNull();
    });

    it('does not read a diagonal slash as a 1', () => {
        expect(
            classifyGlyph([
                [
                    [0, 1],
                    [0.7, 0],
                ],
            ]),
        ).toBeNull();
    });
});

describe('recognizeOnDevice', () => {
    it('reads an isolated fingering digit', () => {
        expect(recognizeOnDevice(groupFromHands([hand('one')]))).toEqual({ text: '1', kind: 'digit' });
        expect(recognizeOnDevice(groupFromHands([hand('three')]))).toEqual({ text: '3', kind: 'digit' });
    });

    it('reads a lone p or f as a dynamic symbol, not the start of a word', () => {
        expect(recognizeOnDevice(groupFromHands([hand('f')]))).toEqual({ text: 'f', kind: 'symbol' });
        expect(recognizeOnDevice(groupFromHands([hand('p')]))).toEqual({ text: 'p', kind: 'symbol' });
    });

    it('reads accents and fermatas as SMuFL text', () => {
        expect(recognizeOnDevice(groupFromHands([hand('accent')]))).toEqual({ text: ACCENT_TEXT, kind: 'symbol' });
        expect(recognizeOnDevice(groupFromHands([hand('fermata')]))).toEqual({
            text: FERMATA_TEXT,
            kind: 'symbol',
        });
    });

    it('assembles a writing line into a lexicon dynamic (mf, pp)', () => {
        expect(recognizeOnDevice(groupFromHands([hand('m'), hand('f')]))).toEqual({ text: 'mf', kind: 'symbol' });
        expect(recognizeOnDevice(groupFromHands([hand('p'), hand('p')]))).toEqual({ text: 'pp', kind: 'symbol' });
    });

    it('abstains on a lone letter that is not a dynamic, and on words outside the lexicon', () => {
        expect(recognizeOnDevice(groupFromHands([hand('m')]))).toBeNull();
        expect(recognizeOnDevice(groupFromHands([hand('f'), hand('m')]))).toBeNull();
        expect(recognizeOnDevice(groupFromHands([hand('one'), hand('two')]))).toBeNull();
    });

    it('splits a digit-run line into one glyph group per fingering', () => {
        const line = groupFromHands([hand('one'), hand('two')]);
        const pieces = splitDigitRun(line);
        expect(pieces).toHaveLength(2);
        expect(pieces!.map((g) => recognizeOnDevice(g))).toEqual([
            { text: '1', kind: 'digit' },
            { text: '2', kind: 'digit' },
        ]);
        expect(splitDigitRun(groupFromHands([hand('m'), hand('f')]))).toBeNull();
    });

    it('abstains on marks that are not print (hairpin, cross, scribble) so the ink stays', () => {
        for (const name of ['hairpin', 'cross', 'dash', 'spiral']) {
            expect(recognizeOnDevice(groupFromHands([hand(name)])), name).toBeNull();
        }
        // A line containing one unreadable glyph is not converted at all.
        expect(recognizeOnDevice(groupFromHands([hand('m'), hand('spiral')]))).toBeNull();
    });
});
