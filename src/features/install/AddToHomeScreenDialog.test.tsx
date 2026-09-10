import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AddToHomeScreenDialog } from '@/features/install/AddToHomeScreenDialog';

afterEach(() => {
    cleanup();
});

describe('AddToHomeScreenDialog', () => {
    it('renders the Home Screen icon preview and numbered Safari steps', () => {
        render(<AddToHomeScreenDialog onClose={vi.fn()} surface="ios-safari" />);

        const dialog = screen.getByRole('dialog', { name: 'Add to Home Screen' });
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText('Cleffy')).toBeInTheDocument();
        expect(dialog.querySelector('img')?.getAttribute('src')).toBe('/icons/apple-touch-icon.png');
        expect(screen.getAllByRole('listitem')).toHaveLength(3);
        expect(screen.getByText('Add to Home Screen', { selector: 'span' })).toBeInTheDocument();
        expect(screen.getByText('Add', { selector: 'span' })).toBeInTheDocument();
        expect(screen.queryByText(/Open this page in Safari first/)).not.toBeInTheDocument();
    });

    it('leads with a Safari warning on other iOS browsers', () => {
        render(<AddToHomeScreenDialog onClose={vi.fn()} surface="ios-other" />);

        expect(
            screen.getByText('Open this page in Safari first — Home Screen shortcuts only work from Safari.'),
        ).toBeInTheDocument();
        expect(screen.getByText('Add to Home Screen', { selector: 'span' })).toBeInTheDocument();
    });

    it('tells a non-iOS session to open Safari on the iPhone or iPad', () => {
        render(<AddToHomeScreenDialog onClose={vi.fn()} surface="other" />);

        expect(screen.getByText('On the iPhone or iPad, open cleffy.io in Safari.')).toBeInTheDocument();
    });

    it('closes from the header button', async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        render(<AddToHomeScreenDialog onClose={onClose} surface="ios-safari" />);

        await user.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
