import { loadPianoBuffers, nearestAnchor, playbackRateFor } from '@/features/playback/pianoSampler';
import type { PianoBuffers } from '@/features/playback/pianoSampler';
import {
    beatsForMeasure,
    buildTempoMap,
    countInClicks,
    firstNoteIndexAtOrAfter,
    measureIndexAtTick,
    secondsAtTick,
    tickAtSeconds,
} from '@/features/playback/scoreTime';
import type { BeatTick, TempoMap } from '@/features/playback/scoreTime';
import { getSharedAudioContext } from '@/features/playback/sharedAudioContext';
import type { PlaybackStatus } from '@/state/store';
import { DEFAULT_VELOCITY, HAND_LH, HAND_RH } from '@/types/scoreData';
import type { ScoreData } from '@/types/scoreData';

/**
 * Web Audio playback of a ScoreData: classic lookahead scheduler (25 ms tick,
 * 120 ms horizon) feeding sampled piano notes into per-hand gain buses, plus
 * a synthesized click bus for metronome and count-in, and an anchor-swap
 * mechanism that makes BPM changes, seeks, count-in, and seamless A-B loop
 * wraps all the same operation. DOM/React-free; the caller owns AudioContext
 * creation timing (iOS requires it inside the user's tap).
 */

const SCHEDULER_INTERVAL_MS = 25;
const HORIZON_S = 0.12;
const START_DELAY_S = 0.08;
const RELEASE_TAU_S = 0.06;
const RELEASE_STOP_S = 0.35;
const MAX_ACTIVE_SOURCES = 64;

/** Structural subset of AudioContext used by the engine — mockable in tests. */
export interface AudioContextLike {
    readonly currentTime: number;
    readonly state: string;
    readonly destination: unknown;
    createGain(): GainNodeLike;
    createBufferSource(): AudioBufferSourceLike;
    createOscillator(): OscillatorLike;
    decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
    resume(): Promise<void>;
    close(): Promise<void>;
    onstatechange?: (() => void) | null;
}

export interface AudioParamLike {
    value: number;
    setValueAtTime(value: number, time: number): unknown;
    setTargetAtTime(target: number, time: number, timeConstant: number): unknown;
}

export interface GainNodeLike {
    gain: AudioParamLike;
    connect(target: unknown): unknown;
    disconnect(): void;
}

export interface AudioBufferSourceLike {
    buffer: AudioBuffer | null;
    playbackRate: AudioParamLike;
    connect(target: unknown): unknown;
    start(when?: number, offset?: number): void;
    stop(when?: number): void;
    onended: (() => void) | null;
}

export interface OscillatorLike {
    frequency: AudioParamLike;
    connect(target: unknown): unknown;
    start(when?: number): void;
    stop(when?: number): void;
}

export interface LoopRegion {
    startTick: number;
    endTick: number;
}

export interface PlaybackEngineOptions {
    score: ScoreData;
    bpm: number;
    onStatus: (status: PlaybackStatus) => void;
    /** Fired after seeks/stops so the playhead can redraw while paused. */
    onPositionJump?: () => void;
    onWarning?: (code: string) => void;
    /** Test seams. */
    createContext?: () => AudioContextLike;
    loadBuffers?: (ctx: AudioContextLike) => Promise<PianoBuffers>;
}

interface Anchor {
    tick: number;
    ctxTime: number;
    /** Position on the score's own clock, so tempo changes stay continuous. */
    baseSeconds: number;
}

interface ActiveNote {
    source: AudioBufferSourceLike;
    gain: GainNodeLike;
}

export class PlaybackEngine {
    private readonly score: ScoreData;
    private readonly onStatus: (status: PlaybackStatus) => void;
    private readonly onPositionJump: (() => void) | undefined;
    private readonly onWarning: ((code: string) => void) | undefined;
    private readonly createContext: () => AudioContextLike;
    private readonly loadBuffers: (ctx: AudioContextLike) => Promise<PianoBuffers>;

