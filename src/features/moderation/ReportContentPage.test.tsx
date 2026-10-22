import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ModerationApi from '@/features/moderation/moderationApi';

const submit = vi.hoisted(() => vi.fn());

vi.mock('@/features/moderation/moderationApi', async (importOriginal) => ({
    ...(await importOriginal<typeof ModerationApi>()),
    submitContentReport: submit,
}));

import { ReportContentPage } from '@/features/moderation/ReportContentPage';

const renderPage = (path = '/report') =>
    render(
        <MemoryRouter initialEntries={[path]}>
            <ReportContentPage />
        </MemoryRouter>,
    );

const fillCommon = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(
        screen.getByLabelText(/How the score infringes it|Why the content is illegal/),
        'Copied page for page.',
    );
    await user.type(screen.getByLabelText('Your name'), 'Ada Rights');
    await user.type(screen.getByLabelText('Your email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Signature: type your full name'), 'Ada Rights');
};

describe('ReportContentPage', () => {
    afterEach(() => {
        cleanup();
        submit.mockReset();
    });

    it('works signed out, prefilled from ?url=, and asks for the DMCA statements on a copyright report', () => {
        renderPage('/report?url=https%3A%2F%2Fcleffy.io%2Fdoc%2Fabc');
        expect(screen.getByRole('heading', { level: 1, name: 'Report content' })).toBeInTheDocument();
        expect(screen.getByLabelText('Link to the score')).toHaveValue('https://cleffy.io/doc/abc');
        expect(screen.getByLabelText('The copyrighted work')).toBeInTheDocument();
        expect(screen.getByLabelText(/under penalty of perjury/)).toBeInTheDocument();
    });

    it('refuses to send until the statements are confirmed', async () => {
        const user = userEvent.setup();
        renderPage('/report?url=https%3A%2F%2Fcleffy.io%2Fdoc%2Fabc');
        await user.type(screen.getByLabelText('The copyrighted work'), 'Sonata, 2019 edition');
        await fillCommon(user);
        await user.click(screen.getByLabelText(/I believe in good faith/));
        await user.click(screen.getByRole('button', { name: 'Send report' }));
        expect(screen.getByText('Confirm the statements above to send the report.')).toBeInTheDocument();
        expect(submit).not.toHaveBeenCalled();
    });

    it('sends an illegal-content report with its category, and shows the reference', async () => {
        submit.mockResolvedValue({ reference: 'CR-ABCDEF1234', acknowledged: true });
        const user = userEvent.setup();
        renderPage('/report?url=https%3A%2F%2Fcleffy.io%2Fdoc%2Fabc');
        await user.click(screen.getByLabelText(/Illegal content/));
        expect(screen.queryByLabelText(/under penalty of perjury/)).not.toBeInTheDocument();
        await user.selectOptions(screen.getByLabelText('What is the content?'), 'hate');
        await fillCommon(user);
        await user.click(screen.getByLabelText(/I believe in good faith/));
        await user.click(screen.getByRole('button', { name: 'Send report' }));

        expect(await screen.findByRole('heading', { name: 'Report received' })).toBeInTheDocument();
        expect(screen.getByText('CR-ABCDEF1234')).toBeInTheDocument();
        expect(submit).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'illegal',
                category: 'hate',
                contentUrl: 'https://cleffy.io/doc/abc',
                goodFaith: true,
                perjuryStatement: false,
            }),
            null,
        );
    });

    it('says a queued confirmation goes out as soon as possible, with no deadline it cannot keep', async () => {
        // The acknowledgment budget can be spent for the rest of the day, and
        // nothing guarantees a backlog clears in any fixed time (Codex r2 Part A),
        // so neither "shortly" nor "within 24 hours".
        submit.mockResolvedValue({ reference: 'CR-QUEUED0001', acknowledged: false });
        const user = userEvent.setup();
        renderPage('/report?url=https%3A%2F%2Fcleffy.io%2Fdoc%2Fabc');
        await user.click(screen.getByLabelText(/Illegal content/));
        await user.selectOptions(screen.getByLabelText('What is the content?'), 'hate');
        await fillCommon(user);
        await user.click(screen.getByLabelText(/I believe in good faith/));
        await user.click(screen.getByRole('button', { name: 'Send report' }));

        expect(await screen.findByRole('heading', { name: 'Report received' })).toBeInTheDocument();
        const note = screen.getByText(/We've received your report and will email a confirmation/);
        expect(note).toHaveTextContent('as soon as possible');
        expect(note).toHaveTextContent('ada@example.com');
        expect(note).not.toHaveTextContent('shortly');
        expect(note).not.toHaveTextContent(/\d+ hours/);
    });
});
