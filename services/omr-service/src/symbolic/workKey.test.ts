import { describe, expect, it } from 'vitest';

import { catalogAgrees } from './types.js';
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
        expect(workKeyFromText('2. ème Gymnopédie Erik Satie')).toEqual({
            composerId: 'satie',
            catalogType: 'No',
            catalogN: 2,
        });
    });

    it('catalogAgrees treats a missing PDF movementIndex as a hit', () => {
        expect(
            catalogAgrees(
                { composerId: 'czerny', catalogType: 'Op', catalogN: 821 },
                { composerId: 'czerny', catalogType: 'Op', catalogN: 821, movementIndex: 1 },
            ),
        ).toBe(true);
        expect(
            catalogAgrees(
                { composerId: 'schumann', catalogType: 'Op', catalogN: 68, movementIndex: 1 },
                { composerId: 'schumann', catalogType: 'Op', catalogN: 68, movementIndex: 2 },
            ),
        ).toBe(false);
    });

    it('reads a Mutopia FTP path', () => {
        expect(
            workKeyFromMutopiaPath(
                'https://www.mutopiaproject.org/ftp/BachJS/BWV772/bach-invention-01/bach-invention-01.mid',
            ),
        ).toMatchObject({ composerId: 'bach', catalogType: 'BWV', catalogN: 772 });
    });

    it('identifies the composers Mutopia holds from IMSLP page titles', () => {
        expect(workKeyFromText('4 Impromptus, D.899 (Schubert, Franz)')).toEqual({
            composerId: 'schubert',
            catalogType: 'D',
            catalogN: 899,
        });
        expect(workKeyFromText('Consolations, S.172 (Liszt, Franz)')).toEqual({
            composerId: 'liszt',
            catalogType: 'S',
            catalogN: 172,
        });
        expect(workKeyFromText('Messiah, HWV 56 (Handel, George Frideric)')).toEqual({
            composerId: 'handel',
            catalogType: 'HWV',
            catalogN: 56,
        });
        expect(workKeyFromText('Keyboard Sonata in C major, Hob.XVI:50 (Haydn, Joseph)')).toEqual({
            composerId: 'haydn',
            catalogType: 'Hob',
            catalogN: 50,
        });
        // Only Hoboken XVI is a WorkKey; other groups would collide with it.
        expect(workKeyFromText('Symphony No.94 in G major, Hob.I:94 (Haydn, Joseph)')).toBeNull();
        expect(workKeyFromText('Suite bergamasque, CD 82 (Debussy, Claude)')).toEqual({
            composerId: 'debussy',
            catalogType: 'CD',
            catalogN: 82,
        });
        expect(workKeyFromText('Sonata in D minor, K.9 (Scarlatti, Domenico)')).toMatchObject({
            composerId: 'scarlatti',
            catalogType: 'K',
            catalogN: 9,
        });
        expect(workKeyFromText('Lyric Pieces, Op.12 (Grieg, Edvard)')).toMatchObject({
            composerId: 'grieg',
            catalogType: 'Op',
            catalogN: 12,
        });
        expect(workKeyFromText('Morceaux de fantaisie, Op.3 (Rachmaninoff, Sergei)')).toMatchObject({
            composerId: 'rachmaninoff',
        });
        expect(workKeyFromText('Piano Concerto No.1, Op.23 (Tchaikovsky, Pyotr)')).toMatchObject({
            composerId: 'tchaikovsky',
        });
        expect(workKeyFromText('Lieder ohne Worte, Op.30 (Mendelssohn, Felix)')).toMatchObject({
            composerId: 'mendelssohn',
        });
        expect(workKeyFromText('Minuet in G major, BWV Anh.114 (Pezold, Christian)')).toMatchObject({
            composerId: 'petzold',
            catalogType: 'Anh',
        });
    });

    it('reads Mutopia catalogue folders for the added composers', () => {
        expect(
            workKeyFromMutopiaPath('https://www.mutopiaproject.org/ftp/SchubertF/D899/impromptu-3/impromptu-3.mid'),
        ).toMatchObject({ composerId: 'schubert', catalogType: 'D', catalogN: 899 });
        expect(workKeyFromMutopiaPath('/ftp/LisztF/S.172/consolation-3/consolation-3.ly')).toMatchObject({
            composerId: 'liszt',
            catalogType: 'S',
            catalogN: 172,
        });
        expect(workKeyFromMutopiaPath('/ftp/HandelGF/HWV56/hallelujah/hallelujah.mid')).toMatchObject({
            composerId: 'handel',
            catalogType: 'HWV',
            catalogN: 56,
        });
        expect(workKeyFromMutopiaPath('/ftp/HaydnFJ/HOB-XVI-27/sonata-27-1/sonata-27-1.mid')).toMatchObject({
            composerId: 'haydn',
            catalogType: 'Hob',
            catalogN: 27,
        });
        expect(workKeyFromMutopiaPath('/ftp/DebussyC/L75/clair-de-lune/clair-de-lune.mid')).toMatchObject({
            composerId: 'debussy',
            catalogType: 'L',
            catalogN: 75,
        });
        expect(
            workKeyFromMutopiaPath('/ftp/Mendelssohn-BartholdyF/O19/venetianisches/venetianisches.mid'),
        ).toMatchObject({
            composerId: 'mendelssohn',
            catalogType: 'Op',
            catalogN: 19,
        });
    });
});
