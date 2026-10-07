import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncRejectedNotice } from '@/features/viewer/SyncRejectedNotice';

afterEach(() => {
    cleanup();
});

describe('SyncRejectedNotice', () => {
    it('renders nothing when no change was refused', () => {
        const { container } = render(<SyncRejectedNotice count={0} onDismiss={() => undefined} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('tells the user a change was undone, without blocking the score', async () => {
        const user = userEvent.setup();
        const onDismiss = vi.fn();
        render(<SyncRejectedNotice count={1} onDismiss={onDismiss} />);

        const notice = screen.getByRole('status');
        expect(notice).toHaveTextContent('One of your changes could not be saved to this score and was undone.');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('counts several refused marks', () => {
        render(<SyncRejectedNotice count={4} onDismiss={() => undefined} />);
        expect(screen.getByRole('status')).toHaveTextContent(
            '4 of your changes could not be saved to this score and were undone.',
        );
    });
});
