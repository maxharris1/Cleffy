import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StudioSeats } from '@/features/billing/StudioSeats';
import type { StudioRow } from '@/types/database';

const fetchOwnedStudio = vi.fn();
const fetchStudioSeats = vi.fn();
const fetchStudioSeatLimit = vi.fn();

vi.mock('@/features/billing/studiosService', () => ({
    fetchOwnedStudio: (...args: unknown[]) => fetchOwnedStudio(...args),
    fetchStudioSeats: (...args: unknown[]) => fetchStudioSeats(...args),
    fetchStudioSeatLimit: (...args: unknown[]) => fetchStudioSeatLimit(...args),
    createStudio: vi.fn(),
    inviteStudioMember: vi.fn(),
    removeStudioMember: vi.fn(),
}));

const studio: StudioRow = {
    id: 'studio-1',
    owner_id: 'owner-1',
    name: 'District',
    seat_limit: 5,
    created_at: '2026-10-20T00:00:00Z',
};

const seated = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ userId: `t-${i}`, email: `t${i}@example.invalid` }));

afterEach(cleanup);

beforeEach(() => {
    vi.clearAllMocks();
    fetchOwnedStudio.mockResolvedValue(studio);
});

describe('StudioSeats', () => {
    it("shows a district's contracted seat count, not the Academy cap", async () => {
        fetchStudioSeats.mockResolvedValue(seated(6));
        fetchStudioSeatLimit.mockResolvedValue(40);

        render(<StudioSeats userId="owner-1" tier="academy" source="subscription" />);

        expect(await screen.findByText(/7 of 40 seats used/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add teacher' })).toBeEnabled();
        expect(fetchStudioSeatLimit).toHaveBeenCalledWith('studio-1');
    });

    it('disables adding once the effective limit is reached', async () => {
        fetchStudioSeats.mockResolvedValue(seated(4));
        fetchStudioSeatLimit.mockResolvedValue(5);

        render(<StudioSeats userId="owner-1" tier="academy" source="subscription" />);

        expect(await screen.findByText(/5 of 5 seats used/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add teacher' })).toBeDisabled();
    });

    it("falls back to the studio's own limit when the seat-limit read fails", async () => {
        fetchStudioSeats.mockResolvedValue(seated(2));
        fetchStudioSeatLimit.mockRejectedValue(new Error('function studio_seat_limit does not exist'));

        render(<StudioSeats userId="owner-1" tier="academy" source="subscription" />);

        expect(await screen.findByText(/3 of 5 seats used/)).toBeInTheDocument();
        await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    });

    it('asks nothing for a teacher who is not an Academy owner', () => {
        render(<StudioSeats userId="teacher-1" tier="teacher" source="subscription" />);

        expect(fetchOwnedStudio).not.toHaveBeenCalled();
        expect(fetchStudioSeatLimit).not.toHaveBeenCalled();
    });
});
