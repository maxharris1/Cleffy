import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    PIANO_ANCHORS,
    anchorFileName,
    detectOnsetSec,
    loadPianoBuffers,
    nearestAnchor,
    playbackRateFor,
    resetPianoBufferCache,
} from '@/features/playback/pianoSampler';

const stubBuffer = (leadingSilenceSamples: number, sampleRate = 22050): AudioBuffer => {
    const data = new Float32Array(leadingSilenceSamples + 1000);
    for (let i = leadingSilenceSamples; i < data.length; i++) {
        data[i] = 0.5;
    }
    return { sampleRate, length: data.length, getChannelData: () => data } as unknown as AudioBuffer;
};

afterEach(() => {
    resetPianoBufferCache();
    vi.restoreAllMocks();
});

describe('anchor map', () => {
    it('covers C1–C8 every minor third with correct file names', () => {
        expect(PIANO_ANCHORS).toHaveLength(29);
        expect(anchorFileName(24)).toBe('C1.mp3');
        expect(anchorFileName(27)).toBe('Ds1.mp3');
        expect(anchorFileName(108)).toBe('C8.mp3');
    });

    it('nearestAnchor keeps pitch shifts within ±1.5 semitones and clamps extremes', () => {
        expect(nearestAnchor(60)).toBe(60);
        expect(nearestAnchor(61)).toBe(60);
        expect(nearestAnchor(62)).toBe(63);
        expect(nearestAnchor(21)).toBe(24); // A0 → C1 (lowest bundled anchor)
        expect(nearestAnchor(115)).toBe(108);
        for (let midi = 21; midi <= 108; midi++) {
            expect(Math.abs(midi - nearestAnchor(midi))).toBeLessThanOrEqual(3);
        }
    });

    it('playbackRateFor is an equal-temperament ratio', () => {
        expect(playbackRateFor(60, 60)).toBe(1);
        expect(playbackRateFor(61, 60)).toBeCloseTo(Math.pow(2, 1 / 12), 6);
        expect(playbackRateFor(59, 60)).toBeCloseTo(Math.pow(2, -1 / 12), 6);
    });
});

describe('detectOnsetSec', () => {
    it('finds the attack past codec padding, keeping ~2ms pre-roll', () => {
        // 2205 samples of silence at 22050 Hz = 100 ms of padding.
        expect(detectOnsetSec(stubBuffer(2205))).toBeCloseTo(0.098, 3);
    });

    it('returns 0 for an immediate attack and for silence', () => {
        expect(detectOnsetSec(stubBuffer(0))).toBe(0);
        const silent = { sampleRate: 22050, length: 100, getChannelData: () => new Float32Array(100) };
        expect(detectOnsetSec(silent as unknown as AudioBuffer)).toBe(0);
    });
});

describe('loadPianoBuffers', () => {
    it('decodes every anchor with its onset and caches the result', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })) as unknown as typeof fetch;
        const decoder = { decodeAudioData: vi.fn(async () => stubBuffer(1102)) };
        const voices = await loadPianoBuffers(decoder, fetchImpl);
        expect(voices.size).toBe(PIANO_ANCHORS.length);
        expect(voices.get(60)?.onsetSec).toBeCloseTo(0.048, 3); // ~50ms padding skipped
        await loadPianoBuffers(decoder, fetchImpl);
        expect(fetchImpl).toHaveBeenCalledTimes(PIANO_ANCHORS.length); // second call served from cache
    });

    it('clears the cache on failure so a retry can succeed', async () => {
        const failing = vi.fn(async () => ({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
        const decoder = { decodeAudioData: vi.fn(async () => stubBuffer(0)) };
        await expect(loadPianoBuffers(decoder, failing)).rejects.toThrow('HTTP 503');
        const working = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })) as unknown as typeof fetch;
        await expect(loadPianoBuffers(decoder, working)).resolves.toBeDefined();
    });
});
