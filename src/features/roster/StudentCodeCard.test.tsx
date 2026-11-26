import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StudentCodeCard } from '@/features/roster/StudentCodeCard';

describe('StudentCodeCard', () => {
    afterEach(cleanup);

    it('names the teacher it came from and walks the student through steps A to C', () => {
        render(<StudentCodeCard displayName="Leo Martin" loginCode="K7QM-2HXP-9RTD" teacherName="Ms. Davis" />);

        expect(screen.getByText('From Ms. Davis')).toBeInTheDocument();
        const steps = screen.getAllByRole('listitem');
        expect(steps.map((step) => step.textContent)).toEqual([
            `AGo to ${window.location.origin}/student/claim`,
            'BType this setup codeK7QM-2HXP-9RTD',
            'CChoose a username and a password. That’s it.',
        ]);
        expect(screen.getByText('Keep this card. The code works once and is never shown again.')).toBeInTheDocument();
    });

    it('leaves the From line off when the teacher has no display name', () => {
        render(<StudentCodeCard displayName="Leo Martin" loginCode="K7QM-2HXP-9RTD" />);

        expect(screen.queryByText(/^From /)).not.toBeInTheDocument();
    });
});