    private ctx: AudioContextLike | null = null;
    private buffers: PianoBuffers | null = null;
    private master: GainNodeLike | null = null;
    private handBuses: [GainNodeLike, GainNodeLike] | null = null;
    private clickBus: GainNodeLike | null = null;

    private status: PlaybackStatus = 'idle';
    /** The score's tempo map, scaled to the practice tempo. */
    private map: TempoMap;
    private bpmValue: number;
    private anchor: Anchor = { tick: 0, ctxTime: 0, baseSeconds: 0 };
    private pendingAnchor: Anchor | null = null;
    private pausedTick = 0;
    private nextNoteIndex = 0;
    private nextBeat: BeatTick | null = null;
    private loop: LoopRegion | null = null;
    private muted: [boolean, boolean] = [false, false];
    private volumes: [number, number] = [1, 1];
    private metronome = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly active = new Set<ActiveNote>();
    private warnedSourceCap = false;
    private destroyed = false;

    constructor(options: PlaybackEngineOptions) {
        this.score = options.score;
        this.bpmValue = options.bpm;
        this.map = buildTempoMap(options.score, this.scaleFor(options.bpm), options.bpm);
        this.onStatus = options.onStatus;
        this.onPositionJump = options.onPositionJump;
        this.onWarning = options.onWarning;
        this.createContext = options.createContext ?? (() => getSharedAudioContext() as unknown as AudioContextLike);
        this.loadBuffers = options.loadBuffers ?? ((ctx) => loadPianoBuffers(ctx));
    }

    getStatus(): PlaybackStatus {
        return this.status;
    }

    getBpm(): number {
        return this.bpmValue;
    }

    /** Current musical position in ticks (drives the playhead each frame). */
    getPositionTicks(): number {
        if (!this.ctx || this.status === 'idle' || this.status === 'paused' || this.status === 'ended' || this.status === 'loading') {
            return this.pausedTick;
        }
        this.promotePendingAnchor(this.ctx.currentTime);
        const raw = tickAtSeconds(this.map, this.anchor.baseSeconds + (this.ctx.currentTime - this.anchor.ctxTime));
        // Never regress below the anchor (count-in and the 50 ms seek ramp sit
        // "before" it) and never overshoot the final barline.
        return Math.min(this.score.totalTicks, Math.max(this.anchor.tick, raw));
    }

    async play(options?: { countIn?: boolean }): Promise<void> {
        if (this.destroyed || this.status === 'playing' || this.status === 'counting' || this.status === 'loading') {
            return;
        }
        if (!this.ctx) {
            this.ctx = this.createContext();
            this.buildGraph(this.ctx);
            this.watchStateChanges(this.ctx);
        }
        await this.ctx.resume().catch(() => undefined);
        if (!this.buffers) {
            this.setStatus('loading');
            try {
                this.buffers = await this.loadBuffers(this.ctx);
            } catch {
                this.setStatus('idle');
                this.onWarning?.('samples_unavailable');
                return;
            }
            if (this.destroyed) {
                return;
            }
        }

        const startTick = this.status === 'ended' ? (this.loop ? this.loop.startTick : 0) : this.pausedTick;
        const now = this.ctx.currentTime;
        const startAt = now + START_DELAY_S;

        if (options?.countIn) {
            // One full bar plus the entry bar's lead-in beats, so pickups and
            // mid-bar entries land on the right count (see countInClicks).
            const clicks = countInClicks(this.score, startTick);
            const lead = clicks[0]?.offsetTicks ?? 0;
            // Count-in ticks run BEFORE the entry point, so the map extrapolates
            // back past zero; counting into a slow coda then counts slowly.
            const leadSeconds = secondsAtTick(this.map, startTick) - secondsAtTick(this.map, startTick - lead);
            for (const click of clicks) {
                const before = secondsAtTick(this.map, startTick - click.offsetTicks);
                this.scheduleClick(startAt + (before - secondsAtTick(this.map, startTick - lead)), click.accent);
            }
            this.anchor = this.anchorAt(startTick, startAt + leadSeconds);
            this.setStatus(leadSeconds > 0 ? 'counting' : 'playing');
        } else {
            this.anchor = this.anchorAt(startTick, startAt);
            this.setStatus('playing');
        }
        this.pendingAnchor = null;
        this.nextNoteIndex = firstNoteIndexAtOrAfter(this.score.notes, startTick);
        this.nextBeat = null;
        this.scheduleSustainingNotesAt(startTick);
        this.startScheduler();
    }

