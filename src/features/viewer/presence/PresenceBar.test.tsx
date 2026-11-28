import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LinkViewerCount, PresenceBar } from '@/features/viewer/presence/PresenceBar';
import { anonymousName } from '@/features/share/anonymousAnimals';
import { presenceLabel } from '@/lib/presenceName';
import type { PresencePeer } from '@/sync/wire';

afterEach(cleanup);

const peer = (userId: string, name: string, page = 0): PresencePeer => ({
    userId,
    name,
    color: '#4338ca',
    page,
    isAnonymous: false,
});

const atWidth = (width: number) => {
    vi.stubGlobal('matchMedia', (query: string) => {
        const min = /min-width:\s*([\d.]+)rem/.exec(query);
        return {
            matches: min ? width >= Number(min[1]) * 16 : false,
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        };
    });
};

const crowd = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
        ...peer(`p${i}`, `Alexandria Williamson ${String(i).padStart(2, '0')}`, i),
        color: `#0000${String(i).padStart(2, '0')}`,
    }));

describe('PresenceBar', () => {
    it('lists everyone but me as a chip that names them and their page', () => {
        render(<PresenceBar peers={[peer('me', 'Me'), peer('a', 'Ada Lovelace', 2)]} selfUserId="me" />);
        expect(screen.getByRole('button', { name: 'Ada Lovelace, on page 3' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Me/ })).not.toBeInTheDocument();
    });

    it('names each person on their chip, with a touch target 44px tall that never overlaps a neighbour', () => {
        render(<PresenceBar peers={[peer('a', 'Ada Lovelace'), peer('b', 'Bo Diddley')]} selfUserId="me" />);
        const group = screen.getByLabelText('2 collaborators viewing');
        expect(group).toHaveClass('gap-x-1.5');
        expect(group).toHaveClass('gap-y-1.5');
        expect(group).toHaveClass('pointer-coarse:gap-y-3.5');
        expect(screen.getByRole('button', { name: 'Ada Lovelace, on page 1' })).toHaveTextContent('Ada Lovelace');
        expect(screen.getByRole('button', { name: 'Bo Diddley, on page 1' })).toHaveTextContent('Bo Diddley');
        for (const chip of screen.getAllByRole('button')) {
            expect(chip).toHaveClass('pointer-coarse:hit-44-y');
        }
    });

    it('wraps its chips within the width it is given', () => {
        render(<PresenceBar peers={[peer('a', 'Alexandria Williamson')]} selfUserId="me" />);
        const group = screen.getByLabelText('1 collaborators viewing');
        expect(group).toHaveClass('flex-wrap');
        expect(group).toHaveClass('min-w-0');
        expect(group).toHaveClass('max-w-full');
    });

    it('sits before the sync status and Full screen on desktop', () => {
        render(<PresenceBar peers={[peer('a', 'Ms. Davis'), peer('b', 'Leo')]} selfUserId="me" />);
        expect(screen.getByLabelText('2 collaborators viewing')).toHaveClass('lg:-order-1');
    });

    it('labels a non-member Anonymous <animal> through presenceLabel, whatever it claims (R4)', () => {
        const members = new Set(['me', 'a']);
        render(
            <PresenceBar
                peers={[peer('a', 'Ada Lovelace'), { ...peer('x', 'Ms Rivera'), isAnonymous: true, via: 'link' }]}
                selfUserId="me"
                labelOf={(p) => presenceLabel(p, members)}
            />,
        );
        expect(screen.getByRole('button', { name: `${anonymousName('x')}, on page 1` })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Ms Rivera/ })).not.toBeInTheDocument();
    });
});

