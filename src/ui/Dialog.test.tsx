import { cleanup, render, screen } from '@testing-library/react';
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

    it('moves focus into the dialog on mount and restores it on unmount', () => {
        const outside = document.createElement('button');
        document.body.appendChild(outside);
        outside.focus();
        const { unmount } = render(
            <Dialog label="Confirm" onClose={() => {}}>
                <p>Body</p>
            </Dialog>,
        );
        expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Confirm' }));
        unmount();
        expect(document.activeElement).toBe(outside);
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
});
