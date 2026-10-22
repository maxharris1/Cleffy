import { describe, expect, it } from 'vitest';

import { uploadFailureMessage } from '@/lib/storageUpload';

describe('uploadFailureMessage', () => {
    it('says the storage is full when the quota refused the upload', () => {
        expect(uploadFailureMessage('storage_quota_exceeded')).toMatch(/your storage is full/);
    });

    it('passes any other refusal through', () => {
        expect(uploadFailureMessage('mime type text/plain is not supported')).toBe(
            'Upload failed: mime type text/plain is not supported',
        );
    });
});
