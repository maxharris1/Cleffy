/**
 * One AudioContext for score playback and fingering Hear. Feature code must
 * not close it — only `resetSharedAudioContext` (tests) may. PlaybackEngine
 * tears down its graph on destroy and leaves this context running.
 */

let shared: AudioContext | null = null;

export const getSharedAudioContext = (): AudioContext => {
    if (!shared || shared.state === 'closed') {
        shared = new AudioContext();
    }
    return shared;
};

/** Test hook — drop the shared context between cases. */
export const resetSharedAudioContext = (): void => {
    if (shared && shared.state !== 'closed') {
        void shared.close().catch(() => undefined);
    }
    shared = null;
};
