/** Covers this page has already shown: coming back to them is not an arrival (CoverImage). */
const shown = new Set<string>();

export const wasCoverShown = (key: string): boolean => shown.has(key);

export const noteCoverShown = (key: string): void => {
    shown.add(key);
};

/** For tests: forget which covers this page has shown. */
export const resetShownCoversForTests = (): void => shown.clear();
