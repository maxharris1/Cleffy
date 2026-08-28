/**
 * Two letters standing in for a face: first initials of a two-word display
 * name, else the opening of the local part of the email. Never empty — an
 * avatar with nothing in it reads as a broken image.
 *
 * The top bar keeps its own copy of this logic; both must agree, because the
 * small avatar in the bar and the large one on this page are the same face.
 */
export const initialsOf = (label: string): string => {
    const words = label.trim().split(/\s+/).filter(Boolean);
    const first = words[0] ?? '';
    const second = words[1];
    if (second) {
        return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase();
    }
    const localPart = first.split('@')[0] ?? '';
    return localPart.slice(0, 2).toUpperCase() || '?';
};
