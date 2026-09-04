/**
 * In-memory IMSLP category membership used for chip browse (Walker INTERSECT)
 * until a category snapshot is `ok` in Postgres.
 *
 * NO imports — Deno (with the `.ts` extension) and vitest (without it) share
 * this file, same as searchFacetData.ts / popularWorks.ts.
 */

export type MembershipIndex = Map<string, Set<string>>;

export type BootstrapWork = {
    title: string;
    instrument?: string;
    form?: string;
    era?: string;
    composerCategory?: string;
};

/**
 * Works that Popular does not cover, so Piano · Baroque is not four Bach
 * pieces and Modern has members that are actually Category:Modern.
 * Titles match IMSLP work pages.
 */
export const EXTRA_BOOTSTRAP: ReadonlyArray<{ title: string; categories: readonly string[] }> = [
    {
        title: 'Pièces de clavecin (Couperin, François)',
        categories: ['For piano', 'Baroque', 'Couperin, François'],
    },
    {
        title: 'Pièces de clavecin (Rameau, Jean-Philippe)',
        categories: ['For piano', 'Baroque', 'Rameau, Jean-Philippe'],
    },
    {
        title: 'Essercizi per gravicembalo (Scarlatti, Domenico)',
        categories: ['For piano', 'Baroque', 'Scarlatti, Domenico'],
    },
    {
        title: 'Sonata in D major, K.119 (Scarlatti, Domenico)',
        categories: ['For piano', 'Baroque', 'Scarlatti, Domenico'],
    },
    {
        title: 'Suite in G minor, Z.661 (Purcell, Henry)',
        categories: ['For piano', 'Baroque', 'Purcell, Henry'],
    },
    {
        title: 'Notations (Boulez, Pierre)',
        categories: ['For piano', 'Modern', 'Boulez, Pierre'],
    },
    {
        title: 'Études (Ligeti, György)',
        categories: ['For piano', 'Modern', 'Etudes', 'Ligeti, György'],
    },
    {
        title: 'Klavierstücke (Stockhausen, Karlheinz)',
        categories: ['For piano', 'Modern', 'Stockhausen, Karlheinz'],
    },
    {
        title: 'Sonatas and Interludes (Cage, John)',
        categories: ['For piano', 'Modern', 'Cage, John'],
    },
];

export const emptyMembership = (): MembershipIndex => new Map();

export const addMembership = (index: MembershipIndex, category: string, title: string): void => {
    let set = index.get(category);
    if (!set) {
        set = new Set();
        index.set(category, set);
    }
    set.add(title);
};

export const mergeMembership = (into: MembershipIndex, from: MembershipIndex): void => {
    for (const [category, titles] of from) {
        for (const title of titles) {
            addMembership(into, category, title);
        }
    }
};

/** Title is in at least one category of every AND-clause (OR inside a clause). */
export const intersectClauses = (index: MembershipIndex, clauses: string[][]): string[] => {
    if (clauses.length === 0) {
        return [];
    }
    let current: Set<string> | null = null;
    for (const orCats of clauses) {
        const union = new Set<string>();
        for (const cat of orCats) {
            const members = index.get(cat);
            if (!members) {
                continue;
            }
            for (const title of members) {
                union.add(title);
            }
        }
        if (current === null) {
            current = union;
            continue;
        }
        const next = new Set<string>();
        for (const title of current) {
            if (union.has(title)) {
                next.add(title);
            }
        }
        current = next;
    }
    return current ? [...current] : [];
};

/** Every AND-clause has at least one known member — empty then means empty, not unsynced. */
export const clausesAreCovered = (index: MembershipIndex, clauses: string[][]): boolean => {
    if (clauses.length === 0) {
        return false;
    }
    return clauses.every((orCats) => orCats.some((cat) => (index.get(cat)?.size ?? 0) > 0));
};

export const bootstrapMembership = (
    works: BootstrapWork[],
    categoryOf: {
        instrument: (id: string) => string | undefined;
        form: (id: string) => string | undefined;
        era: (id: string) => string | undefined;
    },
): MembershipIndex => {
    const index = emptyMembership();
    for (const work of works) {
        if (work.instrument) {
            const category = categoryOf.instrument(work.instrument);
            if (category) {
                addMembership(index, category, work.title);
            }
        }
        if (work.form) {
            const category = categoryOf.form(work.form);
            if (category) {
                addMembership(index, category, work.title);
            }
        }
        if (work.era) {
            const category = categoryOf.era(work.era);
            if (category) {
                addMembership(index, category, work.title);
            }
        }
        if (work.composerCategory) {
            addMembership(index, work.composerCategory, work.title);
        }
    }
    for (const extra of EXTRA_BOOTSTRAP) {
        for (const category of extra.categories) {
            addMembership(index, category, extra.title);
        }
    }
    return index;
};
