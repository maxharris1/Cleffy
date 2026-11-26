import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Badge } from '@/ui/Badge';

afterEach(cleanup);

describe('Badge', () => {
    it('Due/Invited reads in the reference brown with the reference spacing', () => {
        render(<Badge tone="warn">Invited</Badge>);
        expect(screen.getByText('Invited')).toHaveClass('text-due', 'px-[9px]', 'tracking-[0.02em]');
    });

    it('Done reads in the deep green that holds AA on its tint', () => {
        render(<Badge tone="ok">edit</Badge>);
        expect(screen.getByText('edit')).toHaveClass('bg-tick/10', 'text-done');
    });

    it('never wraps or shrinks beside a long neighbour', () => {
        render(<Badge tone="ok">Visible to student</Badge>);
        expect(screen.getByText('Visible to student')).toHaveClass('whitespace-nowrap', 'shrink-0');
    });
});
