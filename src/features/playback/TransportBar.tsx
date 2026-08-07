import { useState } from 'react';

import type { PlaybackEngine } from '@/features/playback/PlaybackEngine';
import { stepMeasure, timeSigAt } from '@/features/playback/scoreTime';
import { analysisIsStale } from '@/features/playback/scoreAnalysisService';
import type { ScoreAnalysisState } from '@/features/playback/useScoreAnalysis';
import { BPM_MAX, BPM_MIN, useViewerStore } from '@/state/store';
import type { MemberRole } from '@/types/database';
import { hasLeftHand, tempoIsInferred } from '@/types/scoreData';
import type { ScoreData } from '@/types/scoreData';
import {
    ChevronDownIcon,
    ChevronLeftIcon,
    ChevronRightIcon,
    ChevronUpIcon,
    CloseIcon,
    FollowIcon,
    HourglassIcon,
    MetronomeIcon,
    MusicIcon,
    PauseIcon,
    PlayIcon,
    RepeatIcon,
    RetryIcon,
    SkipBackIcon,
    Volume2Icon,
    VolumeXIcon,
} from '@/ui/icons';

export interface TransportBarProps {
    state: ScoreAnalysisState;
    role: MemberRole | null;
    onGenerate: () => void;
    getEngine: () => PlaybackEngine | null;
    pageCount: number | null;
    warning: string | null;
    onDismissWarning: () => void;
}

const ERROR_COPY: Record<string, string> = {
    too_large: 'This score is too long to analyze (60-page limit).',
    page_count_unknown: 'Page count is missing — reopen the score so we can measure it, then try Generate again.',
    no_staves_found: "Couldn't find readable music in this PDF.",
    omr_timeout: 'Analysis took too long and was stopped.',
    omr_crash: 'The music-recognition engine crashed on this score.',
    musicxml_parse_failed: 'The recognized music could not be converted.',
    queue_full: 'The analysis service is busy — try again in a few minutes.',
    backlog_full: 'You already have several scores analyzing — try Generate again shortly.',
    service_unreachable: 'The analysis service is not reachable right now.',
    download_failed: 'The PDF could not be fetched for analysis.',
    worker_lost: 'The analysis was interrupted and will retry automatically.',
    stale: 'The analysis was interrupted.',
    internal: 'Something went wrong during analysis.',
};

const WARNING_COPY: Record<string, string> = {
    samples_unavailable: 'Piano sounds could not be loaded — check your connection and press play again.',
    too_many_voices: 'Very dense passage: some notes were skipped to protect audio performance.',
};

/**
 * What the analysis had to give up on, in the reader's terms rather than ours.
 * These are facts about the score, not transient errors, so they persist rather
 * than being dismissible — a student who loses their place needs to be able to
 * find out it was the software and not their reading.
 *
 * Ordered by how badly each one can mislead someone following the page.
 */
const SCORE_WARNING_COPY: Array<{ code: string; text: string }> = [
    {
        code: 'repeats_ignored',
        text: 'Repeats are played straight through once. First and second endings will both be played, in order.',
    },
    {
        code: 'meter_corrected',
        text: 'A time signature looked misread and was corrected to match the bars. If the beat feels wrong, this is why.',
    },
    {
        code: 'meter_suspect',
        text: "Some bars don't match their time signature. Rhythms in that section may be off.",
    },
    {
        code: 'measure_overfull',
        text: 'Some bars came out longer than their time signature — usually a misread rhythm.',
    },
    {
        code: 'measure_underfull',
        text: 'Some bars came out short and were padded, so notes there may fall early.',
    },
    {
        code: 'multiple_movements_concatenated',
        text: 'The pieces in this file play back to back as one, so bar numbers restart partway through.',
    },
    {
        code: 'multi_part_collapsed',
        text: 'This score has more parts than two hands — only the main one is played.',
    },
    { code: 'single_staff_all_rh', text: 'Only one staff was found, so everything plays as the right hand.' },
    {
        code: 'dynamics_not_staff_split',
        text: 'Dynamics could not be told apart between the hands, so both play at the same volume.',
    },
    { code: 'grace_notes_skipped', text: 'Some grace notes had nothing to attach to and were left out.' },
    { code: 'no_geometry', text: 'The page positions could not be read, so there is no moving playhead.' },
    {
        code: 'measure_geometry_mismatch',
        text: 'Bars stopped lining up with the page partway through; the playhead hides there.',
    },
];

