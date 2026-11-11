import { afterEach, describe, expect, it, vi } from 'vitest';

import { readPageColumns, readSpreadCover, writePageColumns, writeSpreadCover } from '@/features/viewer/viewerPrefs';

afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('page layout preference', () => {
    it('is single page when nothing is saved', () => {
        expect(readPageColumns()).toBe(1);
    });

    it('is single page for a saved value it does not recognise', () => {
        for (const stale of ['two', '3', '', 'true']) {
            window.localStorage.setItem('cleffy:page-columns', stale);
            expect(readPageColumns()).toBe(1);
        }
    });

    it('restores the layout the reader last chose', () => {
        writePageColumns(2);
        expect(readPageColumns()).toBe(2);
        writePageColumns(1);
        expect(readPageColumns()).toBe(1);
    });

    it('is single page when storage throws', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });
        expect(readPageColumns()).toBe(1);
        expect(readSpreadCover()).toBe(false);
    });

    it('starts without a cover page, and remembers turning it on', () => {
        expect(readSpreadCover()).toBe(false);
        writeSpreadCover(true);
        expect(readSpreadCover()).toBe(true);
    });
});

describe('viewer store page layout', () => {
    const freshStore = async () => (await import('@/state/store')).useViewerStore.getState();

    it('opens a new reader in single page', async () => {
        expect((await freshStore()).pageColumns).toBe(1);
    });

    it('opens in the layout saved last time', async () => {
        (await freshStore()).setPageColumns(2);
        vi.resetModules();
        expect((await freshStore()).pageColumns).toBe(2);
    });
});
