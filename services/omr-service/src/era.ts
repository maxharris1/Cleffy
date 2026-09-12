import { serviceClient } from './supabaseClient.js';

/**
 * The stylistic era a score is played in, which decides how it is pedalled
 * when the engraving does not say. Read from the composer in the document's
 * title; anything unrecognised is played as Classical, the middle of the road.
 */
export type Era = 'baroque' | 'classical' | 'romantic' | 'modern';

export const DEFAULT_ERA: Era = 'classical';

/**
 * Surname → era. The app's IMSLP search facets seed the same table
 * (`ERA_COMPOSER_SEEDS` in src/features/imslp/searchFacets.ts); the extra
 * names are the composers a piano student's library is most likely to hold.
 */
const ERA_SURNAMES: Record<Era, readonly string[]> = {
    baroque: ['Bach', 'Vivaldi', 'Handel', 'Pachelbel', 'Scarlatti', 'Couperin', 'Rameau', 'Telemann', 'Purcell'],
    classical: ['Mozart', 'Haydn', 'Beethoven', 'Clementi', 'Kuhlau', 'Diabelli', 'Hummel', 'Czerny', 'Dussek'],
    romantic: [
        'Chopin',
        'Schubert',
        'Brahms',
        'Liszt',
        'Schumann',
        'Tchaikovsky',
        'Mendelssohn',
        'Grieg',
        'Dvořák',
        'Fauré',
        'Mussorgsky',
        'Burgmüller',
        'Heller',
        'Field',
        'Elgar',
        'Scriabin',
    ],
    modern: [
        'Debussy',
        'Ravel',
        'Satie',
        'Rachmaninoff',
        'Joplin',
        'Bartók',
        'Prokofiev',
        'Shostakovich',
        'Gershwin',
        'Poulenc',
        'Kabalevsky',
        'Khachaturian',
    ],
};

/** Case- and accent-insensitive key for a surname. */
const fold = (name: string): string =>
    name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

const ERA_BY_SURNAME: ReadonlyMap<string, Era> = new Map(
    (Object.keys(ERA_SURNAMES) as Era[]).flatMap((era) => ERA_SURNAMES[era].map((name) => [fold(name), era] as const)),
);

/**
 * The composer's surname in an IMSLP-style title, which ends in
 * "(Last, First)" — the same rule the app's library groups by. Null when the
 * title carries no such suffix.
 */
export const composerSurnameOf = (title: string): string | null => {
    const match = /\(([^()]+)\)\s*$/.exec(title.trim());
    const composer = match?.[1]?.trim();
    if (!composer) {
        return null;
    }
    const surname = (composer.split(',')[0] ?? '').trim();
    return surname ? surname : null;
};

export const eraOfTitle = (title: string | null | undefined): Era => {
    const surname = title ? composerSurnameOf(title) : null;
    if (!surname) {
        return DEFAULT_ERA;
    }
    return ERA_BY_SURNAME.get(fold(surname)) ?? DEFAULT_ERA;
};

/** The era of a document, from its title; the default whenever that cannot be read. */
export const eraForDocument = async (documentId: string): Promise<Era> => {
    const supabase = serviceClient();
    if (!supabase) {
        return DEFAULT_ERA;
    }
    try {
        const { data, error } = await supabase.from('documents').select('title').eq('id', documentId).maybeSingle();
        if (error) {
            console.warn('[era] title lookup failed:', error.message);
            return DEFAULT_ERA;
        }
        const title = (data as { title?: unknown } | null)?.title;
        return eraOfTitle(typeof title === 'string' ? title : null);
    } catch (err) {
        console.warn('[era] title lookup threw:', err instanceof Error ? err.message : err);
        return DEFAULT_ERA;
    }
};
