import { describe, expect, it } from 'vitest';

import { DELETE_CONFIRMATION } from '../../supabase/functions/_shared/accountDeletion';
import { DELETE_ACCOUNT_CONFIRMATION } from '../../src/features/account/accountDeletion';

/**
 * The word the Account page asks for is the word delete-account checks. If the
 * two ever drift, every deletion fails with "Type … to confirm" and nobody can
 * close their account.
 */
describe('delete-account confirmation word', () => {
    it('is the same on both sides', () => {
        expect(DELETE_ACCOUNT_CONFIRMATION).toBe(DELETE_CONFIRMATION);
    });
});