describe('PresenceBar in a crowd', () => {
    it.each([
        [390, 1, 1, null],
        [390, 3, 2, '+1'],
        [390, 4, 2, '+2'],
        [390, 16, 2, '+14'],
        [1440, 1, 1, null],
        [1440, 3, 3, null],
        [1440, 4, 3, '+1'],
        [1440, 16, 3, '+13'],
    ])('at %ipx with %i people shows %i named chips, in order, then %s', (width, count, named, more) => {
        atWidth(width);
        const peers = crowd(count);
        render(<PresenceBar peers={peers} selfUserId="me" />);
        const group = screen.getByLabelText(`${count} collaborators viewing`);
        const chips = within(group).getAllByRole('button');
        const shown = peers.slice(0, named).map((p) => p.name);
        expect(chips.map((chip) => chip.textContent)).toEqual(more ? [...shown, more] : shown);
        if (more) {
            expect(chips.at(-1)).toHaveAccessibleName(`${count - named} more collaborators`);
        } else {
            expect(within(group).queryByRole('button', { name: /more collaborators/ })).toBeNull();
        }
    });

    it('lists everyone not shown, with their colour, name and page, from a click on "+N"', async () => {
        atWidth(1440);
        render(<PresenceBar peers={crowd(5)} selfUserId="me" />);
        await userEvent.click(screen.getByRole('button', { name: '2 more collaborators' }));
        const list = await screen.findByRole('list', { name: '2 more collaborators' });
        const rows = within(list).getAllByRole('listitem');
        expect(rows.map((row) => row.textContent)).toEqual([
            'Alexandria Williamson 03Page 4',
            'Alexandria Williamson 04Page 5',
        ]);
        expect(rows[0]?.querySelector('[aria-hidden="true"]')).toHaveStyle({ backgroundColor: '#000003' });
        expect(list.closest('.dialog-paper')).not.toBeNull();
    });

    it('opens "+N" from the keyboard, after the named chips, and Escape hands focus back to it', async () => {
        atWidth(1440);
        render(<PresenceBar peers={crowd(16)} selfUserId="me" />);
        const user = userEvent.setup();
        await user.tab();
        await user.tab();
        await user.tab();
        await user.tab();
        const more = screen.getByRole('button', { name: '13 more collaborators' });
        expect(more).toHaveFocus();
        await user.keyboard('{Enter}');
        expect(await screen.findByRole('list', { name: '13 more collaborators' })).toBeInTheDocument();
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('list', { name: '13 more collaborators' })).toBeNull();
        expect(more).toHaveFocus();
    });

    it('gives "+N" a 44px touch target and keeps the group to its named chips and one more', () => {
        atWidth(390);
        render(<PresenceBar peers={crowd(16)} selfUserId="me" />);
        expect(screen.getByRole('button', { name: '14 more collaborators' })).toHaveClass(
            'pointer-coarse:hit-44-y',
            'min-w-11',
        );
        expect(screen.getAllByRole('button')).toHaveLength(3);
    });

    it.each([390, 1440])(
        'narrows the names once three people are here, so the group fits the header at %ipx',
        (width) => {
            atWidth(width);
            const { rerender } = render(<PresenceBar peers={crowd(2)} selfUserId="me" />);
            expect(screen.getByText('Alexandria Williamson 00')).toHaveClass('max-w-40');
            for (const count of [3, 4, 16]) {
                rerender(<PresenceBar peers={crowd(count)} selfUserId="me" />);
                expect(screen.getByText('Alexandria Williamson 00')).toHaveClass('max-w-20', 'sm:max-w-32');
                expect(screen.getByText('Alexandria Williamson 00')).not.toHaveClass('max-w-40');
            }
        },
    );
});

describe('LinkViewerCount', () => {
    it('counts distinct view-link peers only, and shows nothing at zero', () => {
        const linkPeer = (id: string): PresencePeer => ({ ...peer(id, 'x'), isAnonymous: true, via: 'link' });
        const { rerender } = render(<LinkViewerCount peers={[peer('a', 'Ada')]} />);
        expect(screen.queryByText(/viewing/)).toBeNull();
        rerender(<LinkViewerCount peers={[peer('a', 'Ada'), linkPeer('v1'), linkPeer('v2'), linkPeer('v2')]} />);
        expect(screen.getByText('2 viewing')).toBeInTheDocument();
    });
});
