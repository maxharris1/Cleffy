import { track } from '@/lib/webEvents';

/** sessionStorage: '1' once this tab has sent its demo_visit. */
export const DEMO_VISIT_SENT_KEY = 'cleffy:demo-visit-sent';

/** For a browser that refuses sessionStorage: sent once per page load instead. */
let demoVisitSentThisLoad = false;

/**
 * One demo_visit per tab (src/lib/webEvents.ts): a reload or a return to
 * /try in the same tab is the same visit. Counted on arrival, before the score
 * loads, so a visitor who leaves while it downloads still counts.
 */
export const sendDemoVisitOnce = (): void => {
    try {
        if (window.sessionStorage.getItem(DEMO_VISIT_SENT_KEY) === '1') {
            return;
        }
    } catch {
        // Unreadable: fall back to this page load's flag.
    }
    if (demoVisitSentThisLoad) {
        return;
    }
    demoVisitSentThisLoad = true;
    try {
        window.sessionStorage.setItem(DEMO_VISIT_SENT_KEY, '1');
    } catch {
        // Private mode or site data blocked: once per page load.
    }
    track('demo_visit');
};

export const resetDemoVisitForTests = (): void => {
    demoVisitSentThisLoad = false;
};
