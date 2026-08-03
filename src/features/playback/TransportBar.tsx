import { useState } from 'react';

import type { PlaybackEngine } from '@/features/playback/PlaybackEngine';
import { stepMeasure } from '@/features/playback/scoreTime';
import type { ScoreAnalysisState } from '@/features/playback/useScoreAnalysis';
import { BPM_MAX, BPM_MIN, useViewerStore } from '@/state/store';
import type { MemberRole } from '@/types/database';
import { hasLeftHand } from '@/types/scoreData';
import type { ScoreData } from '@/types/scoreData';
import {
    ChevronDownIcon,
    ChevronLeftIcon,
    ChevronRightIcon,
    ChevronUpIcon,
    CloseIcon,
    FollowIcon,
    MetronomeIcon,
    MusicIcon,
    PauseIcon,
    PlayIcon,
    RepeatIcon,
    RetryIcon,
    SkipBackIcon,
    StopIcon,
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
    service_unreachable: 'The analysis service is not reachable right now.',
    download_failed: 'The PDF could not be fetched for analysis.',
    stale: 'The analysis was interrupted.',
    internal: 'Something went wrong during analysis.',
};

const WARNING_COPY: Record<string, string> = {
    samples_unavailable: 'Piano sounds could not be loaded — check your connection and press play again.',
    too_many_voices: 'Very dense passage: some notes were skipped to protect audio performance.',
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
    const {
        setBpm,
        setHandMuted,
        setHandVolume,
        setMetronomeOn,
        setCountInOn,
        setLoopRange,
        setFollowMode,
    } = useViewerStore.getState();

    const [expanded, setExpanded] = useState(false);
    const [loopArmedAt, setLoopArmedAt] = useState<number | null>(null);

    const running = playbackStatus === 'playing' || playbackStatus === 'counting';
    const loading = playbackStatus === 'loading';
    const lhAvailable = hasLeftHand(score);
    const lastMeasure = score.measures[score.measures.length - 1];

    const togglePlay = () => {
        const engine = getEngine();
        if (!engine) {
            return;
        }
        if (running) {
            engine.pause();
        } else {
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

    const toggleLoop = () => {
        if (loopRange) {
            setLoopRange(null);
            setLoopArmedAt(null);
            return;
        }
        const here = currentMeasureIndex ?? 0;
        if (loopArmedAt === null) {
            setLoopArmedAt(here);
        } else {
            setLoopRange({ a: Math.min(loopArmedAt, here), b: Math.max(loopArmedAt, here) });
            setLoopArmedAt(null);
        }
    };

    const measureLabel = (index: number | null) => {
        const measure = index !== null ? score.measures[index] : undefined;
        return measure ? `${measure.n}` : '–';
    };

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
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                {/* Core transport — always visible */}
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        aria-label={running ? 'Pause' : 'Play'}
                        title={running ? 'Pause' : countInOn ? 'Play (with count-in)' : 'Play'}
                        disabled={loading}
                        onClick={togglePlay}
                        className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-white shadow-sm transition hover:opacity-90 disabled:animate-pulse"
                    >
                        {running ? <PauseIcon size={18} /> : <PlayIcon size={18} className="translate-x-[1px]" />}
                    </button>
                    <button
                        type="button"
                        aria-label="Stop and rewind"
                        title="Stop and rewind"
                        onClick={() => getEngine()?.stop()}
                        className={squareButton(false)}
                    >
                        <StopIcon size={14} />
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
                    <span className="min-w-[5.5rem] text-center text-sm tabular-nums text-stone-700">
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

                <button
                    type="button"
                    aria-label={expanded ? 'Hide playback options' : 'Show playback options'}
                    aria-expanded={expanded}
                    onClick={() => setExpanded((v) => !v)}
                    className={`${squareButton(false)} sm:hidden`}
                >
                    {expanded ? <ChevronDownIcon size={16} /> : <ChevronUpIcon size={16} />}
                </button>

                {/* Practice controls — collapsible on phones */}
                <div className={`${expanded ? 'flex' : 'hidden'} flex-wrap items-center justify-center gap-x-2 gap-y-1 sm:flex`}>
                    <div className="flex items-center gap-0.5" title="Tempo (quarter note BPM)">
                        <button
                            type="button"
                            aria-label="Slower"
                            onClick={() => setBpm(bpm - 5)}
                            className={squareButton(false)}
                        >
                            −
                        </button>
                        <span className="min-w-[4.25rem] whitespace-nowrap text-center text-sm tabular-nums text-stone-700">
                            ♩= {bpm}
                            {isCompoundMeter(score) ? (
                                <span className="ml-1 text-xs text-stone-400">(♩· = {Math.round(bpm / 1.5)})</span>
                            ) : null}
                        </span>
                        <button
                            type="button"
                            aria-label="Faster"
                            onClick={() => setBpm(bpm + 5)}
                            className={squareButton(false)}
                        >
                            +
                        </button>
                        <input
                            type="range"
                            aria-label="Tempo"
                            min={BPM_MIN}
                            max={BPM_MAX}
                            value={bpm}
                            onChange={(e) => setBpm(Number(e.target.value))}
                            className="hidden w-24 accent-accent md:block"
                        />
                    </div>

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
                        <SkipBackIcon size={14} />
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
                        aria-label={
                            loopRange
                                ? 'Clear practice loop'
                                : loopArmedAt !== null
                                  ? 'Set loop end at the current measure'
                                  : 'Set loop start at the current measure'
                        }
                        aria-pressed={loopRange !== null || loopArmedAt !== null}
                        title="A-B loop: tap at the start measure, then at the end measure"
                        onClick={toggleLoop}
                        className={pillButton(loopRange !== null || loopArmedAt !== null)}
                    >
                        <RepeatIcon size={14} />
                        <span className="hidden md:inline">
                            {loopRange
                                ? `m. ${measureLabel(loopRange.a)}–${measureLabel(loopRange.b)}`
                                : loopArmedAt !== null
                                  ? `A: m. ${measureLabel(loopArmedAt)}…`
                                  : 'Loop'}
                        </span>
                        {loopRange ? <CloseIcon size={12} /> : null}
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
