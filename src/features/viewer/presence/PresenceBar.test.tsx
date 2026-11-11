import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PresenceBar } from '@/features/viewer/presence/PresenceBar';
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
});
