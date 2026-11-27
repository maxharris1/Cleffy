import { readFileSync } from 'node:fs';

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

    it('draws the wordmark rule with a border, which prints with backgrounds off', () => {
        const { container } = render(<StudentCodeCard displayName="Leo Martin" loginCode="K7QM-2HXP-9RTD" />);

        const rule = container.querySelector('.student-code-card-rule');
        expect(rule).toHaveClass('border-t-2', 'border-accent');
        expect(rule?.className).not.toMatch(/(^|\s)bg-/);
    });

    it('keeps the 12 px card padding around the inset frame on paper', () => {
        const css = readFileSync(`${process.cwd()}/src/features/roster/StudentCodeCard.css`, 'utf8');
        const printCard = /@media print[\s\S]*?\.student-code-card \{([^}]*)\}/.exec(css)?.[1] ?? '';

        expect(printCard).toMatch(/padding:\s*12px;/);
    });
});