/**
 * Offer a re-run when the stored analysis predates the current engine. Nothing
 * else in the system ever re-analyzes a document, so without this every fix
 * lands only on scores uploaded afterwards.
 */
const StaleAnalysisNotice = (props: { engineVersion: string | null; canManage: boolean; onGenerate: () => void }) => {
    if (!props.canManage || !analysisIsStale(props.engineVersion)) {
        return null;
    }
    return (
        <div className="rounded-lg border border-amber-300/70 bg-amber-50/80 px-3 py-1.5 text-xs text-amber-900" role="status">
            This play-along was made by an older version of the analysis.{' '}
            <button
                type="button"
                onClick={props.onGenerate}
                className="font-medium underline underline-offset-2"
            >
                Regenerate it
            </button>{' '}
            to pick up the improvements.
        </div>
    );
};

/** Persistent, collapsed disclosure of what the analysis could not do. */
const ScoreWarnings = (props: { warnings: readonly string[] }) => {
    const [open, setOpen] = useState(false);
    const present = SCORE_WARNING_COPY.filter((entry) => props.warnings.includes(entry.code));
    if (present.length === 0) {
        return null;
    }
    return (
        <div className="rounded-lg border border-amber-300/70 bg-amber-50/80 px-3 py-1.5" role="status">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-amber-900"
            >
                {open ? <ChevronDownIcon size={13} /> : <ChevronUpIcon size={13} />}
                {present.length === 1 ? '1 thing to know about this play-along' : `${present.length} things to know about this play-along`}
            </button>
            {open ? (
                <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-xs text-amber-900">
                    {present.map((entry) => (
                        <li key={entry.code}>{entry.text}</li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
};

/**
 * Docked play-along transport below the score. Playback is local to this
 * device, so every role gets it; only Generate/Retry are owner/editor-gated
 * (matching RLS). Practice tools: count-in, metronome, A-B loop, per-hand
 * mute + volume, auto-follow.
 */
export const TransportBar = (props: TransportBarProps) => {
    const { state } = props;
    if (state.kind === 'unavailable') {
        return null;
    }
    return (
        <div className="flex-none border-t border-stone-200 bg-white/95 px-2 pb-[max(var(--safe-bottom),0.375rem)] pt-1.5 sm:px-3">
            {state.kind === 'ready' ? <ReadyTransport {...props} score={state.score} /> : <StatusRow {...props} />}
        </div>
    );
};

const StatusRow = ({ state, role, onGenerate, pageCount }: TransportBarProps) => {
    const canManage = role === 'owner' || role === 'editor';
    if (state.kind === 'none') {
        return (
            <div className="flex min-h-9 items-center justify-center gap-3 text-sm text-stone-500">
                {canManage ? (
                    <button type="button" onClick={onGenerate} className={pillButton(false)}>
                        <MusicIcon size={16} />
                        Generate play-along
                    </button>
                ) : (
                    <span>No play-along for this score yet.</span>
                )}
            </div>
        );
    }
    if (state.kind === 'pending' || state.kind === 'processing') {
        const progress = state.kind === 'processing' ? state.progress : null;
        return (
            <div className="flex min-h-9 items-center justify-center gap-2 text-sm text-stone-500">
                <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" />
                <span role="status">
                    Analyzing score…
                    {progress !== null && progress > 0 ? ` ${progress}${pageCount ? ` / ${pageCount}` : ''} pages` : ''}
                </span>
            </div>
        );
    }
    // failed
    const code = state.kind === 'failed' ? state.code : 'internal';
    return (
        <div className="flex min-h-9 flex-wrap items-center justify-center gap-3 text-sm">
            <span className="text-stone-600">{ERROR_COPY[code] ?? ERROR_COPY['internal']}</span>
            {canManage ? (
                <button type="button" onClick={onGenerate} className={pillButton(false)}>
                    <RetryIcon size={14} />
                    Retry
                </button>
            ) : null}
        </div>
    );
};

const ReadyTransport = (props: TransportBarProps & { score: ScoreData }) => {
    const { score, getEngine, warning, onDismissWarning } = props;
    const playbackStatus = useViewerStore((s) => s.playbackStatus);
    const bpm = useViewerStore((s) => s.bpm);
    const currentMeasureIndex = useViewerStore((s) => s.currentMeasureIndex);
    const muteRH = useViewerStore((s) => s.muteRH);
    const muteLH = useViewerStore((s) => s.muteLH);
    const volRH = useViewerStore((s) => s.volRH);
    const volLH = useViewerStore((s) => s.volLH);
    const metronomeOn = useViewerStore((s) => s.metronomeOn);
    const countInOn = useViewerStore((s) => s.countInOn);
    const loopRange = useViewerStore((s) => s.loopRange);
    const followMode = useViewerStore((s) => s.followMode);
    const { setBpm, setHandMuted, setHandVolume, setMetronomeOn, setCountInOn, setLoopRange, setFollowMode } =
        useViewerStore.getState();

    const [expanded, setExpanded] = useState(false);

    const running = playbackStatus === 'playing' || playbackStatus === 'counting';
    const loading = playbackStatus === 'loading';
    const lhAvailable = hasLeftHand(score);
    const lastMeasure = score.measures[score.measures.length - 1];
    const lastIndex = score.measures.length - 1;

    const play = () => {
        const engine = getEngine();
        if (engine && !running) {
            void engine.play({ countIn: countInOn });
        }
    };

    const step = (direction: -1 | 1) => {
        const engine = getEngine();
        if (!engine) {
            return;
        }
        engine.seek(stepMeasure(score.measures, engine.getPositionTicks(), direction));
    };

    /**
     * One button, one meaning: the loop is either on or off. Switching it on
     * lays a visible four-bar range over the score starting where you are —
     * a real loop you can hear immediately — and the range editor below tunes
     * the ends. No arming, no hidden half-set state.
     */
    const toggleLoop = () => {
        if (loopRange) {
            setLoopRange(null);
            return;
        }
        const a = Math.min(lastIndex, Math.max(0, currentMeasureIndex ?? 0));
        setLoopRange({ a, b: Math.min(lastIndex, a + DEFAULT_LOOP_BARS - 1) });
    };

    const moveLoopEdge = (edge: 'a' | 'b', to: number) => {
        if (!loopRange) {
            return;
        }
        const clamped = Math.min(lastIndex, Math.max(0, to));
        const next =
            edge === 'a'
                ? { a: clamped, b: Math.max(clamped, loopRange.b) }
                : { a: Math.min(clamped, loopRange.a), b: clamped };
        setLoopRange(next);
    };

    const measureLabel = (index: number | null) => {
        const measure = index !== null ? score.measures[index] : undefined;
        return measure ? `${measure.n}` : '–';
    };

    const currentTick = score.measures[currentMeasureIndex ?? 0]?.tick ?? 0;
    const sig = timeSigAt(score.timeSignatures, currentTick);

    return (
        <div className="flex flex-col gap-1">
            {warning ? (
                <div className="flex items-center justify-center gap-2 text-xs text-amber-700" role="status">
                    <span>{WARNING_COPY[warning] ?? warning}</span>
                    <button type="button" aria-label="Dismiss warning" onClick={onDismissWarning}>
                        <CloseIcon size={12} />
                    </button>
                </div>
            ) : null}

            <StaleAnalysisNotice
                engineVersion={props.state.kind === 'ready' ? props.state.engineVersion : null}
                canManage={props.role === 'owner' || props.role === 'editor'}
                onGenerate={props.onGenerate}
            />
            <ScoreWarnings warnings={score.warnings} />

            {loopRange ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-accent/30 bg-accent-soft/50 px-2 py-1">
                    <span className="flex items-center gap-1 text-xs font-medium text-accent">
                        <RepeatIcon size={13} />
                        Looping bars
                    </span>
                    <LoopEdge
                        edge="start"
                        label={measureLabel(loopRange.a)}
                        onNudge={(delta) => moveLoopEdge('a', loopRange.a + delta)}
                    />
                    <div className="flex items-center gap-1">
                        <span className="text-xs text-stone-500">to</span>
                        <LoopEdge
                            edge="end"
                            label={measureLabel(loopRange.b)}
                            onNudge={(delta) => moveLoopEdge('b', loopRange.b + delta)}
                        />
                    </div>
                    <button
                        type="button"
                        onClick={() => moveLoopEdge('a', currentMeasureIndex ?? 0)}
                        className="rounded-full px-2 py-0.5 text-xs text-stone-600 underline-offset-2 hover:bg-ink/5 hover:underline"
                    >
                        Start here
                    </button>
                    <button
                        type="button"
                        aria-label="Turn off the loop"
                        onClick={() => setLoopRange(null)}
                        className="ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-stone-600 hover:bg-ink/5"
                    >
                        <CloseIcon size={12} />
                        Turn off
                    </button>
                </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {/* Core transport — explicit rewind / play / pause, always visible */}
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        aria-label="Rewind to start"
                        title={loopRange ? 'Rewind to the start of the loop' : 'Rewind to the start'}
                        onClick={() => getEngine()?.stop()}
                        className={roundButton(false)}
                    >
                        <SkipBackIcon size={16} />
                    </button>
                    <button
                        type="button"
                        aria-label="Play"
                        title={countInOn ? 'Play (with count-in)' : 'Play'}
                        disabled={loading}
                        aria-pressed={running}
                        onClick={play}
                        className={roundButton(!running)}
                    >
                        <PlayIcon size={18} className="translate-x-[1px]" />
                    </button>
                    <button
                        type="button"
                        aria-label="Pause"
                        title="Pause"
                        aria-pressed={playbackStatus === 'paused'}
                        onClick={() => getEngine()?.pause()}
                        className={roundButton(running)}
                    >
                        <PauseIcon size={18} />
                    </button>
                </div>

                <div className="flex items-center gap-0.5">
                    <button
                        type="button"
                        aria-label="Previous measure"
                        onClick={() => step(-1)}
                        className={squareButton(false)}
                    >
                        <ChevronLeftIcon size={16} />
                    </button>
                    <span className="min-w-[4.5rem] text-center text-sm tabular-nums text-stone-700 sm:min-w-[5.5rem]">
                        m. {measureLabel(currentMeasureIndex)} / {lastMeasure ? lastMeasure.n : '–'}
                    </span>
                    <button
                        type="button"
                        aria-label="Next measure"
                        onClick={() => step(1)}
                        className={squareButton(false)}
                    >
                        <ChevronRightIcon size={16} />
                    </button>
                </div>

                <span
                    className="flex flex-col items-center px-1 text-[11px] font-semibold leading-[1.05] tabular-nums text-stone-600"
                    title="Time signature here"
                    aria-label={`Time signature ${sig.num}/${sig.den}`}
                >
                    <span>{sig.num}</span>
                    <span>{sig.den}</span>
                </span>

                <button
                    type="button"
                    aria-label={expanded ? 'Hide playback options' : 'Show playback options'}
                    aria-expanded={expanded}
                    onClick={() => setExpanded((v) => !v)}
                    className={`${squareButton(false)} ml-auto sm:hidden`}
                >
                    {expanded ? <ChevronDownIcon size={16} /> : <ChevronUpIcon size={16} />}
                </button>

                {/* Practice controls — collapsible on phones */}
                <div className={`${expanded ? 'flex' : 'hidden'} flex-wrap items-center gap-x-2 gap-y-1 sm:flex`}>
                    <TempoControl bpm={bpm} onBpm={setBpm} compound={isCompoundMeter(score)} inferred={tempoIsInferred(score)} />

                    <div className="mx-0.5 hidden h-6 w-px bg-stone-200 sm:block" />

                    <HandControl
                        label="RH"
                        fullLabel="right hand"
                        muted={muteRH}
                        volume={volRH}
                        disabled={false}
                        onMute={(muted) => setHandMuted(0, muted)}
                        onVolume={(volume) => setHandVolume(0, volume)}
                    />
                    <HandControl
                        label="LH"
                        fullLabel="left hand"
                        muted={muteLH}
                        volume={volLH}
                        disabled={!lhAvailable}
                        onMute={(muted) => setHandMuted(1, muted)}
                        onVolume={(volume) => setHandVolume(1, volume)}
                    />

                    <div className="mx-0.5 hidden h-6 w-px bg-stone-200 sm:block" />

                    <button
                        type="button"
                        aria-label="Count-in before playing"
                        aria-pressed={countInOn}
                        title="Count-in: one measure of clicks before playback"
                        onClick={() => setCountInOn(!countInOn)}
                        className={pillButton(countInOn)}
                    >
                        <HourglassIcon size={14} />
                        <span className="hidden md:inline">Count-in</span>
                    </button>
                    <button
                        type="button"
                        aria-label="Metronome"
                        aria-pressed={metronomeOn}
                        title="Metronome click during playback"
                        onClick={() => setMetronomeOn(!metronomeOn)}
                        className={pillButton(metronomeOn)}
                    >
                        <MetronomeIcon size={14} />
                        <span className="hidden md:inline">Click</span>
                    </button>
                    <button
                        type="button"
                        aria-label={loopRange ? 'Stop looping' : 'Loop a few bars'}
                        aria-pressed={loopRange !== null}
                        title="Repeat a range of bars over and over"
                        onClick={toggleLoop}
                        className={pillButton(loopRange !== null)}
                    >
                        <RepeatIcon size={14} />
                        <span className="hidden md:inline">
                            {loopRange ? `m. ${measureLabel(loopRange.a)}–${measureLabel(loopRange.b)}` : 'Loop'}
                        </span>
                    </button>
                    <button
                        type="button"
                        aria-label={followMode === 'suspended' ? 'Resume auto-follow' : 'Auto-follow the playhead'}
                        aria-pressed={followMode === 'on'}
                        title={
                            followMode === 'suspended'
                                ? 'Following paused (you scrolled) — tap to jump back to the playhead'
                                : 'Scroll along with the music'
                        }
                        onClick={() => setFollowMode(followMode === 'on' ? 'off' : 'on')}
                        className={pillButton(followMode === 'on', followMode === 'suspended')}
                    >
                        <FollowIcon size={14} />
                        <span className="hidden md:inline">{followMode === 'suspended' ? 'Re-follow' : 'Follow'}</span>
                    </button>
                </div>
            </div>
        </div>
    );
};

/** Bars a fresh loop covers — a short phrase you can hear round without editing. */
const DEFAULT_LOOP_BARS = 4;

const LoopEdge = ({
    edge,
    label,
    onNudge,
}: {
    edge: 'start' | 'end';
    label: string;
    onNudge: (delta: -1 | 1) => void;
}) => (
    <div className="flex items-center gap-0.5">
        <button
            type="button"
            aria-label={`Move loop ${edge} back one bar`}
            onClick={() => onNudge(-1)}
            className={stepperButton}
        >
            −
        </button>
        <span className="min-w-[3rem] text-center text-xs tabular-nums text-stone-700">m. {label}</span>
        <button
            type="button"
            aria-label={`Move loop ${edge} forward one bar`}
            onClick={() => onNudge(1)}
            className={stepperButton}
        >
            +
        </button>
    </div>
);

/**
 * Tempo to the nearest BPM: −/+ step by one, and the number itself is typable
 * for a big jump. The draft state lets "1…0…5" exist mid-keystroke without the
 * clamp snapping it to 40 on the way.
 */
const TempoControl = ({
    bpm,
    onBpm,
    compound,
    inferred,
}: {
    bpm: number;
    onBpm: (bpm: number) => void;
    compound: boolean;
    inferred: boolean;
}) => {
    const [draft, setDraft] = useState<string | null>(null);

    const commit = (text: string) => {
        const parsed = Number.parseInt(text, 10);
        if (Number.isFinite(parsed)) {
            onBpm(parsed);
        }
        setDraft(null);
    };

    return (
        <div
            className="flex items-center gap-0.5"
            title={
                inferred
                    ? 'Tempo (quarter note BPM) — estimated from the tempo marking, which prints no number'
                    : 'Tempo (quarter note BPM)'
            }
        >
            <span className="text-sm text-stone-500">♩=</span>
            <button type="button" aria-label="Slower" onClick={() => onBpm(bpm - 1)} className={squareButton(false)}>
                −
            </button>
            <input
                type="text"
                inputMode="numeric"
                aria-label="Tempo in beats per minute"
                min={BPM_MIN}
                max={BPM_MAX}
                value={draft ?? String(bpm)}
                onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={(e) => commit(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.currentTarget.blur();
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setDraft(null);
                        onBpm(bpm + 1);
                    } else if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setDraft(null);
                        onBpm(bpm - 1);
                    }
                }}
                className="w-11 rounded-md border border-stone-200 bg-white py-0.5 text-center text-sm tabular-nums text-stone-700 focus:border-accent focus:outline-none"
            />
            <button type="button" aria-label="Faster" onClick={() => onBpm(bpm + 1)} className={squareButton(false)}>
                +
            </button>
            {compound ? <span className="ml-0.5 text-xs text-stone-400">(♩· = {Math.round(bpm / 1.5)})</span> : null}
            {inferred ? (
                <span
                    className="ml-0.5 text-xs text-stone-400"
                    title="Estimated from the printed tempo marking, which gives no number"
                >
                    est.
                </span>
            ) : null}
        </div>
    );
};

const HandControl = ({
    label,
    fullLabel,
    muted,
    volume,
    disabled,
    onMute,
    onVolume,
}: {
    label: string;
    fullLabel: string;
    muted: boolean;
    volume: number;
    disabled: boolean;
    onMute: (muted: boolean) => void;
    onVolume: (volume: number) => void;
}) => (
    <div className="flex items-center gap-1">
        <button
            type="button"
            aria-label={`Mute ${fullLabel}`}
            aria-pressed={muted}
            disabled={disabled}
            title={disabled ? 'No left-hand staff detected in this score' : `Mute the ${fullLabel} to play it yourself`}
            onClick={() => onMute(!muted)}
            className={`${pillButton(muted)} disabled:opacity-40`}
        >
            {muted ? <VolumeXIcon size={14} /> : <Volume2Icon size={14} />}
            {label}
        </button>
        <input
            type="range"
            aria-label={`${fullLabel} volume`}
            min={0}
            max={100}
            value={Math.round(volume * 100)}
            disabled={disabled || muted}
            onChange={(e) => onVolume(Number(e.target.value) / 100)}
            className="hidden w-14 accent-accent lg:block"
        />
    </div>
);

/** 6/8, 9/8, 12/8… — musicians read those tempos in dotted-quarter beats. */
const isCompoundMeter = (score: ScoreData): boolean => {
    const sig = score.timeSignatures[0];
    return Boolean(sig && sig.den >= 8 && sig.num >= 6 && sig.num % 3 === 0);
};

const pillButton = (active: boolean, attention = false): string =>
    [
        'flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition',
        active
            ? 'border-accent bg-accent-soft text-accent'
            : attention
              ? 'border-amber-400 bg-amber-50 text-amber-800'
              : 'border-stone-200 text-stone-600 hover:bg-ink/5',
    ].join(' ');

const squareButton = (active: boolean): string =>
    [
        'flex h-8 w-8 items-center justify-center rounded-lg text-stone-600 transition',
        active ? 'bg-accent-soft text-accent' : 'hover:bg-ink/5',
    ].join(' ');

/**
 * Transport keys. `primary` marks the one that does the obvious next thing —
 * Play when stopped, Pause when running — so all three stay visible and
 * labelled while the useful one still reads at a glance.
 */
const roundButton = (primary: boolean): string =>
    [
        'flex h-10 w-10 items-center justify-center rounded-full transition disabled:animate-pulse',
        primary
            ? 'bg-accent text-white shadow-sm hover:opacity-90'
            : 'border border-stone-200 text-stone-600 hover:bg-ink/5',
    ].join(' ');

const stepperButton = 'flex h-6 w-6 items-center justify-center rounded-md text-stone-600 transition hover:bg-ink/10';
