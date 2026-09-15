import { describe, expect, it } from 'vitest';

import { workKeyFromText, workKeyFromTokens, workKeyFromMutopiaPath } from './workKey.js';

describe('WorkKey normalization', () => {
    it('parses BWV 772', () => {
        expect(workKeyFromText('BWV 772')).toEqual({
            composerId: 'bach',
            catalogType: 'BWV',
            catalogN: 772,
        });
        expect(workKeyFromText('Invention in C major, BWV 772')).toMatchObject({
            composerId: 'bach',
            catalogType: 'BWV',
            catalogN: 772,
        });
    });

    it('parses WoO 59', () => {
        expect(workKeyFromText('WoO 59')).toEqual({
            composerId: 'beethoven',
            catalogType: 'WoO',
            catalogN: 59,
        });
        expect(workKeyFromText('Für Elise, WoO 59')).toMatchObject({
            composerId: 'beethoven',
            catalogType: 'WoO',
            catalogN: 59,
        });
    });

    it('parses Op. 28 No. 4', () => {
        expect(workKeyFromText('Op. 28 No. 4')).toEqual({
            composerId: 'chopin',
            catalogType: 'Op',
            catalogN: 28,
            movementIndex: 4,
        });
        expect(workKeyFromText('Chopin — Prelude in E minor, Op. 28 No. 4')).toEqual({
            composerId: 'chopin',
            catalogType: 'Op',
            catalogN: 28,
            movementIndex: 4,
        });
    });

    it('parses Op. 68 No. 5', () => {
        expect(workKeyFromText('Op. 68 No. 5')).toEqual({
            composerId: 'schumann',
            catalogType: 'Op',
            catalogN: 68,
            movementIndex: 5,
        });
        expect(workKeyFromTokens(['Album', 'für', 'die', 'Jugend', 'Op.', '68', 'No.', '5'])).toEqual({
            composerId: 'schumann',
            catalogType: 'Op',
            catalogN: 68,
            movementIndex: 5,
        });
    });

    it('parses K. 545', () => {
        expect(workKeyFromText('K. 545')).toEqual({
            composerId: 'mozart',
            catalogType: 'K',
            catalogN: 545,
        });
        expect(workKeyFromText('Piano Sonata in C major, K. 545')).toMatchObject({
            composerId: 'mozart',
            catalogType: 'K',
            catalogN: 545,
        });
    });

    it('parses a Gymnopédie title after stripping accents', () => {
        expect(workKeyFromText('Satie — Gymnopédie No. 2')).toEqual({
            composerId: 'satie',
            catalogType: 'No',
            catalogN: 2,
        });
    });

    it('reads a Mutopia FTP path', () => {
        expect(
            workKeyFromMutopiaPath(
                'https://www.mutopiaproject.org/ftp/BachJS/BWV772/bach-invention-01/bach-invention-01.mid',
            ),
        ).toMatchObject({ composerId: 'bach', catalogType: 'BWV', catalogN: 772 });
    });
});
