import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ModerationApi from '@/features/moderation/moderationApi';
import type { ContentReportRow, Page, TakedownRow, TimeCursor } from '@/features/moderation/moderationApi';

const api = vi.hoisted(() => ({
    isContentModerator: vi.fn(),
    fetchReportsPage: vi.fn(),
    fetchTakedownsPage: vi.fn(),
    fetchNoticeLogPage: vi.fn(),
    moderate: vi.fn(),
}));

vi.mock('@/features/moderation/moderationApi', async (importOriginal) => ({
    ...(await importOriginal<typeof ModerationApi>()),
    ...api,
}));

import { ModerationPage } from '@/features/moderation/ModerationPage';

const report = (n: number, status: ContentReportRow['status'] = 'received'): ContentReportRow => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    reference: `CR-${String(n).padStart(10, '0')}`,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    kind: 'illegal',
    category: 'other',
    content_url: `https://cleffy.io/doc/${n}`,
    document_id: null,
    document_title: null,
    work_description: null,
    explanation: `Report number ${n}`,
    reporter_name: 'Ada Rights',
    reporter_email: 'ada@example.com',
    reporter_address: '1 Main St',
    reporter_phone: '555-0100',
    on_behalf_of: null,
    reporter_user_id: null,
    good_faith: true,
    perjury_statement: false,
    signature: 'Ada Rights',
    status,
    decided_at: null,
    decision_note: null,
    acknowledged_at: null,
    active_takedown_id: null,
});

const takedown = (n: number): TakedownRow => ({
    id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    document_id: null,
    document_title: `Score ${n}`,
    report_id: null,
    uploader_id: null,
    action: 'restrict',
    ground: 'terms',
    legal_basis: 'Terms',
    facts: `Facts ${n}`,
    created_at: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(),
    lifted_at: null,
    lift_reason: null,
    uploader_active_strikes: 0,
});

const cursorOf = (row: { created_at: string; id: string }): TimeCursor => ({ created_at: row.created_at, id: row.id });

/** Serve `rows` 25 at a time, keyed on the cursor the page sends back, as the RPCs do. */
const pager =
    <Row extends { created_at: string; id: string }>(rows: Row[]) =>
    (_filter: string, after: TimeCursor | null): Promise<Page<Row, TimeCursor>> => {
        const start = after ? rows.findIndex((row) => row.id === after.id) + 1 : 0;
        const slice = rows.slice(start, start + 25);
        const last = slice.at(-1);
        return Promise.resolve({
            rows: slice,
            next: start + 25 < rows.length && last ? cursorOf(last) : null,
            total: rows.length,
        });
    };

const renderPage = () =>
    render(
        <MemoryRouter>
            <ModerationPage />
        </MemoryRouter>,
    );

describe('ModerationPage', () => {
    beforeEach(() => {
        api.isContentModerator.mockResolvedValue(true);
        api.fetchNoticeLogPage.mockResolvedValue({ rows: [], next: null, total: null });
    });

    afterEach(() => {
        cleanup();
        for (const fn of Object.values(api)) {
            fn.mockReset();
        }
    });

    // Long lists in jsdom: room beyond the 5 s default, as the library's long-list tests have.
    it(
        'reaches open reports and live takedowns beyond the first page, each still actionable',
        { timeout: 20_000 },
        async () => {
            // Three pages of each. The old moderation_queue() stopped at 200 rows,
            // hiding the rest and their controls; tests/sql/content_moderation.sql
            // walks 231 through the real RPCs, this walks the page's "Show more".
            const open = Array.from({ length: 60 }, (_, i) => report(i + 1));
            const live = Array.from({ length: 60 }, (_, i) => takedown(i + 1));
            api.fetchReportsPage.mockImplementation((filter: string, after: TimeCursor | null) =>
                filter === 'open' ? pager(open)(filter, after) : Promise.resolve({ rows: [], next: null, total: 0 }),
            );
            api.fetchTakedownsPage.mockImplementation((filter: string, after: TimeCursor | null) =>
                filter === 'active' ? pager(live)(filter, after) : Promise.resolve({ rows: [], next: null, total: 0 }),
            );
            const user = userEvent.setup();
            renderPage();

            expect(await screen.findByRole('heading', { name: 'Open reports (60)' })).toBeInTheDocument();
            expect(screen.getByRole('heading', { name: 'Live takedowns (60)' })).toBeInTheDocument();
            expect(screen.queryByText('Report number 60')).not.toBeInTheDocument();

            for (let page = 1; page < 3; page += 1) {
                await user.click(await screen.findByText('Show more open reports'));
            }
            const last = (await screen.findByText('Report number 60')).closest('li');
            expect(last).not.toBeNull();
            expect(within(last as HTMLElement).getByRole('button', { name: 'Take down…' })).toBeInTheDocument();
            expect(within(last as HTMLElement).getByRole('button', { name: 'Reject…' })).toBeInTheDocument();
            expect(screen.queryByText('Show more open reports')).not.toBeInTheDocument();
            // Every page asked for exactly the rows after the last one shown.
            expect(api.fetchReportsPage).toHaveBeenCalledWith('open', cursorOf(open[49] as ContentReportRow));

            for (let page = 1; page < 3; page += 1) {
                await user.click(await screen.findByText('Show more live takedowns'));
            }
            const oldest = (await screen.findByText('Facts 60')).closest('li');
            expect(within(oldest as HTMLElement).getByRole('button', { name: 'Lift…' })).toBeInTheDocument();
            expect(screen.getAllByText('Lift…')).toHaveLength(60);
        },
    );

    it('shows the complete notice as submitted', async () => {
        api.fetchReportsPage.mockImplementation((filter: string) =>
            Promise.resolve(
                filter === 'open' ? { rows: [report(1)], next: null, total: 1 } : { rows: [], next: null, total: 0 },
            ),
        );
        api.fetchTakedownsPage.mockResolvedValue({ rows: [], next: null, total: 0 });
        renderPage();
        const details = (await screen.findByText('Full notice as submitted')).closest('details') as HTMLElement;
        expect(within(details).getByText('1 Main St')).toBeInTheDocument();
        expect(within(details).getByText('555-0100')).toBeInTheDocument();
        expect(within(details).getByText('Under penalty of perjury').nextElementSibling).toHaveTextContent(
            'not confirmed',
        );
    });
});
