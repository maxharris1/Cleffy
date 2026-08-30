import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditionNotes, resetAuditionState, stopAudition } from '@/features/playback/auditionNotes';
import { resetPianoBufferCache } from '@/features/playback/pianoSampler';

class MockBuffer implements AudioBuffer {
    readonly length = 1000;
    readonly duration = 0.1;
    readonly sampleRate = 44100;
    readonly numberOfChannels = 1;
    private readonly data = new Float32Array(1000);

    constructor() {
        this.data[10] = 0.5;
    }

    // Explicitly over ArrayBuffer: a bare Float32Array widens to
    // Float32Array<ArrayBufferLike>, which AudioBuffer does not accept, and the
    // mock would then only satisfy `implements AudioBuffer` behind a cast.
    getChannelData(): Float32Array<ArrayBuffer> {
        return this.data;
    }
    copyFromChannel(): void {}
    copyToChannel(): void {}
}

const mockParam = () => ({
    value: 0,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
});

/**
 * Audition shares PlaybackEngine's voice path (source → lowpass → gain →
 * panner) and its limiter, so a mock context has to be able to build those.
 */
const voiceNodeFactories = {
    createBiquadFilter: () => ({
        type: '',
        frequency: mockParam(),
        Q: mockParam(),
        connect: vi.fn(),
        disconnect: vi.fn(),
    }),
    createStereoPanner: () => ({ pan: mockParam(), connect: vi.fn(), disconnect: vi.fn() }),
    createDynamicsCompressor: () => ({
        threshold: mockParam(),
        knee: mockParam(),
        ratio: mockParam(),
        attack: mockParam(),
        release: mockParam(),
        connect: vi.fn(),
        disconnect: vi.fn(),
    }),
    createWaveShaper: () => ({
        curve: null as Float32Array | null,
        oversample: 'none',
        connect: vi.fn(),
        disconnect: vi.fn(),
    }),
};

function installAudioMocks() {
    const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    class MockContext {
        currentTime = 0;
        state = 'running';
        destination = {};
        createGain() {
            return {
                gain: {
                    value: 1,
                    setValueAtTime: vi.fn(),
                    setTargetAtTime: vi.fn(),
                    cancelScheduledValues: vi.fn(),
                },
                connect: vi.fn(),
                disconnect: vi.fn(),
            };
        }
        createBufferSource() {
            const source = {
                buffer: null as AudioBuffer | null,
                playbackRate: { value: 1 },
                connect: vi.fn(),
                disconnect: vi.fn(),
                start: vi.fn(),
                stop: vi.fn(),
                onended: null as (() => void) | null,
            };
            sources.push(source);
            return source;
        }
        createBiquadFilter = voiceNodeFactories.createBiquadFilter;
        createStereoPanner = voiceNodeFactories.createStereoPanner;
        createDynamicsCompressor = voiceNodeFactories.createDynamicsCompressor;
        createWaveShaper = voiceNodeFactories.createWaveShaper;
        async decodeAudioData(): Promise<AudioBuffer> {
            return new MockBuffer();
        }
        async resume(): Promise<void> {}
        async close(): Promise<void> {
            this.state = 'closed';
        }
    }
    vi.stubGlobal('AudioContext', MockContext);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
        })),
    );
    return sources;
}

beforeEach(() => {
    resetAuditionState();
    resetPianoBufferCache();
});

afterEach(() => {
    resetAuditionState();
    resetPianoBufferCache();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('auditionNotes', () => {
    it('is a no-op for an empty chord', async () => {
        const sources = installAudioMocks();
        await auditionNotes([]);
        expect(sources).toHaveLength(0);
    });

    it('starts one voice per unique midi', async () => {
        const sources = installAudioMocks();
        await auditionNotes([60, 64, 67, 60]);
        expect(sources).toHaveLength(3);
        for (const s of sources) {
            expect(s.start).toHaveBeenCalled();
        }
    });

    it('cuts off a previous chord when auditioning again', async () => {
        const sources = installAudioMocks();
        await auditionNotes([60]);
        expect(sources).toHaveLength(1);
        await auditionNotes([64, 67]);
        expect(sources[0]?.stop).toHaveBeenCalled();
        expect(sources).toHaveLength(3);
    });

    it('stopAudition silences active voices', async () => {
        const sources = installAudioMocks();
        await auditionNotes([60]);
        stopAudition();
        expect(sources[0]?.stop).toHaveBeenCalled();
    });

    it('does not start voices if stopAudition runs while buffers load', async () => {
        let resolveFetch: ((value: { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }) => void) | undefined;
        const fetchPromise = new Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>((resolve) => {
            resolveFetch = resolve;
        });
        const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
        class MockContext {
            currentTime = 0;
            state = 'running';
            destination = {};
            createGain() {
                return {
                    gain: {
                        value: 1,
                        setValueAtTime: vi.fn(),
                        setTargetAtTime: vi.fn(),
                        cancelScheduledValues: vi.fn(),
                    },
                    connect: vi.fn(),
                    disconnect: vi.fn(),
                };
            }
            createBufferSource() {
                const source = {
                    buffer: null as AudioBuffer | null,
                    playbackRate: { value: 1 },
                    connect: vi.fn(),
                    disconnect: vi.fn(),
                    start: vi.fn(),
                    stop: vi.fn(),
                    onended: null as (() => void) | null,
                };
                sources.push(source);
                return source;
            }
            createBiquadFilter = voiceNodeFactories.createBiquadFilter;
            createStereoPanner = voiceNodeFactories.createStereoPanner;
            createDynamicsCompressor = voiceNodeFactories.createDynamicsCompressor;
            createWaveShaper = voiceNodeFactories.createWaveShaper;
            async decodeAudioData(): Promise<AudioBuffer> {
                return new MockBuffer();
            }
            async resume(): Promise<void> {}
            async close(): Promise<void> {
                this.state = 'closed';
            }
        }
        vi.stubGlobal('AudioContext', MockContext);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => fetchPromise),
        );

        const pending = auditionNotes([60]);
        stopAudition();
        resolveFetch?.({
            ok: true,
            arrayBuffer: async () => new ArrayBuffer(8),
        });
        await pending;
        expect(sources).toHaveLength(0);
    });
});
