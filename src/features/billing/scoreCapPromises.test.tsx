import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { limitAction } from '@/features/billing/limitErrors';
import { TERMS_OF_SERVICE } from '@/features/legal/legalContent';
import { RowMenu } from '@/features/library/RowMenu';

/**
 * What Cleffy tells someone over their plan's score cap must only name things
 * they can actually do. The library's owner menu is the whole set of actions on
 * a score; the database un-archives a lapse only when the owner is entitled
 * again -- the Stripe webhook, or an Academy seat (restore_plan_archived_scores,
 * studio_members_restore_plan_archived, 20261007120300). Both the Terms ("…or
 * remove others") and the cap notice ("…or archive one") once promised an
 * action nobody could find.
 */

const noop = () => undefined;

/** The owner's actions on one score, as the library renders them. */
const ownerScoreActions = (): string[] => {
    render(<RowMenu onRename={noop} onShare={noop} onAssign={noop} onDelete={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Score actions' }));
    return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
};

/** The Terms' clause on what a smaller plan does to scores past its limits. */
const downgradeClause = (): string => {
    const section = TERMS_OF_SERVICE.sections.find((candidate) => candidate.id === 'plans-and-billing');
    const texts = section?.blocks.flatMap((block) => (block.kind === 'list' ? block.items : [block.text])) ?? [];
    return texts.find((text) => text.includes('read-only')) ?? '';
};

describe('what the app promises a user over the score cap', () => {
    afterEach(cleanup);

    it('offers a score owner delete, and no archive or unarchive', () => {
        const actions = ownerScoreActions();
        expect(actions).toContain('Delete');
        expect(actions.filter((label) => /archive/i.test(label))).toEqual([]);
    });

    it('suggests only an action the library offers when the cap refuses a new score', () => {
        const actions = ownerScoreActions().map((label) => label.toLowerCase());
        const copy = limitAction({ code: 'limit_reached', metric: 'cloud_scores', limit: 3, tier: 'free' });
        expect(copy).toMatch(/^Upgrade .*, or delete one to make room\.$/);
        expect(actions).toContain('delete');
        expect(copy).not.toMatch(/archive/i);
    });

    it('promises archived scores back on an upgrade only, the one path that un-archives them', () => {
        const clause = downgradeClause();
        expect(clause).toMatch(/nothing is deleted/);
        expect(clause).toMatch(/until you upgrade again\.$/);
        expect(clause).not.toMatch(/remove others|unarchive|un-archive|delete others/i);
    });
});