    pause(): void {
        if (this.status !== 'playing' && this.status !== 'counting') {
            return;
        }
        this.pausedTick = this.getPositionTicks();
        this.stopScheduler();
        this.cancelActiveNotes();
        this.setStatus('paused');
    }

    /** Stop = rewind to the start (of the loop when one is active) and hold. */
    stop(): void {
        const target = this.loop ? this.loop.startTick : 0;
        this.seek(target);
        if (this.status === 'playing' || this.status === 'counting') {
            this.pause();
            this.pausedTick = target;
        } else {
            this.setStatus(this.status === 'idle' ? 'idle' : 'paused');
        }
        this.onPositionJump?.();
    }

    seek(tick: number): void {
        const clamped = Math.max(0, Math.min(this.score.totalTicks, Math.round(tick)));
        if (this.ctx && (this.status === 'playing' || this.status === 'counting')) {
            this.cancelActiveNotes();
            this.anchor = this.anchorAt(clamped, this.ctx.currentTime + 0.05);
            this.pendingAnchor = null;
            this.nextNoteIndex = firstNoteIndexAtOrAfter(this.score.notes, clamped);
            this.nextBeat = null;
            this.scheduleSustainingNotesAt(clamped);
            if (this.status === 'counting') {
                this.setStatus('playing');
            }
        } else {
            this.pausedTick = clamped;
            if (this.status === 'ended') {
                this.setStatus('paused');
            }
        }
        this.onPositionJump?.();
    }

    setBpm(bpm: number): void {
        this.bpmValue = bpm;
        const wasPlaying = this.ctx && (this.status === 'playing' || this.status === 'counting');
        if (wasPlaying && this.ctx) {
            // Read the position on the OLD map before rebuilding, then re-anchor
            // on the new one, or the playhead jumps when the tempo changes.
            const positionNow = this.getPositionTicks();
            this.map = buildTempoMap(this.score, this.scaleFor(bpm), bpm);
            this.anchor = this.anchorAt(positionNow, this.ctx.currentTime);
            this.pendingAnchor = null;
            this.nextBeat = null;
        } else {
            this.map = buildTempoMap(this.score, this.scaleFor(bpm), bpm);
        }
    }

    /**
     * Quarter-BPM actually sounding at a tick. The transport field shows the
     * opening tempo; mid-score this can differ, and saying so is the honest
     * alternative to a number that quietly stops being true.
     */
    getBpmAt(tick: number): number {
        return Math.round(this.bpmValue * this.tempoRatioAt(tick));
    }

    private tempoRatioAt(tick: number): number {
        const nominal = this.score.tempos?.[0]?.bpm ?? this.score.defaultBpm ?? this.bpmValue;
        let bpm = nominal;
        for (const tempo of this.score.tempos ?? []) {
            if (tempo.tick > tick) {
                break;
            }
            bpm = tempo.bpm;
        }
        return nominal > 0 ? bpm / nominal : 1;
    }

    setHandMuted(hand: 0 | 1, muted: boolean): void {
        this.muted[hand] = muted;
        this.applyBusGain(hand);
    }

    setHandVolume(hand: 0 | 1, volume: number): void {
        this.volumes[hand] = Math.min(1, Math.max(0, volume));
        this.applyBusGain(hand);
    }

    setMetronome(on: boolean): void {
        this.metronome = on;
        this.nextBeat = null;
    }

