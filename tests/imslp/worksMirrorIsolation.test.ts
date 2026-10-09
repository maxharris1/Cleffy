import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { unionCategories } from '../../supabase/functions/_shared/categorySync';

const migration = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260909153000_imslp_works_snapshot_isolation.sql'),
    'utf8',
);

type LiveWork = { page_id: number; page_title: string; categories: string[] };
type BuildingWork = LiveWork & { generation: number; anchor: string };

/** Same GIN `&&` rule as imslp_browse_works: overlap every group. */
const browseLive = (groups: string[][], works: LiveWork[]): string[] => {
    if (groups.length === 0) {
        return [];
    }
    return works
        .filter((w) => groups.every((group) => group.some((c) => w.categories.includes(c))))
        .map((w) => w.page_title);
};

const titlesInCategories = (
    titles: string[],
    categories: string[],
    works: LiveWork[],
): Array<{ page_title: string; category: string }> => {
    const wantedTitles = new Set(titles);
    const wantedCats = new Set(categories);
    const out: Array<{ page_title: string; category: string }> = [];
    for (const w of works) {
        if (!wantedTitles.has(w.page_title)) {
            continue;
        }
        for (const category of w.categories) {
            if (wantedCats.has(category)) {
                out.push({ page_title: w.page_title, category });
            }
        }
    }
    return out;
};

class WorksMirror {
    live = new Map<number, LiveWork>();
    building = new Map<string, BuildingWork>();

    upsertBuilding(rows: BuildingWork[]): void {
        for (const row of rows) {
            this.building.set(`${row.page_id}:${row.generation}:${row.anchor}`, { ...row, categories: [...row.categories] });
        }
    }

    liveRows(): LiveWork[] {
        return [...this.live.values()].map((w) => ({ ...w, categories: [...w.categories] }));
    }

    /** Matches imslp_promote_anchor: union into live, prune by this generation's building set. */
    promote(anchor: string, generation: number): number {
        for (const row of this.building.values()) {
            if (row.anchor !== anchor || row.generation !== generation) {
                continue;
            }
            const existing = this.live.get(row.page_id);
            if (!existing) {
                this.live.set(row.page_id, {
                    page_id: row.page_id,
                    page_title: row.page_title,
                    categories: [...row.categories],
                });
                continue;
            }
            existing.page_title = row.page_title;
            existing.categories = unionCategories(existing.categories, row.categories);
        }
        const seen = new Set<number>();
        for (const row of this.building.values()) {
            if (row.anchor === anchor && row.generation === generation) {
                seen.add(row.page_id);
            }
        }
        let pruned = 0;
        for (const w of this.live.values()) {
            if (w.categories.includes(anchor) && !seen.has(w.page_id)) {
                w.categories = w.categories.filter((c) => c !== anchor);
                pruned += 1;
            }
        }
        for (const [id, w] of this.live) {
            if (w.categories.length === 0) {
                this.live.delete(id);
            }
        }
        for (const [key, row] of this.building) {
            if (row.anchor === anchor && row.generation <= generation) {
                this.building.delete(key);
            }
        }
        return pruned;
    }
}

