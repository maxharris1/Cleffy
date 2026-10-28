import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DEMO_KEEP_KEY,
    DEMO_SESSION_KEY,
    readKeepMarkings,
    shouldWipeDemo,
    startDemoSession,
    writeKeepMarkings,
} from '@/features/demo/demoSession';

/** Safari in private mode, or site data blocked: the storage getter itself throws. */
const blockStorage = (name: 'sessionStorage' | 'localStorage') =>
    vi.spyOn(window, name, 'get').mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
    });

beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('shouldWipeDemo', () => {
    it('wipes only a new session that did not ask to keep its markings', () => {
        expect(shouldWipeDemo({ keep: false, sessionStarted: false })).toBe(true);
        expect(shouldWipeDemo({ keep: false, sessionStarted: true })).toBe(false);
        expect(shouldWipeDemo({ keep: true, sessionStarted: false })).toBe(false);
        expect(shouldWipeDemo({ keep: true, sessionStarted: true })).toBe(false);
    });
});

describe('startDemoSession', () => {
    it('wipes on a first visit, then sets the session marker', async () => {
        const order: string[] = [];
        const wipe = vi.fn(async () => {
            // The marker is set only once the wipe has finished.
            order.push(`wipe:${window.sessionStorage.getItem(DEMO_SESSION_KEY)}`);
        });

        await expect(startDemoSession(wipe)).resolves.toEqual({ wiped: true, remembered: true });

        expect(wipe).toHaveBeenCalledTimes(1);
        expect(order).toEqual(['wipe:null']);
        expect(window.sessionStorage.getItem(DEMO_SESSION_KEY)).toBe('1');
    });

    it('does not wipe on a refresh (the marker is already set)', async () => {
        window.sessionStorage.setItem(DEMO_SESSION_KEY, '1');
        const wipe = vi.fn(async () => undefined);

        await expect(startDemoSession(wipe)).resolves.toEqual({ wiped: false, remembered: true });

        expect(wipe).not.toHaveBeenCalled();
        expect(window.sessionStorage.getItem(DEMO_SESSION_KEY)).toBe('1');
    });

    it('does not wipe a new session when keep is on', async () => {
        window.localStorage.setItem(DEMO_KEEP_KEY, '1');
        const wipe = vi.fn(async () => undefined);

        await expect(startDemoSession(wipe)).resolves.toEqual({ wiped: false, remembered: true });

        expect(wipe).not.toHaveBeenCalled();
        expect(window.sessionStorage.getItem(DEMO_SESSION_KEY)).toBe('1');
    });

    it('wipes a new session when keep is off', async () => {
        window.localStorage.setItem(DEMO_KEEP_KEY, '0');
        const wipe = vi.fn(async () => undefined);

        await expect(startDemoSession(wipe)).resolves.toEqual({ wiped: true, remembered: true });

        expect(wipe).toHaveBeenCalledTimes(1);
    });

    it('treats every load as a new session when sessionStorage throws, and wipes', async () => {
        blockStorage('sessionStorage');
        const wipe = vi.fn(async () => undefined);

        // remembered: false, so the viewer can say a reload will clear the ink.
        await expect(startDemoSession(wipe)).resolves.toEqual({ wiped: true, remembered: false });
        await expect(startDemoSession(wipe)).resolves.toEqual({ wiped: true, remembered: false });

        expect(wipe).toHaveBeenCalledTimes(2);
    });

    it('treats keep as off when localStorage throws', async () => {
        window.localStorage.setItem(DEMO_KEEP_KEY, '1');
        blockStorage('localStorage');
        const wipe = vi.fn(async () => undefined);

        expect(readKeepMarkings()).toBe(false);
        await expect(startDemoSession(wipe)).resolves.toEqual({ wiped: true, remembered: true });

        expect(wipe).toHaveBeenCalledTimes(1);
    });

    it('leaves the marker unset when the wipe fails, so the next load tries again', async () => {
        const wipe = vi.fn(async () => {
            throw new Error('IndexedDB is closed');
        });

        await expect(startDemoSession(wipe)).rejects.toThrow('IndexedDB is closed');

        expect(window.sessionStorage.getItem(DEMO_SESSION_KEY)).toBeNull();
    });
});

describe('keep my markings', () => {
    it('defaults to off and round-trips through localStorage', () => {
        expect(readKeepMarkings()).toBe(false);
        writeKeepMarkings(true);
        expect(window.localStorage.getItem(DEMO_KEEP_KEY)).toBe('1');
        expect(readKeepMarkings()).toBe(true);
        writeKeepMarkings(false);
        expect(window.localStorage.getItem(DEMO_KEEP_KEY)).toBeNull();
        expect(readKeepMarkings()).toBe(false);
    });

    it('turning keep off deletes nothing now: only the next new session starts fresh', async () => {
        writeKeepMarkings(true);
        const wipe = vi.fn(async () => undefined);
        await startDemoSession(wipe);
        expect(wipe).not.toHaveBeenCalled();

        writeKeepMarkings(false);
        // Same tab (a refresh): still nothing wiped.
        await startDemoSession(wipe);
        expect(wipe).not.toHaveBeenCalled();

        // A new browser session (sessionStorage starts empty): now it wipes.
        window.sessionStorage.clear();
        await startDemoSession(wipe);
        expect(wipe).toHaveBeenCalledTimes(1);
    });

    it('says whether the choice stuck', () => {
        expect(writeKeepMarkings(true)).toBe(true);
        expect(writeKeepMarkings(false)).toBe(true);
    });

    it('reports a refused write without throwing, and keep stays off (storage full)', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        });

        expect(writeKeepMarkings(true)).toBe(false);
        expect(readKeepMarkings()).toBe(false);
    });

    it('reports a refused write without throwing when storage is blocked', () => {
        blockStorage('localStorage');
        expect(writeKeepMarkings(true)).toBe(false);
        expect(writeKeepMarkings(false)).toBe(false);
        expect(readKeepMarkings()).toBe(false);
    });
});
