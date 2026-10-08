import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncHeldNotice, SyncRejectedNotice } from '@/features/viewer/SyncRejectedNotice';

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

describe('SyncHeldNotice', () => {
    it('renders nothing when nothing is being held', () => {
        const { container } = render(<SyncHeldNotice count={0} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('says the changes are kept on this device, not undone', () => {
        render(<SyncHeldNotice count={3} />);
        const notice = screen.getByRole('status');
        expect(notice).toHaveTextContent(
            'This score is archived and read-only, so 3 changes you made to it are saved only on this device.',
        );
        expect(notice).toHaveTextContent('They upload automatically once the score is restored');
        expect(notice).not.toHaveTextContent('undone');
        // Standing state, not a one-off event: nothing to dismiss.
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
});