describe('works mirror snapshot isolation', () => {
    const goldberg: LiveWork = {
        page_id: 1,
        page_title: 'Goldberg Variations, BWV 988 (Bach, Johann Sebastian)',
        categories: ['For piano', 'Baroque', 'G major'],
    };

    it('readers must not see a half-refreshed category while the index stays ready', () => {
        const mirror = new WorksMirror();
        mirror.live.set(goldberg.page_id, { ...goldberg, categories: [...goldberg.categories] });

        // Refresh tick upserts a thinner list into the building generation — the
        // bug was writing this straight into imslp_works while active_generation > 0.
        mirror.upsertBuilding([
            {
                page_id: 1,
                page_title: goldberg.page_title,
                categories: ['For piano'],
                generation: 2,
                anchor: 'For piano',
            },
        ]);

        const groups = [
            ['For piano', 'For piano (arr)'],
            ['G major'],
        ];
        expect(browseLive(groups, mirror.liveRows())).toEqual([goldberg.page_title]);
        expect(titlesInCategories([goldberg.page_title], ['G major', 'Baroque'], mirror.liveRows())).toEqual([
            { page_title: goldberg.page_title, category: 'Baroque' },
            { page_title: goldberg.page_title, category: 'G major' },
        ]);
        expect(mirror.building.size).toBeGreaterThan(0);

        mirror.promote('For piano', 2);
        expect(browseLive(groups, mirror.liveRows())).toEqual([goldberg.page_title]);
        expect(mirror.live.get(1)?.categories.sort()).toEqual(['Baroque', 'For piano', 'G major']);
    });

    it('promote unions instead of last-writer-wins replace', () => {
        const mirror = new WorksMirror();
        mirror.live.set(2, {
            page_id: 2,
            page_title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
            categories: ['For piano', 'Nocturnes', 'Romantic'],
        });
        mirror.upsertBuilding([
            {
                page_id: 2,
                page_title: 'Nocturnes, Op.9 (Chopin, Frédéric)',
                categories: ['For piano', 'E-flat major'],
                generation: 2,
                anchor: 'For piano',
            },
        ]);
        mirror.promote('For piano', 2);
        expect(mirror.live.get(2)?.categories.sort()).toEqual([
            'E-flat major',
            'For piano',
            'Nocturnes',
            'Romantic',
        ]);
    });

    it('prune is this generation’s membership, not a global seen_at bumped by another anchor', () => {
        const mirror = new WorksMirror();
        mirror.live.set(3, {
            page_id: 3,
            page_title: 'Messiah, HWV 56 (Handel, George Frideric)',
            categories: ['For piano', 'Baroque'],
        });
        // A concurrent Baroque walk saw this page and would have bumped seen_at.
        mirror.upsertBuilding([
            {
                page_id: 3,
                page_title: 'Messiah, HWV 56 (Handel, George Frideric)',
                categories: ['Baroque', 'For piano (arr)'],
                generation: 4,
                anchor: 'Baroque',
            },
        ]);
        // This For piano refresh did not see page 3.
        const pruned = mirror.promote('For piano', 2);
        expect(pruned).toBe(1);
        expect(mirror.live.get(3)?.categories).toEqual(['Baroque']);
        expect(mirror.building.size).toBe(1);
    });

    it('empty groups and empty live snapshot yield no browse rows', () => {
        expect(browseLive([], [{ page_id: 1, page_title: 'A', categories: ['For piano'] }])).toEqual([]);
        expect(browseLive([['For piano']], [])).toEqual([]);
    });
});

describe('snapshot isolation SQL', () => {
    it('revokes table grants the way 20260831090000 did, not RLS-only', () => {
        expect(migration).toMatch(/revoke all on table public\.imslp_works from public, anon, authenticated/i);
        expect(migration).toMatch(
            /revoke all on table public\.imslp_works_building from public, anon, authenticated/i,
        );
    });

    it('browse and titles_in_categories read imslp_works, never the building table', () => {
        const browse = migration.slice(
            migration.indexOf('create or replace function public.imslp_browse_works'),
            migration.indexOf('create or replace function public.imslp_browse ('),
        );
        const titles = migration.slice(
            migration.indexOf('create or replace function public.imslp_titles_in_categories'),
            migration.indexOf('create or replace function public.imslp_promote_anchor'),
        );
        expect(browse).toMatch(/from public\.imslp_works w/);
        expect(browse).not.toMatch(/imslp_works_building/);
        expect(browse).toMatch(/w\.categories && ga\.cats/);
        expect(titles).toMatch(/from public\.imslp_works w/);
        expect(titles).not.toMatch(/imslp_works_building/);
        expect(titles).not.toMatch(/imslp_category_members/);
    });

    it('keeps imslp_browse as a wrapper so the live dev edge name still exists', () => {
        expect(migration).toMatch(/from public\.imslp_browse_works \(groups, sort, lim, off, popular_titles, title_filters\)/);
    });

    it('promote is one function so a failed prune cannot leave mixed membership', () => {
        const promote = migration.slice(migration.indexOf('create or replace function public.imslp_promote_anchor'));
        expect(promote).toMatch(/insert into public\.imslp_works/);
        expect(promote).toMatch(/array_remove\(w\.categories, imslp_promote_anchor\.anchor\)/);
        expect(promote).toMatch(/not exists \(/);
        expect(promote).toMatch(/from public\.imslp_works_building b/);
    });
});