    setLoop(loop: LoopRegion | null): void {
        this.loop = loop && loop.endTick > loop.startTick ? loop : null;
        this.pendingAnchor = null;
        if (this.loop && this.status !== 'playing' && this.status !== 'counting') {
            // Snap a paused transport into the loop so Play starts inside it.
            if (this.pausedTick < this.loop.startTick || this.pausedTick >= this.loop.endTick) {
                this.seek(this.loop.startTick);
            }
        }
    }

    getLoop(): LoopRegion | null {
        return this.loop;
    }

    destroy(): void {
        this.destroyed = true;
        this.stopScheduler();
        this.cancelActiveNotes();
        this.teardownGraph();
        // Do not close the shared AudioContext — Hear / next PlaybackEngine reuse it.
        this.ctx = null;
        this.setStatus('idle');
    }

    // ----- internals -------------------------------------------------------

    private setStatus(status: PlaybackStatus): void {
        if (this.status !== status) {
            this.status = status;
            this.onStatus(status);
        }
    }

    private teardownGraph(): void {
        for (const bus of this.handBuses ?? []) {
            try {
                bus.disconnect();
            } catch {
                // already disconnected
            }
        }
        try {
            this.clickBus?.disconnect();
        } catch {
            // already disconnected
        }
        try {
            this.master?.disconnect();
        } catch {
            // already disconnected
        }
        this.handBuses = null;
        this.clickBus = null;
        this.master = null;
    }

    private buildGraph(ctx: AudioContextLike): void {
        this.master = ctx.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(ctx.destination);
        const rh = ctx.createGain();
        const lh = ctx.createGain();
        rh.connect(this.master);
        lh.connect(this.master);
        this.handBuses = [rh, lh];
        this.clickBus = ctx.createGain();
        this.clickBus.gain.value = 0.5;
        this.clickBus.connect(this.master);
        this.applyBusGain(HAND_RH);
        this.applyBusGain(HAND_LH);
    }

    private watchStateChanges(ctx: AudioContextLike): void {
        if ('onstatechange' in ctx) {
            ctx.onstatechange = () => {
                // iOS suspends the context on interruptions (calls, Siri,
                // backgrounding) — degrade to a clean pause, never a hang.
                if (ctx.state !== 'running' && (this.status === 'playing' || this.status === 'counting')) {
                    this.pause();
                }
            };
        }
    }

    private applyBusGain(hand: 0 | 1): void {
        const bus = this.handBuses?.[hand];
        if (!bus || !this.ctx) {
            return;
        }
        const target = this.muted[hand] ? 0 : this.volumes[hand];
        bus.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    }

    private startScheduler(): void {
        this.stopScheduler();
        this.timer = setInterval(() => this.schedulerTick(), SCHEDULER_INTERVAL_MS);
        this.schedulerTick();
    }

