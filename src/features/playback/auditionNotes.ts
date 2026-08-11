import {
    loadPianoBuffers,
    nearestAnchor,
    playbackRateFor,
    type PianoBuffers,
} from '@/features/playback/pianoSampler';
import { getSharedAudioContext, resetSharedAudioContext } from '@/features/playback/sharedAudioContext';

/**
 * One-shot chord audition for review/diagram UIs — same Salamander samples as
 * score playback, but no transport, score, or hand buses. Shares AudioContext
 * + buffer cache with PlaybackEngine so the first Hear after Play is free.
 */

const HOLD_S = 0.6;
const RELEASE_TAU_S = 0.06;
const RELEASE_STOP_S = 0.35;
const VELOCITY = 0.72;

interface ActiveVoice {
    source: AudioBufferSourceNode;
    gain: GainNode;
}

let buffers: PianoBuffers | null = null;
let loadPromise: Promise<PianoBuffers> | null = null;
let active: ActiveVoice[] = [];
/** Bumped to cancel in-flight buffer loads / abandoned auditions. */
let generation = 0;

const ensureBuffers = async (ctx: AudioContext): Promise<PianoBuffers> => {
    if (buffers) {
        return buffers;
    }
    if (!loadPromise) {
        loadPromise = loadPianoBuffers(ctx).then((loaded) => {
            buffers = loaded;
            return loaded;
        });
    }
    try {
        return await loadPromise;
    } catch (err) {
        loadPromise = null;
        throw err;
    }
};

const silenceActive = (): void => {
    if (active.length === 0) {
        return;
    }
    const now = getSharedAudioContext().currentTime;
    for (const { source, gain } of active) {
        try {
            gain.gain.cancelScheduledValues(now);
            gain.gain.setTargetAtTime(0, now, 0.02);
            source.stop(now + 0.08);
        } catch {
            // already stopped
        }
        try {
            gain.disconnect();
        } catch {
            // already disconnected
        }
    }
    active = [];
};

/** Silence voices and cancel any in-flight auditionNotes awaiting buffers. */
export const stopAudition = (): void => {
    generation += 1;
    silenceActive();
};

/**
 * Play `midis` together as a short piano chord. Re-entrant: a new call cuts
 * off the previous chord. Empty input is a no-op. Must run from a user gesture
 * so the AudioContext can resume on iOS. If `stopAudition` runs while buffers
 * are still loading, this call aborts and does not start voices.
 */
export const auditionNotes = async (midis: readonly number[]): Promise<void> => {
    const unique = [...new Set(midis.filter((m) => Number.isFinite(m)))];
    if (unique.length === 0) {
        return;
    }

    const gen = ++generation;
    silenceActive();

    const ctx = getSharedAudioContext();
    await ctx.resume().catch(() => undefined);
    if (gen !== generation) {
        return;
    }
    const piano = await ensureBuffers(ctx);
    if (gen !== generation) {
        return;
    }

    const now = ctx.currentTime;
    for (const midi of unique) {
        const anchor = nearestAnchor(midi);
        const voice = piano.get(anchor);
        if (!voice) {
            continue;
        }
        const at = Math.max(now, now - voice.attackLagSec);
        const source = ctx.createBufferSource();
        source.buffer = voice.buffer;
        source.playbackRate.value = playbackRateFor(midi, anchor);
        const gain = ctx.createGain();
        const gainValue = Math.pow(VELOCITY, 1.6) * 0.85;
        gain.gain.value = gainValue;
        source.connect(gain);
        gain.connect(ctx.destination);

        const endAt = at + HOLD_S;
        gain.gain.setValueAtTime(gainValue, endAt);
        gain.gain.setTargetAtTime(0, endAt, RELEASE_TAU_S);
        source.start(at, voice.onsetSec);
        source.stop(endAt + RELEASE_STOP_S);

        const entry: ActiveVoice = { source, gain };
        active.push(entry);
        source.onended = () => {
            active = active.filter((v) => v !== entry);
            try {
                gain.disconnect();
            } catch {
                // already disconnected
            }
        };
    }
};

/** Test hook — drop shared state between cases. */
export const resetAuditionState = (): void => {
    stopAudition();
    resetSharedAudioContext();
    buffers = null;
    loadPromise = null;
};
