// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

/**
 * The admin API's createUser skips before_user_created. The INSERT trigger
 * on auth.users (20261111170000) is the backstop. Needs the local stack;
 * CI's supabase-local job runs it with CLEFFY_REQUIRE_LOCAL_DB=1.
 *
 *     CLEFFY_LOCAL_SUPABASE_URL=http://127.0.0.1:54421 \
 *     CLEFFY_LOCAL_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from `npx supabase status -o env`> \
 *     npx vitest run tests/auth/ageGateAdminCreateUser.test.ts
 */

const URL = process.env.CLEFFY_LOCAL_SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.CLEFFY_LOCAL_SERVICE_ROLE_KEY ?? '';
const REQUIRED = process.env.CLEFFY_REQUIRE_LOCAL_DB === '1';

const gate = { country: 'US', min_age: 13, source: 'self' as const, v: 1 as const };

describe.skipIf(!REQUIRED && (!URL || !SERVICE_KEY))('admin createUser age gate', () => {
    const admin = () => {
        if (!URL || !SERVICE_KEY) {
            throw new Error('CLEFFY_LOCAL_SUPABASE_URL and CLEFFY_LOCAL_SERVICE_ROLE_KEY are required');
        }
        return createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    };

    it('refuses a user with no age_gate', async () => {
        const email = `ag-missing-${randomUUID()}@example.invalid`;
        const { data, error } = await admin().auth.admin.createUser({
            email,
            password: `pw-${randomUUID()}`,
            email_confirm: true,
        });
        expect(error, error?.message).not.toBeNull();
        if (data.user) {
            await admin().auth.admin.deleteUser(data.user.id);
        }
    });

    it('creates a user with a passing age_gate and refuses a 13-year-old in Germany', async () => {
        const client = admin();
        const okEmail = `ag-ok-${randomUUID()}@example.invalid`;
        const created = await client.auth.admin.createUser({
            email: okEmail,
            password: `pw-${randomUUID()}`,
            email_confirm: true,
            user_metadata: { age_gate: gate },
        });
        expect(created.error).toBeNull();
        expect(created.data.user?.id).toBeTruthy();
        if (created.data.user) {
            await client.auth.admin.deleteUser(created.data.user.id);
        }

        const young = await client.auth.admin.createUser({
            email: `ag-de13-${randomUUID()}@example.invalid`,
            password: `pw-${randomUUID()}`,
            email_confirm: true,
            user_metadata: { age_gate: { country: 'DE', min_age: 13, source: 'self', v: 1 } },
        });
        expect(young.error, young.error?.message).not.toBeNull();
        if (young.data.user) {
            await client.auth.admin.deleteUser(young.data.user.id);
        }
    });
});
