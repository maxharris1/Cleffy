import type { KeyboardEvent } from 'react';

/**
 * Arrow-key movement for a hand-built role="menu" that lives inside a popover
 * (the export menu, whose notices sit beside the items and so cannot be
 * inside a Base UI menu). Up/Down wrap, Home/End jump.
 */
export const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) {
        return;
    }
    const items = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
            '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
        ),
    );
    if (items.length === 0) {
        return;
    }
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
        event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : event.key === 'ArrowDown'
                ? (current + 1) % items.length
                : (current - 1 + items.length) % items.length;
    items[next]?.focus();
};
