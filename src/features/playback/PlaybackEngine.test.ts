import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import { PlaybackEngine } from '@/features/playback/PlaybackEngine';
import type { AudioContextLike, AudioParamLike } from '@/features/playback/PlaybackEngine';
import { PIANO_ANCHORS } from '@/features/playback/pianoSampler';
import type { PlaybackStatus } from '@/state/store';

class MockParam implements AudioParamLike {
    value = 0;
    readonly targets: Array<{ target: number; time: number }> = [];
    setValueAtTime(value: number, time: number): void {
        this.targets.push({ target: value, time });
    }
    setTargetAtTime(target: number, time: number): void {
        this.targets.push({ target, time });
    }
}

class MockGain {
    gain = new MockParam();
    connect(): void {}
    disconnect(): void {}
}

class MockSource {
    buffer: AudioBuffer | null = null;
    playbackRate = new MockParam();
    startedAt: number | null = null;
    stoppedAt: number | null = null;
    onended: (() => void) | null = null;
    connect(): void {}
    start(when = 0): void {
        this.startedAt = when;
    }
    stop(when = 0): void {
        this.stoppedAt = when;
    }
}

class MockOscillator {
    frequency = new MockParam();
    startedAt: number | null = null;
    connect(): void {}
    start(when = 0): void {
        this.startedAt = when;
    }
    stop(): void {}
}

class MockContext implements AudioContextLike {
    currentTime = 0;
    state = 'running';
    destination = {};
    readonly gains: MockGain[] = [];
    readonly sources: MockSource[] = [];
    readonly oscillators: MockOscillator[] = [];
    onstatechange: (() => void) | null = null;
    createGain(): MockGain {
        const gain = new MockGain();
        this.gains.push(gain);
        return gain;
    }
    createBufferSource(): MockSource {
        const source = new MockSource();
        this.sources.push(source);
        return source;
    }
    createOscillator(): MockOscillator {
        const osc = new MockOscillator();
        this.oscillators.push(osc);
        return osc;
    }
    async decodeAudioData(): Promise<AudioBuffer> {
        return {} as AudioBuffer;
    }
    async resume(): Promise<void> {}
    async close(): Promise<void> {}
}

const fakeBuffers = (attackLagSec = 0) =>
    new Map(PIANO_ANCHORS.map((midi) => [midi, { buffer: {} as AudioBuffer, onsetSec: 0, attackLagSec }]));

// Graph construction order in buildGraph(): master, RH bus, LH bus, click bus.
const BUS_RH = 1;
const BUS_LH = 2;

const makeEngine = (overrides?: { bpm?: number; score?: typeof tinyScore; attackLagSec?: number }) => {
    const ctx = new MockContext();
    const statuses: PlaybackStatus[] = [];
    const engine = new PlaybackEngine({
        score: overrides?.score ?? tinyScore,
        bpm: overrides?.bpm ?? 120,
        onStatus: (status) => statuses.push(status),
        createContext: () => ctx,
        loadBuffers: async () => fakeBuffers(overrides?.attackLagSec),
    });
    return { ctx, engine, statuses };
};

/** Advance wall clock and audio clock together (the engine assumes they agree). */
const advance = async (ctx: MockContext, seconds: number) => {
    const steps = Math.ceil(seconds / 0.025);
    for (let i = 0; i < steps; i++) {
        ctx.currentTime += seconds / steps;
        await vi.advanceTimersByTimeAsync(25);
    }
};

