import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Dialog } from '@/ui/Dialog';

afterEach(() => {
    cleanup();
});

describe('Dialog', () => {
    it('renders an aria-modal dialog with a visible title and closes on Escape', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(
            <Dialog label="Share this score" onClose={onClose}>
                <button type="button">Inside</button>
            </Dialog>,
        );
        const dialog = screen.getByRole('dialog', { name: 'Share this score' });
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(screen.getByRole('heading', { name: 'Share this score' })).toBeInTheDocument();
        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('moves focus into the dialog on mount and restores it on unmount', async () => {
        const outside = document.createElement('button');
        document.body.appendChild(outside);
        outside.focus();
        const { unmount } = render(
            <Dialog label="Confirm" onClose={() => {}}>
                <p>Body</p>
            </Dialog>,
        );
        // Base UI moves focus in once the popup has mounted.
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Confirm' })));
        unmount();
        await waitFor(() => expect(document.activeElement).toBe(outside));
        outside.remove();
    });

    it('closes on scrim click but not on panel click', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(
            <Dialog label="Share this score" onClose={onClose}>
                <p>Body</p>
            </Dialog>,
        );
        const dialog = screen.getByRole('dialog', { name: 'Share this score' });
        await user.click(dialog);
        expect(onClose).not.toHaveBeenCalled();
        const scrim = dialog.parentElement;
        expect(scrim).not.toBeNull();
        await user.click(scrim as HTMLElement);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('stays open when a press starts in the panel and ends on the scrim (a text selection dragged out)', () => {
        const onClose = vi.fn();
        render(
            <Dialog label="Rename score" onClose={onClose}>
                <input aria-label="Title" defaultValue="Clementi" />
            </Dialog>,
        );
        const field = screen.getByRole('textbox', { name: 'Title' });
        const scrim = screen.getByRole('dialog', { name: 'Rename score' }).parentElement as HTMLElement;
        // The browser targets click at the nearest common ancestor of the press
        // and the release — the scrim, when the drag ended outside the panel.
        fireEvent.pointerDown(field);
        fireEvent.pointerUp(scrim);
        fireEvent.click(scrim);
        expect(onClose).not.toHaveBeenCalled();

        // And the other way round: pressed on the scrim, released in the panel.
        fireEvent.pointerDown(scrim);
        fireEvent.click(field);
        expect(onClose).not.toHaveBeenCalled();

        // Press and release on the scrim: that is a dismissal.
        fireEvent.pointerDown(scrim);
        fireEvent.click(scrim);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes only the top dialog on Escape', async () => {
        const user = userEvent.setup();
        const onCloseBottom = vi.fn();
        const onCloseTop = vi.fn();
        render(
            <>
                <Dialog label="Share" onClose={onCloseBottom}>
                    <p>Bottom</p>
                </Dialog>
                <Dialog label="Remove access?" onClose={onCloseTop}>
                    <p>Top</p>
                </Dialog>
            </>,
        );
        await user.keyboard('{Escape}');
        expect(onCloseTop).toHaveBeenCalledTimes(1);
        expect(onCloseBottom).not.toHaveBeenCalled();
    });

    it('renders an alertdialog the scrim cannot dismiss', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(
            <Dialog label="Delete score?" onClose={onClose} alert>
                <p>Body</p>
            </Dialog>,
        );
        const dialog = screen.getByRole('alertdialog', { name: 'Delete score?' });
        await user.click(dialog.parentElement as HTMLElement);
        expect(onClose).not.toHaveBeenCalled();
        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes a phone sheet dragged down by its grab bar, and springs back from a short drag', () => {
        const onClose = vi.fn();
        render(
            <Dialog label="Lesson history" onClose={onClose} sheet>
                <p>Body</p>
            </Dialog>,
        );
        const grabber = document.querySelector('[data-sheet-grabber]') as HTMLElement;
        expect(grabber).not.toBeNull();

        fireEvent.pointerDown(grabber, { pointerId: 1, button: 0, clientY: 100 });
        fireEvent.pointerMove(grabber, { pointerId: 1, clientY: 118 });
        fireEvent.pointerUp(grabber, { pointerId: 1, clientY: 118 });
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.pointerDown(grabber, { pointerId: 2, button: 0, clientY: 100 });
        fireEvent.pointerMove(grabber, { pointerId: 2, clientY: 260 });
        fireEvent.pointerUp(grabber, { pointerId: 2, clientY: 260 });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
