import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PlayAlongProgress } from '@/features/playback/PlayAlongProgress';

afterEach(cleanup);

const stepLabels = () =>
    within(screen.getByRole('list', { name: /preparing your score/i }))
        .getAllByRole('listitem')
        .map((item) => item.textContent?.trim());

const currentStep = () =>
    within(screen.getByRole('list', { name: /preparing your score/i }))
        .getAllByRole('listitem')
        .find((item) => item.getAttribute('aria-current') === 'step')
        ?.textContent?.trim();

describe('PlayAlongProgress', () => {
    it('starts at the queue for scores that did not come from IMSLP', () => {
        render(<PlayAlongProgress stage="queued" />);
        expect(stepLabels()).toEqual(['Queued', 'Analyzing', 'Ready']);
        expect(currentStep()).toBe('Queued');
        expect(screen.getByRole('status')).toHaveTextContent('In queue — waiting for an analysis slot.');
    });

    it('adds the IMSLP download as the first step for imported scores', () => {
        render(<PlayAlongProgress stage="downloading" fromImslp />);
        expect(stepLabels()).toEqual(['Download', 'Queued', 'Analyzing', 'Ready']);
        expect(currentStep()).toBe('Download');
        expect(screen.getByRole('status')).toHaveTextContent('Downloading from IMSLP…');
    });

    it('says queued without inventing a position', () => {
        render(<PlayAlongProgress stage="queued" fromImslp />);
        expect(screen.getByRole('status')).toHaveTextContent(/in queue/i);
        expect(screen.getByRole('status')).not.toHaveTextContent(/#|\d/);
    });

    it('reports page progress while analyzing, only once there is some', () => {
        const { unmount } = render(<PlayAlongProgress stage="analyzing" progress={3} pageCount={12} />);
        expect(currentStep()).toBe('Analyzing');
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
