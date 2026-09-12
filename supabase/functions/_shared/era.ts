/**
 * KEEP IN LOCKSTEP with services/omr-service/src/era.ts and
 * src/features/playback/era.ts. Used by score-analyze to refuse a metered
 * re-run that would rewrite the same era as well as the same generation.
 */
export type Era = 'baroque' | 'classical' | 'romantic' | 'modern';

export const DEFAULT_ERA: Era = 'classical';

/** Generation that first let the title's era change what a PDF sounds like. */
export const ERA_AWARE_ENGINE_GENERATION = 11;

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

const fold = (name: string): string =>
    name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

const ERA_BY_SURNAME: ReadonlyMap<string, Era> = new Map(
    (Object.keys(ERA_SURNAMES) as Era[]).flatMap((era) => ERA_SURNAMES[era].map((name) => [fold(name), era] as const)),
);

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

export const isEra = (value: unknown): value is Era =>
    value === 'baroque' || value === 'classical' || value === 'romantic' || value === 'modern';
