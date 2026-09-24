import { concatUrl } from './midiConcat.js';
import { sourcePriority, type RankedCandidate, type WorkKey } from './types.js';

/**
 * Bernd Krueger piano-midi.de format-0 files (CC-BY-SA 3.0 DE).
 * Live site returns 418 from this VM; Wayback identity captures are the bulk index.
 */
export const PIANO_MIDI_WAYBACK_PREFIX =
    'https://web.archive.org/web/20190122110256im_/http://www.piano-midi.de/midis/format0/';

export const PIANO_MIDI_CREDIT = 'Bernd Krueger (piano-midi.de)';
export const PIANO_MIDI_SOURCE_URL = 'http://www.piano-midi.de';

const FILES: readonly string[] = [
    'appass_1_format0.mid',
    'appass_2_format0.mid',
    'appass_3_format0.mid',
    'bach_846_format0.mid',
    'bach_847_format0.mid',
    'bach_850_format0.mid',
    'beethoven_hammerklavier_1_format0.mid',
    'beethoven_hammerklavier_2_format0.mid',
    'beethoven_hammerklavier_3_format0.mid',
    'beethoven_hammerklavier_4_format0.mid',
    'beethoven_les_adieux_1_format0.mid',
    'beethoven_les_adieux_3_format0.mid',
    'beethoven_opus10_1_format0.mid',
    'beethoven_opus10_2_format0.mid',
    'beethoven_opus10_3_format0.mid',
    'beethoven_opus22_1_format0.mid',
    'beethoven_opus22_2_format0.mid',
    'beethoven_opus22_3_format0.mid',
    'beethoven_opus22_4_format0.mid',
    'chp_op18_format0.mid',
    'chp_op31_format0.mid',
    'chpn-p1_format0.mid',
    'chpn-p2_format0.mid',
    'chpn-p3_format0.mid',
    'chpn-p4_format0.mid',
    'chpn-p5_format0.mid',
    'chpn-p6_format0.mid',
    'chpn-p7_format0.mid',
    'chpn-p8_format0.mid',
    'chpn-p9_format0.mid',
    'chpn-p10_format0.mid',
    'chpn-p11_format0.mid',
    'chpn-p12_format0.mid',
    'chpn-p13_format0.mid',
    'chpn-p14_format0.mid',
    'chpn-p15_format0.mid',
    'chpn-p16_format0.mid',
    'chpn-p17_format0.mid',
    'chpn-p18_format0.mid',
    'chpn-p19_format0.mid',
    'chpn-p20_format0.mid',
    'chpn-p21_format0.mid',
    'chpn-p22_format0.mid',
    'chpn-p23_format0.mid',
    'chpn-p24_format0.mid',
    'chpn_op10_e01_format0.mid',
    'chpn_op10_e05_format0.mid',
    'chpn_op10_e12_format0.mid',
    'chpn_op23_format0.mid',
    'chpn_op25_e1_format0.mid',
    'chpn_op25_e2_format0.mid',
    'chpn_op25_e3_format0.mid',
    'chpn_op25_e4_format0.mid',
    'chpn_op25_e11_format0.mid',
    'chpn_op27_1_format0.mid',
    'chpn_op27_2_format0.mid',
    'chpn_op33_2_format0.mid',
    'chpn_op33_4_format0.mid',
    'chpn_op35_1_format0.mid',
    'chpn_op35_2_format0.mid',
    'chpn_op35_3_format0.mid',
    'chpn_op35_4_format0.mid',
    'chpn_op53_format0.mid',
    'chpn_op66_format0.mid',
    'chpn_op7_1_format0.mid',
    'chpn_op7_2_format0.mid',
    'deb_clai_format0.mid',
    'deb_menu_format0.mid',
    'deb_pass_format0.mid',
    'deb_prel_format0.mid',
    'elise_format0.mid',
    'mendel_op30_1_format0.mid',
    'mendel_op53_5_format0.mid',
    'mendel_op62_3_format0.mid',
    'mendel_op62_4_format0.mid',
    'mendel_op62_5_format0.mid',
    'mond_1_format0.mid',
    'mond_2_format0.mid',
    'mond_3_format0.mid',
    'mz_311_1_format0.mid',
    'mz_311_2_format0.mid',
    'mz_311_3_format0.mid',
    'mz_330_1_format0.mid',
    'mz_330_2_format0.mid',
    'mz_330_3_format0.mid',
    'mz_331_1_format0.mid',
    'mz_331_2_format0.mid',
    'mz_331_3_format0.mid',
    'mz_332_1_format0.mid',
    'mz_332_2_format0.mid',
    'mz_332_3_format0.mid',
    'mz_333_1_format0.mid',
    'mz_333_2_format0.mid',
    'mz_333_3_format0.mid',
    'mz_545_1_format0.mid',
    'mz_545_2_format0.mid',
    'mz_545_3_format0.mid',
    'mz_570_1_format0.mid',
    'mz_570_2_format0.mid',
    'mz_570_3_format0.mid',
    'pathetique_1_format0.mid',
    'pathetique_2_format0.mid',
    'pathetique_3_format0.mid',
    'schub_d760_1_format0.mid',
    'schub_d760_2_format0.mid',
    'schub_d760_3_format0.mid',
    'schub_d760_4_format0.mid',
    'schub_d960_1_format0.mid',
    'schub_d960_2_format0.mid',
    'schub_d960_3_format0.mid',
    'schub_d960_4_format0.mid',
    'schubert_D850_1_format0.mid',
    'schubert_D850_2_format0.mid',
    'schubert_D850_3_format0.mid',
    'schubert_D850_4_format0.mid',
    'schubert_D935_1_format0.mid',
    'schubert_D935_2_format0.mid',
    'schubert_D935_3_format0.mid',
    'schubert_D935_4_format0.mid',
    'scn15_1_format0.mid',
    'scn15_2_format0.mid',
    'scn15_3_format0.mid',
    'scn15_4_format0.mid',
    'scn15_5_format0.mid',
    'scn15_6_format0.mid',
    'scn15_7_format0.mid',
    'scn15_8_format0.mid',
    'scn15_9_format0.mid',
    'scn15_10_format0.mid',
    'scn15_11_format0.mid',
    'scn15_12_format0.mid',
    'scn15_13_format0.mid',
    'scn16_1_format0.mid',
    'scn16_2_format0.mid',
    'scn16_3_format0.mid',
    'scn16_4_format0.mid',
    'scn16_5_format0.mid',
    'scn16_6_format0.mid',
    'scn16_7_format0.mid',
    'scn16_8_format0.mid',
    'scn68_10_format0.mid',
    'scn68_12_format0.mid',
    'waldstein_1_format0.mid',
    'waldstein_2_format0.mid',
    'waldstein_3_format0.mid',
];

