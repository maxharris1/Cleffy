// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Storage accounting and the thumbnail lifecycle through the REAL Storage API
 * (Codex round 2 on #69; 20261022100900). The SQL proofs
 * (storage_cleanup_and_thumbnail_cap.sql, storage_thumbnail_concurrency.sql)
 * write storage.objects the way the Storage API does; this goes through the
 * API itself -- its rolled-back policy test, then its real service-path write
 * -- with supabase-js and the app's own thumbnailRemote.ts:
 *
 *   * a deleted score's cleanup marker cannot be deleted through PostgREST,
 *     and the owner's usage is unchanged; the server clears it once the
 *     folders are empty;
 *   * an over-quota owner shrinks a file with upload(upsert) and update(), and
 *     growing it is refused (HTTP 403, storage_quota_exceeded);
 *   * three cover uploads at once into one score: two land, one is refused
 *     (thumbnail_limit);
 *   * a publish whose thumb_rev update failed does not block the next one,
 *     and a claimed cover cannot be published;
 *   * a cover removed under a claim, written again and re-published under the
 *     same name, survives a second device's late removal of that name, while
 *     the service key (delete-account) still empties the folder
 *     (20261022101000).
 *
 * Needs the local stack (`npm run cloud:up`), so the root `npm run test` skips
 * it unless the three settings are there. CI's supabase-local job runs it with
 * CLEFFY_REQUIRE_LOCAL_DB=1, which turns a missing setting into a failure:
 *
 *     CLEFFY_LOCAL_SUPABASE_URL=http://127.0.0.1:54421 \
 *     CLEFFY_LOCAL_ANON_KEY=<ANON_KEY from `npx supabase status -o env`> \
 *     CLEFFY_LOCAL_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from the same> \
 *     npx vitest run tests/storage/storageLifecycle.test.ts
 *
 * It writes only to an account it creates and deletes again, and briefly sets
 * the local deployment_config's storage quota, restoring it after.
 */

const URL = process.env.CLEFFY_LOCAL_SUPABASE_URL ?? '';
const ANON_KEY = process.env.CLEFFY_LOCAL_ANON_KEY ?? '';
const SERVICE_KEY = process.env.CLEFFY_LOCAL_SERVICE_ROLE_KEY ?? '';
/** Set by CI's supabase-local job: there, a stack that is not configured fails the run. */
const REQUIRED = process.env.CLEFFY_REQUIRE_LOCAL_DB === '1';

const state = vi.hoisted(() => ({ client: null as SupabaseClient | null }));
vi.mock('@/lib/supabase', () => ({ getSupabase: () => state.client }));

import { publishThumbnail } from '@/features/library/thumbnailRemote';

const pdf = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
const jpeg = (bytes = 64) => new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe.skipIf(!REQUIRED && (!URL || !ANON_KEY || !SERVICE_KEY))('Storage accounting through the Storage API', () => {
    let admin: SupabaseClient;
    let user: SupabaseClient;
    let userId = '';
    const docs: string[] = [];
    let savedConfig: { exists: boolean; quota: unknown } = { exists: false, quota: null };

    const setFreeQuota = async (bytes: number) => {
        const { error } = await admin
            .from('deployment_config')
            .upsert({ id: true, storage_quota_bytes: { free: bytes }, updated_by: 'storageLifecycle.test.ts' });
        expect(error).toBeNull();
    };
    const usage = async () => {
        const { data, error } = await admin.rpc('storage_owner_bytes', { p_owner: userId });
        expect(error).toBeNull();
        return Number(data);
    };
    const createScore = async (contentRev = 0) => {
        // A free account keeps 3 live scores: earlier tests' scores are
        // archived first (their files still count against the quota).
        const { error: archiveError } = await admin
            .from('documents')
            .update({ archived_at: new Date().toISOString() })
            .eq('owner_id', userId)
            .is('archived_at', null);
        expect(archiveError).toBeNull();
        const id = randomUUID();
        const { error } = await user.from('documents').insert({
            id,
            owner_id: userId,
            title: 'Storage lifecycle',
            storage_path: `${id}/original.pdf`,
            content_rev: contentRev,
        });
        expect(error).toBeNull();
        docs.push(id);
        return id;
    };
    const covers = async (id: string) => {
        const { data, error } = await admin.storage.from('thumbnails').list(id);
        expect(error).toBeNull();
        return (data ?? []).map((o) => o.name).sort();
    };
    const thumbRev = async (id: string) => {
        const { data } = await admin.from('documents').select('thumb_rev').eq('id', id).single();
        return (data as { thumb_rev: number | null } | null)?.thumb_rev ?? null;
    };

    beforeAll(async () => {
        if (!URL || !ANON_KEY || !SERVICE_KEY) {
            throw new Error(
                'CLEFFY_LOCAL_SUPABASE_URL, CLEFFY_LOCAL_ANON_KEY and CLEFFY_LOCAL_SERVICE_ROLE_KEY are required',
            );
        }
        admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
        const { data: config, error: configError } = await admin
            .from('deployment_config')
            .select('storage_quota_bytes')
            .maybeSingle();
        expect(configError).toBeNull();
        savedConfig = { exists: config !== null, quota: config?.storage_quota_bytes ?? null };
        await setFreeQuota(1_000_000);

        const email = `storage-lifecycle-${randomUUID()}@example.invalid`;
        const password = `pw-${randomUUID()}`;
        const { data: created, error: createError } = await admin.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
        });
        expect(createError).toBeNull();
        userId = created.user!.id;
        user = createClient(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
        const { error: signInError } = await user.auth.signInWithPassword({ email, password });
        expect(signInError).toBeNull();
        state.client = user;
    });

    afterAll(async () => {
        if (!admin) {
            return;
        }
        for (const id of docs) {
            for (const bucket of ['scores', 'thumbnails']) {
                const { data } = await admin.storage.from(bucket).list(id);
                const names = (data ?? []).map((o) => `${id}/${o.name}`);
                if (names.length > 0) {
                    await admin.storage.from(bucket).remove(names);
                }
            }
            await admin.from('documents').delete().eq('id', id);
        }
        if (userId) {
            await admin.from('document_storage_cleanup').delete().eq('owner_id', userId);
            await admin.from('thumbnail_storage_cleanup').delete().eq('owner_id', userId);
            await admin.auth.admin.deleteUser(userId);
        }
        if (savedConfig.exists) {
            await admin.from('deployment_config').update({ storage_quota_bytes: savedConfig.quota }).eq('id', true);
        } else {
            await admin.from('deployment_config').delete().eq('id', true);
        }
    });

    it('keeps a deleted score’s bytes on the owner’s quota until its files are gone', async () => {
        const id = await createScore();
        expect((await user.storage.from('scores').upload(`${id}/original.pdf`, pdf(700))).error).toBeNull();
        expect((await user.from('documents').delete().eq('id', id)).error).toBeNull();
        expect(await usage()).toBe(700);

        const refused = await user.from('document_storage_cleanup').delete().eq('document_id', id);
        expect(refused.error?.code).toBe('42501');
        const { data: marker } = await user
            .from('document_storage_cleanup')
            .select('document_id')
            .eq('document_id', id);
        expect(marker).toHaveLength(1);
        expect(await usage()).toBe(700);

        const early = await user.rpc('finish_document_storage_cleanup', { p_document_id: id });
        expect(early).toMatchObject({ data: false, error: null });
        expect(await usage()).toBe(700);

        const removed = await user.storage.from('scores').remove([`${id}/original.pdf`]);
        expect(removed.error).toBeNull();
        expect(removed.data).toHaveLength(1);
        const done = await user.rpc('finish_document_storage_cleanup', { p_document_id: id });
        expect(done).toMatchObject({ data: true, error: null });
        expect(await usage()).toBe(0);
        const { data: after } = await user.from('document_storage_cleanup').select('document_id').eq('document_id', id);
        expect(after).toHaveLength(0);
    });

    it('lets an over-quota owner shrink a file through the upload API, and refuses growing it', async () => {
        const id = await createScore();
        const path = `${id}/original.pdf`;
        expect((await user.storage.from('scores').upload(path, pdf(3000))).error).toBeNull();
        expect((await user.storage.from('scores').upload(`${id}/pre-import-original.pdf`, pdf(1000))).error).toBeNull();
        // A downgrade: the backup alone is now over the quota.
        await setFreeQuota(500);
        try {
            const shrunk = await user.storage.from('scores').upload(path, pdf(2000), { upsert: true });
            expect(shrunk.error).toBeNull();
            const updated = await user.storage.from('scores').update(path, pdf(1500));
            expect(updated.error).toBeNull();
            expect(await usage()).toBe(2500);

            const grown = await user.storage.from('scores').upload(path, pdf(1600), { upsert: true });
            expect(grown.error?.message).toMatch(/storage_quota_exceeded/);
            expect(String((grown.error as { statusCode?: string } | null)?.statusCode)).toBe('403');
            expect(await usage()).toBe(2500);
        } finally {
            await setFreeQuota(1_000_000);
        }
    });

    it('lands two of three covers uploaded into one score at once, and refuses the third', async () => {
        const id = await createScore(5);
        const results = await Promise.all(
            [0, 1, 2].map((rev) =>
                user.storage.from('thumbnails').upload(`${id}/${rev}.jpg`, jpeg(), { contentType: 'image/jpeg' }),
            ),
        );
        const refused = results.filter((r) => r.error);
        expect(results.filter((r) => !r.error)).toHaveLength(2);
        expect(refused).toHaveLength(1);
        expect(refused[0]?.error?.message).toMatch(/thumbnail_limit/);
        expect(await covers(id)).toHaveLength(2);
    });

    it('does not let a failed publish block the next one, and never publishes a claimed cover', async () => {
        const id = await createScore(5);
        await expect(publishThumbnail(id, 0, jpeg())).resolves.toBe(true);
        expect(await thumbRev(id)).toBe(0);
        // Revision 1 uploads, but its thumb_rev update never lands.
        expect(
            (await user.storage.from('thumbnails').upload(`${id}/1.jpg`, jpeg(), { contentType: 'image/jpeg' })).error,
        ).toBeNull();
        await settle();
        expect(await covers(id)).toEqual(['0.jpg', '1.jpg']);

        // Revision 2: the folder is full, so the publish clears the unpublished
        // 1 (never the published 0) and lands; its purge then removes 0.
        await expect(publishThumbnail(id, 2, jpeg())).resolves.toBe(true);
        expect(await thumbRev(id)).toBe(2);
        await settle();
        expect(await covers(id)).toEqual(['2.jpg']);

        // A claimed cover cannot be published: claim 3 (about to write 4), then
        // a late thumb_rev update for 3 is refused.
        expect(
            (await user.storage.from('thumbnails').upload(`${id}/3.jpg`, jpeg(), { contentType: 'image/jpeg' })).error,
        ).toBeNull();
        const claim = await user.rpc('claim_superseded_thumbnails', { p_document_ids: [id], p_writing_rev: 4 });
        expect(claim).toMatchObject({ data: [`${id}/3.jpg`], error: null });
        const late = await user.from('documents').update({ thumb_rev: 3 }).eq('id', id);
        expect(late.error?.message).toMatch(/thumbnail_claimed/);
        expect(await thumbRev(id)).toBe(2);
    });

    it('never lets a late removal take a cover re-published under a reused name', async () => {
        const id = await createScore(5);
        await expect(publishThumbnail(id, 0, jpeg())).resolves.toBe(true);
        await settle();
        const upload1 = () =>
            user.storage.from('thumbnails').upload(`${id}/1.jpg`, jpeg(), { contentType: 'image/jpeg', upsert: true });
        expect((await upload1()).error).toBeNull();

        // Two devices, each about to write 2, are both told to remove 1.
        for (let device = 0; device < 2; device += 1) {
            const claim = await user.rpc('claim_superseded_thumbnails', { p_document_ids: [id], p_writing_rev: 2 });
            expect(claim).toMatchObject({ data: [`${id}/1.jpg`], error: null });
        }
        const first = await user.storage.from('thumbnails').remove([`${id}/1.jpg`]);
        expect(first.error).toBeNull();
        expect(first.data).toHaveLength(1);

        // A third device writes 1 again and publishes it.
        expect((await upload1()).error).toBeNull();
        expect((await user.from('documents').update({ thumb_rev: 1 }).eq('id', id)).error).toBeNull();

        // The second device's removal arrives late: the published 1 stays.
        const late = await user.storage.from('thumbnails').remove([`${id}/1.jpg`]);
        expect(late.error).toBeNull();
        expect(late.data).toHaveLength(0);
        expect(await covers(id)).toContain('1.jpg');
        expect(await thumbRev(id)).toBe(1);
        const { data: cover } = await user.storage.from('thumbnails').download(`${id}/1.jpg`);
        expect(cover).not.toBeNull();

        // delete-account (the service key) still empties a live score's folder.
        const purged = await admin.storage.from('thumbnails').remove([`${id}/0.jpg`, `${id}/1.jpg`]);
        expect(purged.error).toBeNull();
        expect(purged.data).toHaveLength(2);
        expect(await covers(id)).toEqual([]);
    });
});
