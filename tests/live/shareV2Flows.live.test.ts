import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Share v2 end to end, in a real browser against the local stack (#105):
 * a view link opens the score signed out, the owner sees "1 viewing now", a
 * saved mark reaches the viewer, revoking clears the viewer, and the viewer's
 * browser keeps nothing. An editor link with no name goes straight in, and
 * Restricted takes the guest out again. Runs once per viewport.
 *
 *     CLEFFY_E2E_BASE=http://localhost:5273 \
 *     CLEFFY_LIVE_SUPABASE_URL=http://127.0.0.1:54421 \
 *     CLEFFY_LIVE_ANON_KEY=... CLEFFY_LIVE_SERVICE_ROLE_KEY=... \
 *     npx vitest run tests/live/shareV2Flows.live.test.ts
 *
 * The app must be built with VITE_FEATURE_SHARE_V2=1 and the functions served
 * with SHARE_V2_ENABLED=1 and SHARE_JWT_SECRET. Screenshots go to e2e-shots/.
 */

const BASE = process.env.CLEFFY_E2E_BASE ?? '';
const URL = process.env.CLEFFY_LIVE_SUPABASE_URL ?? '';
const ANON = process.env.CLEFFY_LIVE_ANON_KEY ?? '';
const SERVICE = process.env.CLEFFY_LIVE_SERVICE_ROLE_KEY ?? '';
const PASSWORD = 'share-v2-e2e-password-1';
const SHOTS = resolve(process.cwd(), 'e2e-shots');

const VIEWPORTS = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'ipad', width: 820, height: 1180 },
    { name: 'phone', width: 390, height: 844 },
] as const;

const storageLeft = (page: Page) =>
    page.evaluate(async () => ({
        local: localStorage.length,
        session: sessionStorage.length,
        idb: (await indexedDB.databases()).length,
        caches: 'caches' in window ? (await caches.keys()).length : 0,
        cookie: document.cookie,
    }));

