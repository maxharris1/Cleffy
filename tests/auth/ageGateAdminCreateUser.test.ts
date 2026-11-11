// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

/**
 * The admin API's createUser skips before_user_created. The INSERT trigger
 * on auth.users (20261111170000, age_gate_problem 20261111180000) is the
 * backstop. Needs the local stack; CI's supabase-local job runs it with
 * CLEFFY_REQUIRE_LOCAL_DB=1.
 *
 * GoTrue maps the trigger RAISE to HTTP 500, error_code unexpected_failure,
 * msg "Database error creating new user". It does not forward the SQLSTATE
 * or the RAISE text (unlike before_user_created on sign-up). supabase-js
 * then wraps that 500 as AuthRetryableFetchError with message "{}", so
 * refusal tests hit /auth/v1/admin/users directly and assert GoTrue's body.
 *
 *     CLEFFY_LOCAL_SUPABASE_URL=http://127.0.0.1:54421 \
 *     CLEFFY_LOCAL_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from `npx supabase status -o env`> \
 *     npx vitest run tests/auth/ageGateAdminCreateUser.test.ts
 */

const URL = process.env.CLEFFY_LOCAL_SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.CLEFFY_LOCAL_SERVICE_ROLE_KEY ?? '';
const REQUIRED = process.env.CLEFFY_REQUIRE_LOCAL_DB === '1';

const gate = { country: 'US', min_age: 13, source: 'self' as const, v: 1 as const };

type GoTrueErrorBody = {
    code?: number;
    error_code?: string;
    msg?: string;
};

const postAdminUser = async (body: Record<string, unknown>) => {
    const res = await fetch(`${URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as GoTrueErrorBody & Record<string, unknown> };
};

/** GoTrue's hardcoded wrap of an INSERT exception on admin createUser. */
const expectGoTrueInsertRefused = (got: { status: number; json: GoTrueErrorBody }) => {
    expect(got.status).toBe(500);
    expect(got.json).toEqual(
        expect.objectContaining({
            code: 500,
            error_code: 'unexpected_failure',
            msg: 'Database error creating new user',
        }),
    );
};

describe.skipIf(!REQUIRED && (!URL || !SERVICE_KEY))('admin createUser age gate', () => {
    const admin = () => {
        if (!URL || !SERVICE_KEY) {
            throw new Error('CLEFFY_LOCAL_SUPABASE_URL and CLEFFY_LOCAL_SERVICE_ROLE_KEY are required');
        }
        return createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    };

    it('refuses a user with no age_gate', async () => {
        const email = `ag-missing-${randomUUID()}@example.invalid`;
        const sdk = await admin().auth.admin.createUser({
            email,
            password: `pw-${randomUUID()}`,
            email_confirm: true,
        });
        expect(sdk.error).not.toBeNull();
        expect(sdk.error?.status).toBe(500);
        if (sdk.data.user) {
            await admin().auth.admin.deleteUser(sdk.data.user.id);
        }

        expectGoTrueInsertRefused(
            await postAdminUser({
                email: `ag-missing-raw-${randomUUID()}@example.invalid`,
                password: `pw-${randomUUID()}`,
                email_confirm: true,
            }),
        );
    });

    it('refuses a country-only age_gate (missing min_age must not fail open)', async () => {
        expectGoTrueInsertRefused(
            await postAdminUser({
                email: `ag-country-only-${randomUUID()}@example.invalid`,
                password: `pw-${randomUUID()}`,
                email_confirm: true,
                user_metadata: { age_gate: { country: 'DE' } },
            }),
        );
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

        expectGoTrueInsertRefused(
            await postAdminUser({
                email: `ag-de13-${randomUUID()}@example.invalid`,
                password: `pw-${randomUUID()}`,
                email_confirm: true,
                user_metadata: { age_gate: { country: 'DE', min_age: 13, source: 'self', v: 1 } },
            }),
        );
    });
});
