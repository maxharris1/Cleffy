import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StudioSeats } from '@/features/billing/StudioSeats';
import type { StudioSeatState } from '@/features/billing/studiosService';
import type { StudioRow } from '@/types/database';

const fetchOwnedStudio = vi.fn();
const fetchStudioSeats = vi.fn();
const fetchStudioSeatLimit = vi.fn();
const fetchStudioSeatStatus = vi.fn();
const setActiveStudioSeats = vi.fn();

vi.mock('@/features/billing/studiosService', () => ({
    fetchOwnedStudio: (...args: unknown[]) => fetchOwnedStudio(...args),
    fetchStudioSeats: (...args: unknown[]) => fetchStudioSeats(...args),
    fetchStudioSeatLimit: (...args: unknown[]) => fetchStudioSeatLimit(...args),
    fetchStudioSeatStatus: (...args: unknown[]) => fetchStudioSeatStatus(...args),
    setActiveStudioSeats: (...args: unknown[]) => setActiveStudioSeats(...args),
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

/** The first `active` seats are active, the rest read-only, as the server ranks them. */
const statusOf = (count: number, active: number) =>
    new Map<string, StudioSeatState>(
        Array.from({ length: count }, (_, i) => [`t-${i}`, { active: i < active, kept: false }]),
    );

afterEach(cleanup);

beforeEach(() => {
    vi.clearAllMocks();
    fetchOwnedStudio.mockResolvedValue(studio);
    fetchStudioSeatStatus.mockResolvedValue(new Map());
    setActiveStudioSeats.mockResolvedValue(undefined);
});

describe('StudioSeats', () => {
    it("shows a district's contracted seat count, not the Academy cap", async () => {
        fetchStudioSeats.mockResolvedValue(seated(6));
        fetchStudioSeatLimit.mockResolvedValue(40);
        fetchStudioSeatStatus.mockResolvedValue(statusOf(6, 6));

        render(<StudioSeats userId="owner-1" tier="academy" source="subscription" />);

        expect(await screen.findByText(/7 of 40 seats used/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add teacher' })).toBeEnabled();
        expect(fetchStudioSeatLimit).toHaveBeenCalledWith('studio-1');
        // Inside the limit there is nothing to choose.
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
        expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
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
        fetchStudioSeatStatus.mockRejectedValue(new Error('function studio_seat_status does not exist'));

        render(<StudioSeats userId="owner-1" tier="academy" source="subscription" />);

        expect(await screen.findByText(/3 of 5 seats used/)).toBeInTheDocument();
        await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
        expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
    });

    it('asks nothing for a teacher who is not an Academy owner', () => {
        render(<StudioSeats userId="teacher-1" tier="teacher" source="subscription" />);

        expect(fetchOwnedStudio).not.toHaveBeenCalled();
        expect(fetchStudioSeatLimit).not.toHaveBeenCalled();
    });

    it('marks the seats past the limit read-only and lets the owner choose who stays active', async () => {
        // A district lowered to the Academy cap: 8 teachers, 4 active seats.
        fetchStudioSeats.mockResolvedValue(seated(8));
        fetchStudioSeatLimit.mockResolvedValue(5);
        fetchStudioSeatStatus.mockResolvedValue(statusOf(8, 4));

        render(<StudioSeats userId="owner-1" tier="academy" source="subscription" />);

        expect(await screen.findByText(/4 teachers are read-only/)).toBeInTheDocument();
        expect(screen.getAllByText('Read-only')).toHaveLength(4);
        expect(screen.getByText('4 of 4 ticked')).toBeInTheDocument();

        const save = screen.getByRole('button', { name: 'Save active seats' });
        // Nothing changed yet.
        expect(save).toBeDisabled();

        // Tick a fifth: one more than the seats allow.
        fireEvent.click(screen.getByRole('checkbox', { name: 'Keep t6@example.invalid active' }));
        expect(screen.getByText('5 of 4 ticked')).toBeInTheDocument();
        expect(save).toBeDisabled();

        // Swap t0 out for t6.
        fireEvent.click(screen.getByRole('checkbox', { name: 'Keep t0@example.invalid active' }));
        expect(save).toBeEnabled();
        fireEvent.click(save);

        await waitFor(() => expect(setActiveStudioSeats).toHaveBeenCalledTimes(1));
        const [studioId, kept] = setActiveStudioSeats.mock.calls[0] as [string, string[]];
        expect(studioId).toBe('studio-1');
        expect([...kept].sort()).toEqual(['t-1', 't-2', 't-3', 't-6']);
    });

    it('still shows a lapsed district owner their seats to choose from, without adding', async () => {
        fetchStudioSeats.mockResolvedValue(seated(6));
        fetchStudioSeatLimit.mockResolvedValue(5);
        fetchStudioSeatStatus.mockResolvedValue(statusOf(6, 4));

        render(<StudioSeats userId="owner-1" tier="free" source="none" />);

        expect(await screen.findByText(/2 teachers are read-only/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save active seats' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Add teacher' })).not.toBeInTheDocument();
        expect(screen.getByText(/no teachers can be added/)).toBeInTheDocument();
    });

    it('shows a free account that owns no academy nothing', async () => {
        fetchOwnedStudio.mockResolvedValue(null);

        const { container } = render(<StudioSeats userId="free-1" tier="free" source="none" />);

        await waitFor(() => expect(fetchOwnedStudio).toHaveBeenCalledWith('free-1'));
        expect(container).toBeEmptyDOMElement();
    });

    it('tells a read-only seated teacher what they can still do', () => {
        render(<StudioSeats userId="teacher-1" tier="free" source="studio_member" seatReadOnly />);

        expect(screen.getByText(/your seat is read-only/)).toBeInTheDocument();
        expect(screen.getByText(/open and export your scores/)).toBeInTheDocument();
        expect(fetchOwnedStudio).not.toHaveBeenCalled();
    });
});
