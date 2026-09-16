import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PlayAlongProgress } from '@/features/playback/PlayAlongProgress';

afterEach(cleanup);

const stepLabels = () =>
    within(screen.getByRole('list', { name: /preparing your play-along/i }))
        .getAllByRole('listitem')
        .map((item) => item.textContent?.trim());

const currentStep = () =>
    within(screen.getByRole('list', { name: /preparing your play-along/i }))
        .getAllByRole('listitem')
        .find((item) => item.getAttribute('aria-current') === 'step')
        ?.textContent?.trim();

describe('PlayAlongProgress', () => {
    it('draws no queue step for an analysis that was never seen waiting', () => {
        render(<PlayAlongProgress stage="analyzing" />);
        expect(stepLabels()).toEqual(['Analyzing', 'Ready']);
        expect(currentStep()).toBe('Analyzing');
        expect(screen.getByRole('status')).toHaveTextContent('Analyzing score…');
    });

    it('draws Queued for analysis only when the job is (or was) actually waiting', () => {
        const { unmount } = render(<PlayAlongProgress stage="queued" />);
        expect(stepLabels()).toEqual(['Queued for analysis', 'Analyzing', 'Ready']);
        expect(currentStep()).toBe('Queued for analysis');
        expect(screen.getByRole('status')).toHaveTextContent(/every worker is busy/i);
        expect(screen.getByRole('status')).not.toHaveTextContent(/#|\d/);
        unmount();

        render(<PlayAlongProgress stage="analyzing" queued progress={2} pageCount={4} />);
        expect(stepLabels()).toEqual(['Queued for analysis', 'Analyzing', 'Ready']);
        expect(currentStep()).toBe('Analyzing');
    });

    it('reports page progress while analyzing, only once there is some', () => {
        const { unmount } = render(<PlayAlongProgress stage="analyzing" progress={3} pageCount={12} />);
        expect(screen.getByRole('status')).toHaveTextContent('Analyzing score… 3 / 12 pages');
        unmount();

        render(<PlayAlongProgress stage="analyzing" progress={0} pageCount={12} />);
        expect(screen.getByRole('status')).toHaveTextContent('Analyzing score…');
        expect(screen.getByRole('status')).not.toHaveTextContent(/pages/);
    });

    it('marks every step done at ready', () => {
        render(<PlayAlongProgress stage="ready" />);
        expect(currentStep()).toBe('Ready');
        expect(screen.getByRole('status')).toHaveTextContent('Ready to play.');
    });
});
