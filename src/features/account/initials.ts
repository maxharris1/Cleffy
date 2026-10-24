/**
 * Graphemes, not UTF-16 code units: `slice(0, 1)` cut an emoji or an accented
 * letter written with a combining mark in half and drew a replacement box.
 */
const graphemes = (text: string): string[] => {
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        return Array.from(segmenter.segment(text), (part) => part.segment);
    }
    // Code points at least keep surrogate pairs whole.
    return Array.from(text);
};

/**
 * Two letters standing in for a face: the first letters of the first and last
 * words of a display name, else the opening of the local part of the email.
 * Never empty — an avatar with nothing in it reads as a broken image.
 *
 * The one implementation for every avatar — the top bar, the account page and
 * the viewer's presence chips — so the same person wears the same face.
 */
export const initialsOf = (label: string): string => {
    const words = label.trim().split(/\s+/).filter(Boolean);
    const first = words[0] ?? '';
    const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
    if (last) {
        return `${graphemes(first)[0] ?? ''}${graphemes(last)[0] ?? ''}`.toLocaleUpperCase();
    }
    const localPart = first.split('@')[0] ?? '';
    return graphemes(localPart).slice(0, 2).join('').toLocaleUpperCase() || '?';
};
