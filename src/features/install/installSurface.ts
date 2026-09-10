/**
 * Whether this session is running as an installed Home Screen app, and which
 * browser can actually add one. iOS only installs from Safari's Share sheet;
 * Chromium can raise beforeinstallprompt.
 */

export type InstallSurface = 'standalone' | 'ios-safari' | 'ios-other' | 'installable' | 'other';

const IOS_PHONE = /iPhone|iPod/i;
const IOS_PAD = /iPad/i;
/** Third-party iOS browsers still include "Safari" in the UA. */
const IOS_NOT_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|GSA\//;

type IosNavigator = Navigator & { standalone?: boolean };

const iosNavigator = (): IosNavigator | null => (typeof navigator === 'undefined' ? null : (navigator as IosNavigator));

export const isStandaloneDisplay = (): boolean => {
    if (typeof window === 'undefined') {
        return false;
    }
    const media = window.matchMedia('(display-mode: standalone)');
    if (media.matches) {
        return true;
    }
    return iosNavigator()?.standalone === true;
};

export const isIpadDevice = (): boolean => {
    const nav = iosNavigator();
    if (!nav) {
        return false;
    }
    if (IOS_PAD.test(nav.userAgent)) {
        return true;
    }
    // iPadOS 13+ reports as Macintosh with a touchscreen.
    return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1;
};

export const isIosDevice = (): boolean => {
    const nav = iosNavigator();
    if (!nav) {
        return false;
    }
    return IOS_PHONE.test(nav.userAgent) || isIpadDevice();
};

export const isIosSafari = (): boolean => {
    if (!isIosDevice()) {
        return false;
    }
    const ua = iosNavigator()?.userAgent ?? '';
    if (IOS_NOT_SAFARI.test(ua)) {
        return false;
    }
    return /Safari/i.test(ua) && /Version\//i.test(ua);
};

/**
 * Which install UI this session should see. `canPromptInstall` is true when
 * Chromium has deferred a beforeinstallprompt event.
 */
export const resolveInstallSurface = (canPromptInstall = false): InstallSurface => {
    if (isStandaloneDisplay()) {
        return 'standalone';
    }
    if (isIosDevice()) {
        return isIosSafari() ? 'ios-safari' : 'ios-other';
    }
    if (canPromptInstall) {
        return 'installable';
    }
    return 'other';
};

/** Where Safari puts Share, for the current device (or both, off iOS). */
export const shareBarCopy = (): string => {
    if (!isIosDevice()) {
        return 'On iPhone, Share is in the bar at the bottom of Safari; on iPad, it is in the top toolbar.';
    }
    if (isIpadDevice()) {
        return 'Share is in the top toolbar.';
    }
    return 'Share is in the bar at the bottom of Safari.';
};
