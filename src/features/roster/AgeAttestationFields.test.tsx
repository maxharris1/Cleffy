import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgeAttestationFields } from '@/features/roster/AgeAttestationFields';

afterEach(cleanup);

const NOTE =
    'Students under the minimum age can’t have a Cleffy account. You can still use Cleffy with them in lessons by showing the score on your own screen.';

describe('AgeAttestationFields', () => {
    it.each(['', 'US'])('tells the teacher how to teach a younger student (country %j)', (country) => {
        render(
            <AgeAttestationFields
                idPrefix="test"
                country={country}
                onCountryChange={vi.fn()}
                confirmed={false}
                onConfirmedChange={vi.fn()}
            />,
        );
        expect(screen.getByText(NOTE)).toBeInTheDocument();
    });

    it('keeps the attestation sentence as it was', () => {
        render(
            <AgeAttestationFields
                idPrefix="test"
                country="US"
                onCountryChange={vi.fn()}
                confirmed={false}
                onConfirmedChange={vi.fn()}
            />,
        );
        expect(screen.getByRole('checkbox')).toBeInTheDocument();
        expect(screen.getByText(/at least 13/)).toBeInTheDocument();
    });
});
