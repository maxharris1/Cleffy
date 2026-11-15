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

    it('stands the chips apart on touch, so no two 44px tap areas overlap', () => {
        render(<PresenceBar peers={[peer('a', 'Ada Lovelace'), peer('b', 'Bo Diddley')]} selfUserId="me" />);
        const row = screen.getByLabelText('2 collaborators viewing');
        // Overlapped with a mouse; 28px chips + a 16px gap on a coarse pointer.
        expect(row).toHaveClass('-space-x-1.5', 'pointer-coarse:space-x-0', 'pointer-coarse:gap-4');
        for (const chip of screen.getAllByRole('button')) {
            expect(chip).toHaveClass('h-7', 'w-7', 'pointer-coarse:hit-44');
        }
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
