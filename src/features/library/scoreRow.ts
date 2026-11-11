import { useEffect, useState } from 'react';

import type { DocumentRow } from '@/types/database';

/**
 * What a card or row can ask the library page to do, for the score it shows.
 *
 * One object for the whole list, created once by the page: every handler takes
 * the score (and the favorite toggle the state it should end in), so no card
 * holds a closure of its own and a memoized card re-renders only when its own
 * score, star or ownership changes — not on every keystroke in the search box
 * or every tap on some other card's star.
 */
export interface ScoreActions {
    toggleFavorite: (doc: DocumentRow, favorite: boolean) => void;
    rename: (doc: DocumentRow) => void;
    share: (doc: DocumentRow) => void;
    /** Absent when the plan has no roster — the menu item disappears with it. */
    assign?: (doc: DocumentRow) => void;
    remove: (doc: DocumentRow) => void;
    /** A score shared with you: its menu offers to take it out of your library. */
    leave: (doc: DocumentRow) => void;
    editTags: (doc: DocumentRow) => void;
    filterTag: (tagId: string) => void;
}

/**
 * Only the first rows of the first paint get the staggered entrance. Rows
 * further down are off-screen when they mount, and rows a "load more" page
 * appends would otherwise sit invisible for the full 360 ms stagger before a
 * 400 ms fade — older scores arriving most of a second after the server sent
 * them.
 */
const ENTRANCE_ROWS = 24;

/**
 * The entrance plays once per session: the first time the shelf paints.
 * Coming back to the library from a score, switching tabs or searching shows
 * the rows already in place — an animation that replays on every visit stops
 * reading as arrival and starts reading as waiting.
 */
let entrancePlayed = false;

/** Tests only: start a fresh "session". */
export const resetEntranceForTests = (): void => {
    entrancePlayed = false;
};

/**
 * The entrance delay for a row first mounted at `index`, or null for none.
 * Read once at mount: a row that later moves up the list (a search narrowing
 * it) must not replay an entrance it already had.
 */
export const useEntranceDelay = (index: number): number | null => {
    const [delay] = useState(() => (!entrancePlayed && index < ENTRANCE_ROWS ? Math.min(index, 12) * 30 : null));
    useEffect(() => {
        // After the commit, so every row of that first paint still gets its turn.
        entrancePlayed = true;
    }, []);
    return delay;
};

/**
 * Same score as far as a card can tell. The network repaint after a cached
 * paint hands every row over as a new object with the same values; comparing
 * the fields keeps those rows from re-rendering for nothing.
 */
export const sameDocRow = (a: DocumentRow, b: DocumentRow): boolean => {
    if (a === b) {
        return true;
    }
    const keys = Object.keys(a) as Array<keyof DocumentRow>;
    return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};
