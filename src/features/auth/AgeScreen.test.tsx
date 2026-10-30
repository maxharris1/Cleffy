import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ageCheckBlocked, ageGateFor, isCertainlyAtLeast, rememberAgeCheckRefusal } from '@/features/auth/ageCheck';
import { AgeScreen } from '@/features/auth/AgeScreen';
import { passAgeScreen } from '@/test/ageScreen';

afterEach(() => {
    cleanup();
    window.localStorage.clear();
});

describe('isCertainlyAtLeast', () => {
    const now = new Date(2026, 9, 21); // 21 October 2026

    it('passes once the birthday month is over', () => {
        expect(isCertainlyAtLeast(2013, 9, 13, now)).toBe(true); // September 2013
        expect(isCertainlyAtLeast(1990, 1, 16, now)).toBe(true);
    });

    it('refuses in the birthday month itself, when the day is unknown', () => {
        expect(isCertainlyAtLeast(2013, 10, 13, now)).toBe(false);
    });

    it('refuses before the birthday month', () => {
        expect(isCertainlyAtLeast(2013, 11, 13, now)).toBe(false);
        expect(isCertainlyAtLeast(2011, 1, 16, now)).toBe(false);
    });
});

describe('ageGateFor', () => {
    it('keeps the country and its age, nothing about the birthday', () => {
        expect(ageGateFor('de')).toEqual({ country: 'DE', min_age: 16, source: 'self', v: 1 });
        expect(ageGateFor('US')).toEqual({ country: 'US', min_age: 13, source: 'self', v: 1 });
    });
});

describe('the refusal memory', () => {
    it('lasts a day', () => {
        const at = Date.UTC(2026, 9, 21);
        rememberAgeCheckRefusal(at);
        expect(ageCheckBlocked(at + 60_000)).toBe(true);
        expect(ageCheckBlocked(at + 25 * 60 * 60 * 1000)).toBe(false);
    });

    it('forgets quietly when storage throws', () => {
        const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied');
        });
        expect(ageCheckBlocked()).toBe(false);
        spy.mockRestore();
    });
});

describe('AgeScreen', () => {
    const renderScreen = () => {
        const onPass = vi.fn();
        render(
            <MemoryRouter>
                <AgeScreen purpose="register" onPass={onPass} />
            </MemoryRouter>,
        );
        return onPass;
    };

    it('asks for all three answers before checking anything', () => {
        const onPass = renderScreen();
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
        expect(screen.getByText('Choose your country, birth month and birth year.')).toBeInTheDocument();
        expect(onPass).not.toHaveBeenCalled();
    });

    it('hands on only the country and its age', async () => {
        const onPass = renderScreen();
        await passAgeScreen('FR', '1990');
        expect(onPass).toHaveBeenCalledExactlyOnceWith({ country: 'FR', min_age: 15, source: 'self', v: 1 });
    });

    it('refuses with a neutral message that names no age, and remembers it', async () => {
        const onPass = renderScreen();
        await passAgeScreen('DE', String(new Date().getFullYear() - 14));
        expect(onPass).not.toHaveBeenCalled();
        expect(screen.getByText('You can’t create a Cleffy account at this time.')).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/\b1[3-6]\b/);
        expect(ageCheckBlocked()).toBe(true);

        // A fresh visit within the day shows the same refusal, not the questions.
        cleanup();
        renderScreen();
        expect(screen.queryByLabelText('Where do you live?')).not.toBeInTheDocument();
        expect(screen.getByText('You can’t create a Cleffy account at this time.')).toBeInTheDocument();
    });

    it('lets a 15-year-old through where the age is 13', async () => {
        const onPass = renderScreen();
        await passAgeScreen('US', String(new Date().getFullYear() - 15));
        expect(onPass).toHaveBeenCalledWith(expect.objectContaining({ country: 'US', min_age: 13 }));
    });
});
