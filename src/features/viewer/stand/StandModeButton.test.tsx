import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StandModeButton } from '@/features/viewer/stand/StandOverlay';

afterEach(cleanup);

describe('StandModeButton', () => {
    it('grows its icon-only phone target to 44×44 on a coarse pointer', () => {
        render(<StandModeButton />);
        expect(screen.getByRole('button', { name: 'Full screen' })).toHaveClass('pointer-coarse:hit-44');
    });

    it('labels itself at 15px, weight 500, like the other header text actions', () => {
        render(<StandModeButton />);
        const button = screen.getByRole('button', { name: 'Full screen' });
        expect(button).toHaveClass('text-[15px]!');
        expect(button).toHaveClass('font-medium!');
    });
});
