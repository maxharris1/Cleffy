import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ImslpEdition, ImslpWorkDetail } from '@/features/imslp/imslpApi';
import { fileBlockKey, parseImslpFileBlocks } from '../../supabase/functions/_shared/imslpFileBlocks';

/** Verbatim IMSLP red-span text on the two Moonlight Henle files. */
export const URTEXT_COPYRIGHT_NOTE = 'See notes on copyright status for urtext editions';

const HENLE_II = 'PMLP01458-beethoven_piano-sonata-op27-no2_henle-pp17-30.pdf';
const HENLE_I = 'PMLP01458-E621557_247-260-beethoven--sonatas-vol1.pdf';
const WEINER = 'PMLP1458-Beethoven.op27no2.sonata.no14.moonlight.wiener.pdf';
const SCHIRMER = 'PMLP1458-Sonata_No._14.pdf';
const DUMP = 'PMLP01458-Beethoven,_Ludwig_van-Werke_Breitkopf_Kalmus_Band_21_B137_Op_27_No_2_scan.pdf';
const GUITAR = 'PMLP1458-moonlight-guitar-duo.pdf';

const SIZES: Record<string, number> = {
    [fileBlockKey(HENLE_II)]: 2_100_000,
    [fileBlockKey(HENLE_I)]: 28_000_000,
    [fileBlockKey(WEINER)]: 1_800_000,
    [fileBlockKey(SCHIRMER)]: 2_000_000,
    [fileBlockKey(DUMP)]: 40_000_000,
    [fileBlockKey(GUITAR)]: 2_000_000,
};

const RESTRICTED = new Set([fileBlockKey(HENLE_II), fileBlockKey(HENLE_I)]);

const moonlightWikitext = (): string =>
    readFileSync(resolve(process.cwd(), 'tests/imslp/fixtures/moonlight-worktext.wikitext'), 'utf8');

/**
 * Real Moonlight-shaped `imslp-work` payload: both Henle files restricted by
 * IMSLP's urtext copyright note, Weiner downloadable, plus arrangement + dump.
 */
export const moonlightWorkDetail = (): ImslpWorkDetail => {
    const meta = parseImslpFileBlocks(moonlightWikitext());
    const editions: ImslpEdition[] = [];
    for (const [filename, fields] of meta) {
        const restricted = RESTRICTED.has(filename);
        editions.push({
            filename,
            size: SIZES[filename] ?? 1_900_000,
            mime: 'application/pdf',
            openUrl: `https://imslp.org/wiki/Special:ImagefromIndex/${filename}`,
            license: 'pd',
            licenseLabel: 'Public Domain',
            restriction: restricted ? URTEXT_COPYRIGHT_NOTE : null,
            downloadable: !restricted,
            ...fields,
        });
    }
    return {
        title: 'Piano Sonata No.14, Op.27 No.2 (Beethoven, Ludwig van)',
        composer: 'Beethoven, Ludwig van',
        imslpUrl: 'https://imslp.org/wiki/Piano_Sonata_No.14,_Op.27_No.2_(Beethoven,_Ludwig_van)',
        editions,
    };
};

export const moonlightFilenames = {
    henleII: fileBlockKey(HENLE_II),
    henleI: fileBlockKey(HENLE_I),
    weiner: fileBlockKey(WEINER),
    schirmer: fileBlockKey(SCHIRMER),
    dump: fileBlockKey(DUMP),
    guitar: fileBlockKey(GUITAR),
};
