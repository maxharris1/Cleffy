import { fireEvent, screen } from '@testing-library/react';

/**
 * Answer the age screen (src/features/auth/AgeScreen.tsx) as an adult in the
 * United States, so a test about what comes after it can get there.
 */
export const passAgeScreen = async (country = 'US', year = '1990'): Promise<void> => {
    fireEvent.change(await screen.findByLabelText('Where do you live?'), { target: { value: country } });
    fireEvent.change(screen.getByLabelText('Birth month'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Birth year'), { target: { value: year } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
};