// At 120 bpm a quarter (480 ticks) lasts 0.5 s, so tinyScore's 13920 ticks
// run for 14.5 s.
const SPT_120 = 60 / (120 * 480);

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('PlaybackEngine', () => {
    it('schedules every note exactly once at its tick time', async () => {
        const { ctx, engine } = makeEngine();
        await engine.play();
        await advance(ctx, 16);
        expect(ctx.sources).toHaveLength(tinyScore.notes.length);
        // Default velocity 0.75 through the perceptual curve (v^1.6).
        expect(ctx.gains[4]?.gain.value).toBeCloseTo(Math.pow(0.75, 1.6), 4);
        // Note k starts at anchor(0.08) + t·spt.
        const expected = tinyScore.notes.map((n) => 0.08 + n.t * SPT_120);
        const actual = ctx.sources.map((s) => s.startedAt ?? -1).sort((a, b) => a - b);
        expected.sort((a, b) => a - b);
        for (const [i, time] of expected.entries()) {
            expect(actual[i]).toBeCloseTo(time, 3);
        }
        expect(engine.getStatus()).toBe('ended');
    });

    it('count-in covers a full bar plus the pickup lead-in, with two downbeat accents', async () => {
        const { ctx, engine, statuses } = makeEngine();
        await engine.play({ countIn: true });
        expect(engine.getStatus()).toBe('counting');
        await advance(ctx, 4.5);
        // tinyScore opens with a 1-beat pickup in 4/4: "ONE two three four,
        // ONE two three" = 7 clicks spanning 3360 ticks (3.5 s at 120 bpm).
        expect(ctx.oscillators).toHaveLength(7);
        expect(ctx.oscillators[0]?.startedAt).toBeCloseTo(0.08, 3);
        expect(ctx.oscillators[6]?.startedAt).toBeCloseTo(0.08 + 6 * 0.5, 3);
        expect(ctx.oscillators.filter((o) => o.frequency.value === 1800)).toHaveLength(2);
        // The pickup note enters exactly where beat 4 of the second bar falls.
        const firstNote = Math.min(...ctx.sources.map((s) => s.startedAt ?? Infinity));
        expect(firstNote).toBeCloseTo(0.08 + 7 * 0.5, 3);
        expect(statuses).toContain('playing');
        expect(engine.getPositionTicks()).toBeGreaterThan(0);
    });

    it('keeps the musical position continuous across a bpm change', async () => {
        const { ctx, engine } = makeEngine();
        await engine.play();
        await advance(ctx, 2);
        const before = engine.getPositionTicks();
        engine.setBpm(60);
        expect(engine.getPositionTicks()).toBeCloseTo(before, 0);
        await advance(ctx, 1);
        // 60 bpm → 480 ticks/second.
        expect(engine.getPositionTicks()).toBeCloseTo(before + 480, -1);
    });

    it('seek cancels ringing notes and replays from the target', async () => {
        const { ctx, engine } = makeEngine();
        await engine.play();
        await advance(ctx, 2);
        const sourcesBefore = ctx.sources.length;
        expect(sourcesBefore).toBeGreaterThan(3);
        engine.seek(0);
        await advance(ctx, 0.5);
        // The pickup note (t=0) has now been scheduled a second time.
        const pickupStarts = ctx.sources.filter((s) => s.buffer && s.startedAt !== null).length;
        expect(pickupStarts).toBeGreaterThan(sourcesBefore);
        expect(engine.getPositionTicks()).toBeLessThan(1500);
    });

    it('mute and volume route to the correct hand bus while scheduling continues', async () => {
        const { ctx, engine } = makeEngine();
        await engine.play();
        await advance(ctx, 0.5);
        engine.setHandMuted(1, true);
        engine.setHandVolume(0, 0.4);
        const lhTargets = ctx.gains[BUS_LH]?.gain.targets ?? [];
        const rhTargets = ctx.gains[BUS_RH]?.gain.targets ?? [];
        expect(lhTargets[lhTargets.length - 1]?.target).toBe(0);
        expect(rhTargets[rhTargets.length - 1]?.target).toBe(0.4);
        const before = ctx.sources.length;
        await advance(ctx, 1);
        expect(ctx.sources.length).toBeGreaterThan(before); // muted hand still schedules → instant unmute
    });

    it('wraps an A-B loop seamlessly and stays inside it', async () => {
        const { ctx, engine } = makeEngine();
        // Loop m.0–m.1 (ticks 0–2400): 2400 ticks at 120 bpm = 2.5 s per pass.
        engine.setLoop({ startTick: 0, endTick: 2400 });
        await engine.play();
        await advance(ctx, 8.2);
        expect(engine.getPositionTicks()).toBeLessThan(2400);
        // The pickup C5 (t=0) recurs on every pass: ≥3 passes in 4.2 s.
        const t0Starts = ctx.sources.filter((s) => {
            const at = s.startedAt;
            return at !== null && Math.abs(((at - 0.08) / SPT_120) % 2400) < 1;
        });
        expect(t0Starts.length).toBeGreaterThanOrEqual(3);
        expect(engine.getStatus()).toBe('playing'); // loops never end
    });

    it('reports ended after the final barline and can replay from the top', async () => {
        const { ctx, engine, statuses } = makeEngine({ bpm: 240 });
        await engine.play();
        await advance(ctx, 8.5); // 13920 ticks at 240 bpm ≈ 7.25 s
        expect(engine.getStatus()).toBe('ended');
        await engine.play();
        expect(statuses.filter((s) => s === 'playing').length).toBeGreaterThanOrEqual(2);
        expect(engine.getPositionTicks()).toBeLessThan(500);
    });

    it('metronome accents real downbeats — never the pickup', async () => {
        const { ctx, engine } = makeEngine();
        engine.setMetronome(true);
        await engine.play();
        await advance(ctx, 2.6);
        // m0 (pickup) clicks unaccented; m1's barline is the first accent.
        expect(ctx.oscillators.length).toBeGreaterThanOrEqual(6);
        expect(ctx.oscillators[0]?.frequency.value).toBe(1300);
        expect(ctx.oscillators[1]?.frequency.value).toBe(1800);
        expect(ctx.oscillators.some((o) => o.frequency.value === 1800)).toBe(true);
    });

    it('starts each note early by its attack lag so it is heard on the click', async () => {
        const lag = 0.02;
        const { ctx, engine } = makeEngine({ attackLagSec: lag });
        engine.setMetronome(true);
        await engine.play();
        await advance(ctx, 2.6);

        // Beat 1 of m.1 (tick 480) — click and note share the musical instant.
        const beatAt = 0.08 + 480 * SPT_120;
        const click = ctx.oscillators.find((o) => Math.abs((o.startedAt ?? -1) - beatAt) < 0.001);
        expect(click).toBeDefined(); // the click stays on the grid…
        const notes = ctx.sources.filter((s) => Math.abs((s.startedAt ?? -1) - (beatAt - lag)) < 0.001);
        expect(notes.length).toBeGreaterThan(0); // …and the note leads it by its rise time
        expect(ctx.sources.some((s) => Math.abs((s.startedAt ?? -1) - beatAt) < 0.001)).toBe(false);
    });

    it('never schedules a lag-compensated note into the past', async () => {
        const { ctx, engine } = makeEngine({ attackLagSec: 0.02 });
        await engine.play(); // first note sits 0.08 s out, well inside the lag
        ctx.currentTime = 0.075;
        await advance(ctx, 0.05);
        for (const source of ctx.sources) {
            expect(source.startedAt).toBeGreaterThanOrEqual(0);
        }
    });

    it('pauses cleanly when the context is suspended (iOS interruption)', async () => {
        const { ctx, engine } = makeEngine();
        await engine.play();
        await advance(ctx, 1);
        ctx.state = 'suspended';
        ctx.onstatechange?.();
        expect(engine.getStatus()).toBe('paused');
    });
});

