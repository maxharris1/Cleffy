/** How the engine treats tempo: exactly as printed, or with the small liberties a player takes. */
export type TempoStyle = 'strict' | 'expressive';

export interface PlaybackPrefs {
    tempoStyle: TempoStyle;
    /** Play the pedal edges the service inferred for an unmarked score. */
    autoPedal: boolean;
}

const STORAGE_KEY = 'cleffy:playback-prefs';

/**
 * Strict by default: the play-along is a practice reference before it is a
 * performance, and a beat that lands where the metronome says is what a
 * learner counts against. Inferred pedal is on: an unmarked piano score is
 * almost always played with pedal.
 */
export const DEFAULT_PLAYBACK_PREFS: PlaybackPrefs = { tempoStyle: 'strict', autoPedal: true };

const isTempoStyle = (value: unknown): value is TempoStyle => value === 'strict' || value === 'expressive';

/**
 * Reads the saved preferences, falling back to the defaults field by field.
 *
 * Every access is wrapped: Safari in private mode and any browser with site
 * data disabled THROW on `localStorage` rather than returning null, and a
 * player who cannot persist a preference must still get playback. Anything
 * unrecognised (hand-edited, or written by a future version) reads as unset.
 */
export const readPlaybackPrefs = (): PlaybackPrefs => {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (!stored) {
            return { ...DEFAULT_PLAYBACK_PREFS };
        }
        const parsed: unknown = JSON.parse(stored);
        if (typeof parsed !== 'object' || parsed === null) {
            return { ...DEFAULT_PLAYBACK_PREFS };
        }
        const record = parsed as Record<string, unknown>;
        return {
            tempoStyle: isTempoStyle(record.tempoStyle) ? record.tempoStyle : DEFAULT_PLAYBACK_PREFS.tempoStyle,
            autoPedal: typeof record.autoPedal === 'boolean' ? record.autoPedal : DEFAULT_PLAYBACK_PREFS.autoPedal,
        };
    } catch {
        return { ...DEFAULT_PLAYBACK_PREFS };
    }
};

/** Persists the preferences, best-effort — a preference is never worth an error state. */
export const writePlaybackPrefs = (prefs: PlaybackPrefs): void => {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
        // Storage disabled or full: the choice still holds for this session.
    }
};