const aliasKey = (workKey: WorkKey): string => `${workKey.composerId}:${workKey.catalogType}:${workKey.catalogN}`;

/** Whole-work nicknames. Do not filter by movementIndex — that field is often "Op. N No. M". */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
    'beethoven:Op:13': ['pathetique_1_format0.mid', 'pathetique_2_format0.mid', 'pathetique_3_format0.mid'],
    'beethoven:Op:27': ['mond_1_format0.mid', 'mond_2_format0.mid', 'mond_3_format0.mid'],
    'beethoven:Op:53': ['waldstein_1_format0.mid', 'waldstein_2_format0.mid', 'waldstein_3_format0.mid'],
    'beethoven:Op:57': ['appass_1_format0.mid', 'appass_2_format0.mid', 'appass_3_format0.mid'],
    'beethoven:Op:81': ['beethoven_les_adieux_1_format0.mid', 'beethoven_les_adieux_3_format0.mid'],
    'beethoven:Op:106': [
        'beethoven_hammerklavier_1_format0.mid',
        'beethoven_hammerklavier_2_format0.mid',
        'beethoven_hammerklavier_3_format0.mid',
        'beethoven_hammerklavier_4_format0.mid',
    ],
    'beethoven:WoO:59': ['elise_format0.mid'],
    'chopin:Op:66': ['chpn_op66_format0.mid'],
    'chopin:Op:23': ['chpn_op23_format0.mid'],
    'chopin:Op:53': ['chpn_op53_format0.mid'],
    'chopin:Op:31': ['chp_op31_format0.mid'],
    'chopin:Op:18': ['chp_op18_format0.mid'],
    'debussy:CD:82': ['deb_clai_format0.mid', 'deb_menu_format0.mid', 'deb_pass_format0.mid', 'deb_prel_format0.mid'],
};

const prefixMatches = (prefix: string): string[] => FILES.filter((name) => name.startsWith(prefix));

