import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabase = vi.hoisted(() => ({
    rpc: vi.fn(),
    upload: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        rpc: supabase.rpc,
        storage: { from: () => ({ upload: supabase.upload }) },
    }),
    requireSupabaseConfig: () => ({ url: 'http://127.0.0.1:54421', anonKey: 'anon' }),
}));

import { fetchStorageUsage, formatStorageBytes, uploadFailureMessage, uploadPdfToStorage } from '@/lib/storageUpload';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

beforeEach(() => {
    supabase.rpc.mockReset();
    supabase.upload.mockReset();
});

describe('uploadFailureMessage', () => {
    it('says the storage is full when the quota refused the upload', () => {
        expect(uploadFailureMessage('storage_quota_exceeded')).toMatch(/your storage is full/);
    });

    it('says how full, against what cap, when the figures are known (decision 50(3))', () => {
        expect(uploadFailureMessage('storage_quota_exceeded', { usedBytes: 498 * MIB, limitBytes: 500 * MIB })).toBe(
            'Upload failed: your storage is full (498 MB of 500 MB used). Delete scores you no longer need (archived ones count too) or upgrade for more space.',
        );
        expect(uploadFailureMessage('storage_quota_exceeded', { usedBytes: 4.97 * GIB, limitBytes: 5 * GIB })).toMatch(
            /\(5 GB of 5 GB used\)/,
        );
    });

    it('passes any other refusal through, with no figures', () => {
        expect(uploadFailureMessage('mime type text/plain is not supported', { usedBytes: 1, limitBytes: 2 })).toBe(
            'Upload failed: mime type text/plain is not supported',
        );
    });
});

describe('formatStorageBytes', () => {
    it('writes the caps as the plans state them', () => {
        expect(formatStorageBytes(500 * MIB)).toBe('500 MB');
        expect(formatStorageBytes(5 * GIB)).toBe('5 GB');
        expect(formatStorageBytes(1.25 * GIB)).toBe('1.3 GB');
        expect(formatStorageBytes(0)).toBe('0 MB');
        expect(formatStorageBytes(10)).toBe('less than 1 MB');
    });
});

describe('the storage-full message on a refused upload', () => {
    const pdf = () => new Blob([new Uint8Array(10)], { type: 'application/pdf' });

    it('reads the owner’s usage and cap (my_storage_usage) and says them', async () => {
        supabase.upload.mockResolvedValue({ error: { message: 'storage_quota_exceeded' } });
        supabase.rpc.mockResolvedValue({ data: { used_bytes: 499 * MIB, limit_bytes: 500 * MIB }, error: null });
        await expect(uploadPdfToStorage('doc/original.pdf', pdf())).rejects.toThrow(
            'Upload failed: your storage is full (499 MB of 500 MB used).',
        );
        expect(supabase.rpc).toHaveBeenCalledWith('my_storage_usage');
    });

    it('falls back to the message without figures when they cannot be read', async () => {
        supabase.upload.mockResolvedValue({ error: { message: 'storage_quota_exceeded' } });
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'function does not exist' } });
        await expect(uploadPdfToStorage('doc/original.pdf', pdf())).rejects.toThrow(
            /^Upload failed: your storage is full\. Delete scores/,
        );
        supabase.rpc.mockRejectedValue(new Error('offline'));
        expect(await fetchStorageUsage()).toBeNull();
    });

    it('asks for no figures on any other refusal', async () => {
        supabase.upload.mockResolvedValue({ error: { message: 'mime type text/plain is not supported' } });
        await expect(uploadPdfToStorage('doc/original.pdf', pdf())).rejects.toThrow(
            'Upload failed: mime type text/plain is not supported',
        );
        expect(supabase.rpc).not.toHaveBeenCalled();
    });
});
