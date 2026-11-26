import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

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

    it('gives every collaborator present a named chip in their ink colour, however many there are', () => {
        const names = ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5', 'Player 6'];
        render(
            <PresenceBar
                peers={names.map((name, i) => ({ ...peer(`p${i}`, name), color: `#00000${i}` }))}
                selfUserId="me"
            />,
        );
        const chips = screen.getAllByRole('button');
        expect(chips.map((chip) => chip.textContent)).toEqual(names);
        chips.forEach((chip, i) => {
            expect(chip.querySelector('[aria-hidden="true"]')).toHaveStyle({ backgroundColor: `#00000${i}` });
        });
        expect(screen.queryByText(/^\+\d/)).toBeNull();
    });

    it('wraps its chips within the width it is given', () => {
        render(<PresenceBar peers={[peer('a', 'Alexandria Williamson')]} selfUserId="me" />);
        const group = screen.getByLabelText('1 collaborators viewing');
        expect(group).toHaveClass('flex-wrap');
        expect(group).toHaveClass('min-w-0');
        expect(group).toHaveClass('max-w-full');
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

describe('LinkViewerCount', () => {
    it('counts distinct view-link peers only, and shows nothing at zero', () => {
        const linkPeer = (id: string): PresencePeer => ({ ...peer(id, 'x'), isAnonymous: true, via: 'link' });
        const { rerender } = render(<LinkViewerCount peers={[peer('a', 'Ada')]} />);
        expect(screen.queryByText(/viewing/)).toBeNull();
        rerender(<LinkViewerCount peers={[peer('a', 'Ada'), linkPeer('v1'), linkPeer('v2'), linkPeer('v2')]} />);
        expect(screen.getByText('2 viewing')).toBeInTheDocument();
    });
});
