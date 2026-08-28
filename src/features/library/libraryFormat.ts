/**
 * "Today" / "Yesterday" / a short date for a score's last change.
 *
 * Shared by the list row and the shelf card. The year is omitted inside the
 * current year — a library is mostly recent, and "Mar 4" reads faster than
 * "Mar 4, 2026" in a meta line that is already carrying a page count.
 */
export const formatUpdated = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    const now = Date.now();
    const diffMs = now - date.getTime();
    const dayMs = 86_400_000;
    if (diffMs < dayMs && date.toDateString() === new Date().toDateString()) {
        return 'Today';
    }
    if (diffMs < dayMs * 2) {
        const yesterday = new Date(now - dayMs);
        if (date.toDateString() === yesterday.toDateString()) {
            return 'Yesterday';
        }
    }
    const sameYear = date.getFullYear() === new Date(now).getFullYear();
    return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        ...(sameYear ? {} : { year: 'numeric' as const }),
    });
};