describe.skipIf(!BASE || !URL || !ANON || !SERVICE)('Share v2 flows in the browser', () => {
    let admin: SupabaseClient;
    let browser: Browser;

    beforeAll(async () => {
        admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
        browser = await chromium.launch(
            process.env.CLEFFY_UI_CHROMIUM ? { executablePath: process.env.CLEFFY_UI_CHROMIUM } : {},
        );
        mkdirSync(SHOTS, { recursive: true });
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
    });

    const makeOwner = async (tag: string) => {
        const email = `share-e2e-${tag}-${Date.now().toString(36)}@cleffy.test`;
        const { data, error } = await admin.auth.admin.createUser({
            email,
            password: PASSWORD,
            email_confirm: true,
            user_metadata: { display_name: 'Ms Owner', age_gate: { country: 'US', min_age: 13, source: 'self', v: 1 } },
        });
        if (error || !data.user) {
            throw new Error(`createUser: ${error?.message}`);
        }
        const owner = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
        await owner.auth.signInWithPassword({ email, password: PASSWORD });
        const docId = crypto.randomUUID();
        expect(
            (
                await admin.from('documents').insert({
                    id: docId,
                    owner_id: data.user.id,
                    title: `Für Elise (${tag})`,
                    storage_path: `${docId}/original.pdf`,
                    page_count: 1,
                })
            ).error,
        ).toBeNull();
        const pdf = readFileSync(resolve(process.cwd(), 'e2e-fixtures/test-score.pdf'));
        expect(
            (
                await admin.storage
                    .from('scores')
                    .upload(`${docId}/original.pdf`, pdf, { contentType: 'application/pdf' })
            ).error,
        ).toBeNull();
        return { email, ownerId: data.user.id, owner, docId };
    };

    const ownerPage = async (email: string, docId: string, viewport: { width: number; height: number }) => {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        await page.goto(`${BASE}/login`);
        await page.getByLabel('Email').fill(email);
        await page.getByLabel('Password').fill(PASSWORD);
        await page.getByRole('button', { name: 'Log in' }).click();
        await page.waitForURL(/\/library/, { timeout: 30_000 });
        await page.goto(`${BASE}/doc/${docId}`);
        return page;
    };

    for (const viewport of VIEWPORTS) {
        it(`view link: live, counted, revoked and memory-only (${viewport.name})`, async () => {
            const { email, ownerId, owner, docId } = await makeOwner(`view-${viewport.name}`);
            const { data: link, error } = await owner.rpc('set_general_access', {
                p_document: docId,
                p_mode: 'anyone',
                p_role: 'viewer',
                p_expires_in: '7 days',
            });
            expect(error).toBeNull();
            const token = (link as Array<{ token: string }>)[0]!.token;

            const viewerContext = await browser.newContext({ viewport });
            const viewer = await viewerContext.newPage();
            await viewer.goto(`${BASE}/s#${token}`);
            await viewer.getByText('View only', { exact: true }).waitFor({ timeout: 30_000 });
            await viewer.locator('canvas').first().waitFor({ timeout: 30_000 });
            await viewer.waitForTimeout(1500);
            await viewer.screenshot({ path: `${SHOTS}/share-v2-viewer-${viewport.name}.png` });

            const teacher = await ownerPage(email, docId, viewport);
            await teacher.getByRole('button', { name: 'Share' }).click();
            await teacher.getByText('1 viewing now').waitFor({ timeout: 20_000 });
            await teacher.waitForTimeout(500);
            await teacher.screenshot({ path: `${SHOTS}/share-v2-dialog-${viewport.name}.png` });

            const before = await viewer.screenshot();
            const pts: number[] = [];
            for (let i = 0; i <= 40; i += 1) {
                pts.push(0.1 + i * 0.02, 0.1 + i * 0.01, 0.5);
            }
            expect(
                (
                    await owner.from('annotations').insert({
                        id: crypto.randomUUID(),
                        document_id: docId,
                        page: 0,
                        kind: 'stroke',
                        color: '#e11d48',
                        payload: { pts, w: 0.02 },
                        created_by: ownerId,
                    })
                ).error,
            ).toBeNull();
            await expect
                .poll(async () => Buffer.compare(before, await viewer.screenshot()) !== 0, { timeout: 10_000 })
                .toBe(true);
            await viewer.screenshot({ path: `${SHOTS}/share-v2-viewer-mark-${viewport.name}.png` });
            expect(await storageLeft(viewer)).toEqual({ local: 0, session: 0, idb: 0, caches: 0, cookie: '' });

            const revokedAt = Date.now();
            expect((await owner.rpc('revoke_share_link', { p_token: token, p_remove_members: true })).error).toBeNull();
            await viewer.getByText('The owner turned off this link.').waitFor({ timeout: 10_000 });
            const clearedMs = Date.now() - revokedAt;
            console.log(`[${viewport.name}] revoke cleared the viewer in ${clearedMs} ms`);
            expect(await viewer.locator('canvas').count()).toBe(0);
            expect(await storageLeft(viewer)).toEqual({ local: 0, session: 0, idb: 0, caches: 0, cookie: '' });

            await viewerContext.close();
            await teacher.context().close();
        }, 120_000);

        it(`editor link: no name, straight in, Restricted takes them out (${viewport.name})`, async () => {
            const { email, owner, docId } = await makeOwner(`edit-${viewport.name}`);
            const { data: link } = await owner.rpc('set_general_access', {
                p_document: docId,
                p_mode: 'anyone',
                p_role: 'editor',
                p_expires_in: '7 days',
            });
            const token = (link as Array<{ token: string }>)[0]!.token;

            const guestContext = await browser.newContext({ viewport });
            const guest = await guestContext.newPage();
            await guest.goto(`${BASE}/s#${token}`);
            await guest.getByText('Join to edit').waitFor({ timeout: 30_000 });
            expect(await guest.getByText(/birth/i).count()).toBe(0);
            await guest.screenshot({ path: `${SHOTS}/share-v2-join-${viewport.name}.png` });
            await guest.getByRole('button', { name: 'Continue without a name' }).click();
            await guest.waitForURL(new RegExp(`/doc/${docId}`), { timeout: 30_000 });
            await guest.locator('canvas').first().waitFor({ timeout: 30_000 });

            const teacher = await ownerPage(email, docId, viewport);
            await teacher
                .getByRole('button', { name: /^Anonymous \w+ \(guest\), on page/ })
                .first()
                .waitFor({ timeout: 20_000 });

            expect(
                (
                    await owner.rpc('set_general_access', {
                        p_document: docId,
                        p_mode: 'restricted',
                        p_role: 'editor',
                        p_expires_in: '7 days',
                    })
                ).error,
            ).toBeNull();
            await guest
                .getByText(/no longer available to you/)
                .first()
                .waitFor({ timeout: 15_000 });
            await guest.screenshot({ path: `${SHOTS}/share-v2-removed-${viewport.name}.png` });
            await guestContext.close();
            await teacher.context().close();
        }, 120_000);
    }
});
