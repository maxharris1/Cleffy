// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLiveDistrict, LIVE_LOCAL, type LiveDistrict } from './districtFixture';

/**
 * A read-only seat against the real Storage API (migration
 * 20261020180700_read_only_seats_storage.sql): once the sixth teacher's seat
 * is read-only, uploading over their score's PDF (upsert, as the app's
 * replace and import cleanup do), adding a file to its folder and removing the
 * PDF all fail, while downloading it still works; making the seat active
 * again lets the upload through.
 *
 * Local stack only; see districtFixture.ts for how to run it.
 */
describe.skipIf(!LIVE_LOCAL)('a read-only seat through the Storage API', () => {
    let district: LiveDistrict;
    const docId = crypto.randomUUID();
    const path = `${docId}/original.pdf`;
    const pdf = (text: string) => new Blob([`%PDF-1.4\n% ${text}\n`], { type: 'application/pdf' });

    beforeAll(async () => {
        district = await createLiveDistrict(`storage${Date.now().toString(36)}`);
        const t6 = district.teachers[5]!;
        const { error } = await district.admin
            .from('documents')
            .insert({ id: docId, owner_id: t6.id, title: 'Live storage', storage_path: path });
        expect(error).toBeNull();
    }, 60_000);

    afterAll(async () => {
        await district?.admin.storage.from('scores').remove([path, `${docId}/extra.pdf`]);
        await district?.cleanup();
    }, 60_000);

    it('refuses every write to the score file once the seat is read-only, and keeps the download', async () => {
        const storage = () => district.teachers[5]!.client.storage.from('scores');

        // Active seat: the owner uploads their score.
        expect((await storage().upload(path, pdf('v1'), { upsert: true })).error).toBeNull();

        await district.lapse();
        const { data: readOnly } = await district.teachers[5]!.client.rpc('caller_seat_read_only');
        expect(readOnly).toBe(true);

        // Replacing the PDF (upsert) is refused.
        const replaced = await storage().upload(path, pdf('v2, read-only'), { upsert: true });
        expect(replaced.error).not.toBeNull();

        // So is a new file in the folder.
        const added = await storage().upload(`${docId}/extra.pdf`, pdf('extra'));
        expect(added.error).not.toBeNull();

        // Removing it matches nothing: Storage answers with no rows, and the file is still there.
        const removed = await storage().remove([path]);
        expect(removed.data ?? []).toHaveLength(0);

        // Download still works, and it is still v1.
        const downloaded = await storage().download(path);
        expect(downloaded.error).toBeNull();
        expect(await downloaded.data!.text()).toContain('v1');

        // Active again: the upload goes through.
        await district.restore();
        expect((await storage().upload(path, pdf('v3, active'), { upsert: true })).error).toBeNull();
        expect(await (await storage().download(path)).data!.text()).toContain('v3');
    }, 60_000);
});
