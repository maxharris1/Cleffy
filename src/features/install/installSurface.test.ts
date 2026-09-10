import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    isIosDevice,
    isIosSafari,
    isIpadDevice,
    isStandaloneDisplay,
    resolveInstallSurface,
    shareBarCopy,
} from '@/features/install/installSurface';

const IPHONE_SAFARI =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1';
const IPHONE_FIREFOX =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15';
const IPHONE_EDGE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 EdgiOS/123.0.2420.70 Mobile/15E148 Safari/604.1';
const IPAD_SAFARI =
    'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const MAC_SAFARI =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const DESKTOP_CHROME =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const IPOD_SAFARI =
    'Mozilla/5.0 (iPod touch; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

const stubNavigator = (fields: {
    userAgent: string;
    platform?: string;
    maxTouchPoints?: number;
    standalone?: boolean;
}) => {
    vi.stubGlobal('navigator', {
        ...navigator,
        userAgent: fields.userAgent,
        platform: fields.platform ?? 'Win32',
        maxTouchPoints: fields.maxTouchPoints ?? 0,
        standalone: fields.standalone,
    });
};

const stubMatchMedia = (standalone: boolean) => {
    window.matchMedia = ((query: string) => ({
        matches: query.includes('display-mode: standalone') && standalone,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
        onchange: null,
    })) as typeof window.matchMedia;
};

beforeEach(() => {
    stubMatchMedia(false);
    stubNavigator({ userAgent: DESKTOP_CHROME, platform: 'MacIntel', maxTouchPoints: 0 });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('installSurface', () => {
    it('detects iPhone, iPod, iPad, and iPadOS', () => {
        stubNavigator({ userAgent: IPHONE_SAFARI, platform: 'iPhone' });
        expect(isIosDevice()).toBe(true);
        expect(isIpadDevice()).toBe(false);

        stubNavigator({ userAgent: IPOD_SAFARI, platform: 'iPod' });
        expect(isIosDevice()).toBe(true);
        expect(isIpadDevice()).toBe(false);

        stubNavigator({ userAgent: IPAD_SAFARI, platform: 'iPad' });
        expect(isIosDevice()).toBe(true);
        expect(isIpadDevice()).toBe(true);

        stubNavigator({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 5 });
        expect(isIpadDevice()).toBe(true);
        expect(isIosDevice()).toBe(true);

        stubNavigator({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 0 });
        expect(isIpadDevice()).toBe(false);
        expect(isIosDevice()).toBe(false);
    });

    it('treats Safari on iOS as ios-safari and other iOS browsers as ios-other', () => {
        stubNavigator({ userAgent: IPHONE_SAFARI, platform: 'iPhone' });
        expect(isIosSafari()).toBe(true);
        expect(resolveInstallSurface()).toBe('ios-safari');

        stubNavigator({ userAgent: IPHONE_CHROME, platform: 'iPhone' });
        expect(isIosSafari()).toBe(false);
        expect(resolveInstallSurface()).toBe('ios-other');

        stubNavigator({ userAgent: IPHONE_FIREFOX, platform: 'iPhone' });
        expect(resolveInstallSurface()).toBe('ios-other');

        stubNavigator({ userAgent: IPHONE_EDGE, platform: 'iPhone' });
        expect(resolveInstallSurface()).toBe('ios-other');
    });

    it('treats iPadOS Safari as ios-safari, not desktop', () => {
        stubNavigator({ userAgent: MAC_SAFARI, platform: 'MacIntel', maxTouchPoints: 5 });
        expect(isIosSafari()).toBe(true);
        expect(resolveInstallSurface()).toBe('ios-safari');
    });

    it('detects standalone from matchMedia or iOS navigator.standalone', () => {
        stubNavigator({ userAgent: DESKTOP_CHROME, platform: 'MacIntel' });
        stubMatchMedia(true);
        expect(isStandaloneDisplay()).toBe(true);
        expect(resolveInstallSurface(true)).toBe('standalone');

        stubMatchMedia(false);
        stubNavigator({ userAgent: IPHONE_SAFARI, platform: 'iPhone', standalone: true });
        expect(isStandaloneDisplay()).toBe(true);
        expect(resolveInstallSurface()).toBe('standalone');
    });

    it('returns installable only when Chromium can prompt and this is not iOS', () => {
        stubNavigator({ userAgent: DESKTOP_CHROME, platform: 'MacIntel' });
        expect(resolveInstallSurface(true)).toBe('installable');
        expect(resolveInstallSurface(false)).toBe('other');

        stubNavigator({ userAgent: IPHONE_CHROME, platform: 'iPhone' });
        expect(resolveInstallSurface(true)).toBe('ios-other');
    });

    it('describes where Share lives on iPhone, iPad, and other devices', () => {
        stubNavigator({ userAgent: IPHONE_SAFARI, platform: 'iPhone' });
        expect(shareBarCopy()).toMatch(/bottom/i);

        stubNavigator({ userAgent: IPAD_SAFARI, platform: 'iPad' });
        expect(shareBarCopy()).toMatch(/top toolbar/i);

        stubNavigator({ userAgent: DESKTOP_CHROME, platform: 'MacIntel' });
        expect(shareBarCopy()).toMatch(/iPhone/);
        expect(shareBarCopy()).toMatch(/iPad/);
    });
});