describe('tempo map', () => {
    // tinyScore's bars are 1920 ticks. Halve the tempo from bar 3 (tick 5760):
    // bars 1-3 run at 120, everything after at 60.
    const paced: typeof tinyScore = {
        ...tinyScore,
        defaultBpm: 120,
        tempos: [
            { tick: 0, bpm: 120 },
            { tick: 5760, bpm: 60 },
        ],
    };

    it('hears a mid-score tempo change at the right moment', async () => {
        const { ctx, engine } = makeEngine({ score: paced, bpm: 120 });
        await engine.play();
        await advance(ctx, 30);
        const started = ctx.sources.map((s) => s.startedAt ?? -1).sort((a, b) => a - b);
        const expected = paced.notes
            .map((n) => 0.08 + (n.t <= 5760 ? n.t * SPT_120 : 5760 * SPT_120 + (n.t - 5760) * SPT_120 * 2))
            .sort((a, b) => a - b);
        expect(started).toHaveLength(expected.length);
        started.forEach((at, i) => expect(at).toBeCloseTo(expected[i] ?? -1, 3));
    });

    it('rings a note through a fermata rather than cutting it at the hold', async () => {
        const held: typeof tinyScore = { ...tinyScore, defaultBpm: 120, holds: [{ tick: 2400, beats: 2 }] };
        const plain = makeEngine({ score: { ...tinyScore, defaultBpm: 120 }, bpm: 120 });
        await plain.engine.play();
        await advance(plain.ctx, 20);
        const before = plain.ctx.sources.map((s) => (s.stoppedAt ?? 0) - (s.startedAt ?? 0));

        const withHold = makeEngine({ score: held, bpm: 120 });
        await withHold.engine.play();
        await advance(withHold.ctx, 24);
        const after = withHold.ctx.sources.map((s) => (s.stoppedAt ?? 0) - (s.startedAt ?? 0));

        // Something now sounds a full second longer — the hold at 2400 stretched
        // whatever was ringing across it.
        expect(Math.max(...after)).toBeGreaterThan(Math.max(...before) + 0.9);
    });

    it('wraps an A-B loop across a tempo change without a gap', async () => {
        // The loop spans the change at 5760, so the wrap has to re-base onto the
        // map rather than assume one seconds-per-tick throughout.
        const { ctx, engine } = makeEngine({ score: paced, bpm: 120 });
        engine.setLoop({ startTick: 3840, endTick: 7680 });
        await engine.play();
        await advance(ctx, 24);

        const loopSeconds =
            (5760 - 3840) * SPT_120 + (7680 - 5760) * SPT_120 * 2; // 2 s at 120, then 4 s at 60
        const onsets = ctx.sources.map((s) => s.startedAt ?? -1).sort((a, b) => a - b);
        expect(onsets.length).toBeGreaterThan(0);

        // Every onset lands on the loop's grid: k full laps plus a real note offset.
        const inLoop = paced.notes
            .filter((n) => n.t >= 3840 && n.t < 7680)
            .map((n) => (n.t <= 5760 ? (n.t - 3840) * SPT_120 : 1920 * SPT_120 + (n.t - 5760) * SPT_120 * 2));
        for (const onset of onsets) {
            const sinceStart = onset - 0.08 - (3840 - 3840) * SPT_120;
            const lap = Math.floor(sinceStart / loopSeconds + 1e-6);
            const offset = sinceStart - lap * loopSeconds;
            expect(inLoop.some((o) => Math.abs(o - offset) < 0.02)).toBe(true);
        }
        // It really did wrap more than once.
        expect(Math.max(...onsets)).toBeGreaterThan(0.08 + loopSeconds);
    });

    it('does not jump the position when the practice tempo changes mid-play', async () => {
        const { ctx, engine } = makeEngine({ score: paced, bpm: 120 });
        await engine.play();
        await advance(ctx, 3);
        const before = engine.getPositionTicks();
        engine.setBpm(60);
        expect(engine.getPositionTicks()).toBeCloseTo(before, 0);
    });

    it('reports the tempo actually sounding, which the field alone does not', () => {
        const { engine } = makeEngine({ score: paced, bpm: 120 });
        expect(engine.getBpmAt(0)).toBe(120);
        expect(engine.getBpmAt(6000)).toBe(60);
        engine.setBpm(60); // practise the whole thing at half speed
        expect(engine.getBpmAt(0)).toBe(60);
        expect(engine.getBpmAt(6000)).toBe(30);
    });
});