    private stopScheduler(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private promotePendingAnchor(now: number): void {
        if (this.pendingAnchor && now >= this.pendingAnchor.ctxTime) {
            this.anchor = this.pendingAnchor;
            this.pendingAnchor = null;
        }
    }

    /** Time a tick will sound, against the anchor scheduling currently targets. */
    private timeOfTick(tick: number): number {
        const anchor = this.pendingAnchor ?? this.anchor;
        return anchor.ctxTime + (secondsAtTick(this.map, tick) - anchor.baseSeconds);
    }

    /** An anchor at a tick, pinned to a context time. */
    private anchorAt(tick: number, ctxTime: number): Anchor {
        return { tick, ctxTime, baseSeconds: secondsAtTick(this.map, tick) };
    }

    /**
     * The transport shows an absolute BPM, but with a tempo map it means "the
     * printed opening tempo, rescaled" — the whole map moves by one factor.
     */
    private scaleFor(bpm: number): number {
        const nominal = this.score.tempos?.[0]?.bpm ?? this.score.defaultBpm ?? bpm;
        return nominal > 0 ? bpm / nominal : 1;
    }

    private schedulerTick(): void {
        const ctx = this.ctx;
        if (!ctx || (this.status !== 'playing' && this.status !== 'counting')) {
            return;
        }
        const now = ctx.currentTime;
        this.promotePendingAnchor(now);
        if (this.status === 'counting' && now >= this.anchor.ctxTime) {
            this.setStatus('playing');
        }
        const horizon = now + HORIZON_S;

        for (let wraps = 0; wraps < 4; wraps++) {
            const regionEnd = this.loop ? this.loop.endTick : this.score.totalTicks;

            this.scheduleNotesUpTo(regionEnd, horizon);
            if (this.metronome) {
                this.scheduleBeatsUpTo(regionEnd, horizon);
            }

            if (this.loop && this.timeOfTick(this.loop.endTick) < horizon && !this.pendingAnchor) {
                // Seamless wrap: future content re-anchors at the loop start.
                this.pendingAnchor = {
                    tick: this.loop.startTick,
                    ctxTime: this.timeOfTick(this.loop.endTick),
                    baseSeconds: secondsAtTick(this.map, this.loop.startTick),
                };
                this.nextNoteIndex = firstNoteIndexAtOrAfter(this.score.notes, this.loop.startTick);
                this.nextBeat = null;
                // Do not scheduleSustainingNotesAt here — notes that began before the
                // loop start would ghost-retrigger on every wrap.
                continue;
            }
            break;
        }

        // The final barline is the end — the last notes' release tails keep
        // ringing on their own after the scheduler stops.
        if (!this.loop && this.getPositionTicks() >= this.score.totalTicks) {
            this.stopScheduler();
            this.pausedTick = this.score.totalTicks;
            this.setStatus('ended');
        }
    }

    private scheduleNotesUpTo(regionEnd: number, horizon: number): void {
        const notes = this.score.notes;
        while (this.nextNoteIndex < notes.length) {
            const note = notes[this.nextNoteIndex];
            if (!note || note.t >= regionEnd) {
                break;
            }
            const startAt = this.timeOfTick(note.t);
            if (startAt >= horizon) {
                break;
            }
            this.nextNoteIndex += 1;
            // Durations convert through the map, so a note sounding across a
            // fermata rings through the hold instead of being cut at it.
            const endTick = Math.min(note.t + note.d, regionEnd);
            this.scheduleNote(note.p, note.h, startAt, this.timeOfTick(endTick) - startAt, note.v ?? DEFAULT_VELOCITY);
        }
    }

    /**
     * After seek/play into the middle of a sustained note, schedule the
     * remaining ring so chords don't go silent until the next attack.
     * When a loop is active, ignore notes that began before the loop start
     * so play/seek at A does not revive pre-loop tails.
     */
    private scheduleSustainingNotesAt(tick: number): void {
        const regionStart = this.loop ? this.loop.startTick : 0;
        const regionEnd = this.loop ? this.loop.endTick : this.score.totalTicks;
        const startAt = this.timeOfTick(tick);
        for (const note of this.score.notes) {
            if (note.t >= tick) {
                break;
            }
            if (note.t < regionStart) {
                continue;
            }
            const noteEnd = Math.min(note.t + note.d, regionEnd);
            if (noteEnd <= tick) {
                continue;
            }
            this.scheduleNote(note.p, note.h, startAt, this.timeOfTick(noteEnd) - startAt, note.v ?? DEFAULT_VELOCITY);
        }
    }

    private scheduleBeatsUpTo(regionEnd: number, horizon: number): void {
        for (let guard = 0; guard < 128; guard++) {
            if (this.nextBeat === null) {
                this.nextBeat = this.firstBeatAtOrAfter(Math.max(this.schedulingPositionFloor(), 0));
            }
            if (this.nextBeat === null || this.nextBeat.tick >= regionEnd) {
                return;
            }
            const at = this.timeOfTick(this.nextBeat.tick);
            if (at >= horizon) {
                return;
            }
            this.scheduleClick(at, this.nextBeat.accent);
            this.nextBeat = this.firstBeatAtOrAfter(this.nextBeat.tick + 1);
        }
    }

    /** Where beat scheduling should begin: the scheduling anchor's tick. */
    private schedulingPositionFloor(): number {
        return (this.pendingAnchor ?? this.anchor).tick;
    }

    private firstBeatAtOrAfter(tick: number): BeatTick | null {
        const index = measureIndexAtTick(this.score.measures, tick);
        if (index < 0) {
            return null;
        }
        for (let i = index; i < this.score.measures.length; i++) {
            const measure = this.score.measures[i];
            if (!measure) {
                return null;
            }
            for (const beat of beatsForMeasure(measure, this.score.timeSignatures)) {
                if (beat.tick >= tick) {
                    return beat;
                }
            }
        }
        return null;
    }

    private scheduleNote(midi: number, hand: 0 | 1, startAt: number, durationSec: number, velocity: number): void {
        const ctx = this.ctx;
        const buffers = this.buffers;
        const bus = this.handBuses?.[hand];
        if (!ctx || !buffers || !bus) {
            return;
        }
        if (this.active.size >= MAX_ACTIVE_SOURCES) {
            if (!this.warnedSourceCap) {
                this.warnedSourceCap = true;
                this.onWarning?.('too_many_voices');
            }
            return;
        }
        const anchor = nearestAnchor(midi);
        const voice = buffers.get(anchor);
        if (!voice) {
            return;
        }
        // Start early by the sample's own rise time so the note is *heard* on
        // the beat rather than just beginning there — otherwise every attack
        // trails the click, which reads as the click rushing (pianoSampler:
        // detectAttackLagSec). Never schedule into the past.
        const at = Math.max(ctx.currentTime, startAt - voice.attackLagSec);
        const source = ctx.createBufferSource();
        source.buffer = voice.buffer;
        source.playbackRate.value = playbackRateFor(midi, anchor);
        const gain = ctx.createGain();
        // Perceptual curve: linear gain flattens dynamics — squaring-ish the
        // velocity makes pp genuinely whisper and ff genuinely ring.
        const gainValue = Math.pow(velocity, 1.6);
        gain.gain.value = gainValue;
        source.connect(gain);
        gain.connect(bus);

        // The whole envelope shifts with the attack, so note lengths stay exact.
        const endAt = at + Math.max(0.05, durationSec);
        gain.gain.setValueAtTime(gainValue, endAt);
        gain.gain.setTargetAtTime(0, endAt, RELEASE_TAU_S);
        // Start from the measured onset so no codec padding is heard —
        // decoded mp3s carry ~50 ms of it at the front.
        source.start(at, voice.onsetSec);
        source.stop(endAt + RELEASE_STOP_S);

        const entry: ActiveNote = { source, gain };
        this.active.add(entry);
        source.onended = () => {
            this.active.delete(entry);
            gain.disconnect();
        };
    }

    private scheduleClick(at: number, accent: boolean): void {
        const ctx = this.ctx;
        const clickBus = this.clickBus;
        if (!ctx || !clickBus) {
            return;
        }
        const osc = ctx.createOscillator();
        osc.frequency.value = accent ? 1800 : 1300;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.gain.setValueAtTime(accent ? 0.9 : 0.6, at);
        gain.gain.setTargetAtTime(0, at + 0.012, 0.015);
        osc.connect(gain);
        gain.connect(clickBus);
        osc.start(at);
        osc.stop(at + 0.09);
    }

    private cancelActiveNotes(): void {
        const now = this.ctx?.currentTime ?? 0;
        for (const { source, gain } of this.active) {
            gain.gain.setTargetAtTime(0, now, 0.02); // declick
            try {
                source.stop(now + 0.08);
            } catch {
                // never started / already stopped
            }
        }
        this.active.clear();
    }
}
