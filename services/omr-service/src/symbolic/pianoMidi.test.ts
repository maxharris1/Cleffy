import { describe, expect, it } from 'vitest';

import { matchPianoMidiFiles, pianoMidiCandidates } from './pianoMidi.js';
import { workKeyFromText } from './workKey.js';

describe('matchPianoMidiFiles', () => {
    it('maps popular Beethoven nicknames without requiring a movement index filter', () => {
        const moonlight = workKeyFromText('Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)')!;
        expect(matchPianoMidiFiles(moonlight)).toEqual([
            'mond_1_format0.mid',
            'mond_2_format0.mid',
            'mond_3_format0.mid',
        ]);
        const path = workKeyFromText('Piano Sonata No.8, Op.13 (Beethoven, Ludwig van)')!;
        expect(matchPianoMidiFiles(path)).toHaveLength(3);
        expect(pianoMidiCandidates(path).some((c) => c.title === 'piano-midi.de all movements')).toBe(true);
        const elise = workKeyFromText('Für Elise, WoO 59 (Beethoven, Ludwig van)')!;
        expect(pianoMidiCandidates(elise)[0]?.url).toContain('elise_format0.mid');
        expect(pianoMidiCandidates(elise)[0]?.url).toContain('web.archive.org');
    });

    it('does not serve Moonlight (Op. 27 No. 2) for Op. 27 No. 1', () => {
        const quasi = workKeyFromText('Piano Sonata No.13, Op.27 No.1 (Beethoven, Ludwig van)')!;
        expect(quasi.movementIndex).toBe(1);
        expect(matchPianoMidiFiles(quasi)).toEqual([]);
        expect(pianoMidiCandidates(quasi)).toEqual([]);
        const bare = workKeyFromText('Sonata quasi una fantasia, Op.27 (Beethoven, Ludwig van)')!;
        expect(matchPianoMidiFiles(bare)).toHaveLength(3);
    });

    it('does not dump all 24 Chopin preludes when the work key has no piece number', () => {
        const preludes = workKeyFromText('Preludes, Op.28 (Chopin, Frédéric)')!;
        expect(matchPianoMidiFiles(preludes)).toEqual([]);
    });
});