const numberedPiece = (files: readonly string[], movementIndex: number | undefined): string[] => {
    if (movementIndex === undefined) {
        return files.length <= 4 ? [...files] : [];
    }
    const hit = files.filter((name) => {
        const m = name.match(/[_-](?:e)?0*(\d+)_format0\.mid$/i) ?? name.match(/p(\d+)_format0\.mid$/i);
        return m?.[1] !== undefined && Number(m[1]) === movementIndex;
    });
    return hit;
};

/**
 * Aliases whose opus holds several works: the alias is only one "No.". A
 * work key that names a different No. is a different piece (Op. 27 No. 1 is
 * not Moonlight). No movementIndex keeps the alias, since that field may
 * equally be a movement number.
 */
const ALIAS_NO: Readonly<Record<string, number>> = {
    'beethoven:Op:27': 2,
};

export const matchPianoMidiFiles = (workKey: WorkKey): string[] => {
    const key = aliasKey(workKey);
    const alias = ALIASES[key];
    const no = ALIAS_NO[key];
    if (
        alias !== undefined &&
        (no === undefined || workKey.movementIndex === undefined || workKey.movementIndex === no)
    ) {
        return [...alias];
    }
    switch (workKey.composerId) {
        case 'bach': {
            if (workKey.catalogType !== 'BWV') {
                return [];
            }
            return FILES.filter((name) => name === `bach_${workKey.catalogN}_format0.mid`);
        }
        case 'beethoven': {
            if (workKey.catalogType !== 'Op') {
                return [];
            }
            return numberedPiece(prefixMatches(`beethoven_opus${workKey.catalogN}_`), workKey.movementIndex);
        }
        case 'mozart': {
            if (workKey.catalogType !== 'K') {
                return [];
            }
            return numberedPiece(prefixMatches(`mz_${workKey.catalogN}_`), workKey.movementIndex);
        }
        case 'schubert': {
            if (workKey.catalogType !== 'D') {
                return [];
            }
            const a = prefixMatches(`schub_d${workKey.catalogN}_`);
            const b = prefixMatches(`schubert_D${workKey.catalogN}_`);
            return numberedPiece([...a, ...b], workKey.movementIndex);
        }
        case 'schumann': {
            if (workKey.catalogType !== 'Op') {
                return [];
            }
            return numberedPiece(prefixMatches(`scn${workKey.catalogN}_`), workKey.movementIndex);
        }
        case 'chopin': {
            if (workKey.catalogType !== 'Op') {
                return [];
            }
            if (workKey.catalogN === 28) {
                return numberedPiece(
                    FILES.filter((name) => /^chpn-p\d+_format0\.mid$/i.test(name)),
                    workKey.movementIndex,
                );
            }
            if (workKey.catalogN === 10) {
                return numberedPiece(prefixMatches('chpn_op10_e'), workKey.movementIndex);
            }
            if (workKey.catalogN === 25) {
                return numberedPiece(prefixMatches('chpn_op25_e'), workKey.movementIndex);
            }
            return numberedPiece(prefixMatches(`chpn_op${workKey.catalogN}_`), workKey.movementIndex);
        }
        case 'mendelssohn': {
            if (workKey.catalogType !== 'Op') {
                return [];
            }
            return numberedPiece(prefixMatches(`mendel_op${workKey.catalogN}_`), workKey.movementIndex);
        }
        default:
            return [];
    }
};

export const isPianoMidiUrl = (url: string): boolean => /piano-midi\.de/i.test(url);

export const pianoMidiCandidates = (workKey: WorkKey): RankedCandidate[] => {
    const files = matchPianoMidiFiles(workKey);
    const cands: RankedCandidate[] = files.map((name) => ({
        source: 'imslp',
        format: 'mid',
        url: `${PIANO_MIDI_WAYBACK_PREFIX}${name}`,
        workKey,
        title: name,
        arrangement: false,
        priority: sourcePriority('imslp', 'mid'),
    }));
    if (files.length >= 2) {
        cands.push({
            source: 'imslp',
            format: 'mid',
            url: concatUrl(files.map((name) => `${PIANO_MIDI_WAYBACK_PREFIX}${name}`)),
            workKey,
            title: 'piano-midi.de all movements',
            arrangement: false,
            priority: sourcePriority('imslp', 'mid'),
        });
    }
    return cands;
};
