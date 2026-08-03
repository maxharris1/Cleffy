import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import type { PlaybackEngine } from '@/features/playback/PlaybackEngine';
import { TransportBar } from '@/features/playback/TransportBar';
import type { TransportBarProps } from '@/features/playback/TransportBar';
import { useViewerStore } from '@/state/store';

const makeEngine = () => {
    return {
        play: vi.fn(async () => {}),
        pause: vi.fn(),
        stop: vi.fn(),
        seek: vi.fn(),
        getPositionTicks: vi.fn(() => 0),
    } as unknown as PlaybackEngine;
};

const renderBar = (overrides: Partial<TransportBarProps> = {}) => {
    const engine = makeEngine();
    const props: TransportBarProps = {
        state: { kind: 'ready', score: tinyScore, bpmDefault: 90, bpmOverride: null },
        role: 'owner',
        onGenerate: vi.fn(),
        getEngine: () => engine,
        pageCount: 2,
        warning: null,
        onDismissWarning: vi.fn(),
        ...overrides,
    };
    const utils = render(<TransportBar {...props} />);
    return { engine, props, ...utils };
};

beforeEach(() => {
    act(() => useViewerStore.getState().resetPlayback());
});

afterEach(cleanup);

const setStore = (mutate: () => void) => act(mutate);

describe('TransportBar states', () => {
    it('renders nothing when unavailable', () => {
        const { container } = renderBar({ state: { kind: 'unavailable' } });
        expect(container).toBeEmptyDOMElement();
    });

    it('offers Generate to owners, passive text to viewers', async () => {
        const onGenerate = vi.fn();
        renderBar({ state: { kind: 'none' }, onGenerate });
        await userEvent.click(screen.getByRole('button', { name: /generate play-along/i }));
        expect(onGenerate).toHaveBeenCalled();

        renderBar({ state: { kind: 'none' }, role: 'viewer' });
        expect(screen.getByText(/no play-along for this score yet/i)).toBeInTheDocument();
        expect(screen.queryAllByRole('button', { name: /generate/i })).toHaveLength(1); // only the owner's
    });

    it('shows analysis progress', () => {
        renderBar({ state: { kind: 'processing', progress: 2 } });
        expect(screen.getByRole('status')).toHaveTextContent('Analyzing score… 2 / 2 pages');
    });

    it('maps failure codes to friendly copy with Retry for editors only', () => {
        renderBar({ state: { kind: 'failed', code: 'no_staves_found' }, role: 'editor' });
        expect(screen.getByText(/couldn't find readable music/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();

        renderBar({ state: { kind: 'failed', code: 'queue_full' }, role: 'viewer' });
        expect(screen.getByText(/busy/i)).toBeInTheDocument();
        expect(screen.queryAllByRole('button', { name: /retry/i })).toHaveLength(1);
    });
});

describe('TransportBar ready controls', () => {
    it('play uses count-in preference; pause when already running', async () => {
        const { engine } = renderBar();
        await userEvent.click(screen.getByRole('button', { name: 'Play' }));
        expect(engine.play).toHaveBeenCalledWith({ countIn: true });

        setStore(() => {
            useViewerStore.getState().setCountInOn(false);
            useViewerStore.getState().setPlaybackStatus('playing');
        });
        await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
        expect(engine.pause).toHaveBeenCalled();
    });

    it('stop and measure steppers hit the engine', async () => {
        const { engine } = renderBar();
        await userEvent.click(screen.getByRole('button', { name: /stop and rewind/i }));
        expect(engine.stop).toHaveBeenCalled();
        await userEvent.click(screen.getByRole('button', { name: /next measure/i }));
        expect(engine.seek).toHaveBeenCalledWith(480); // m0 → m1 barline
    });

    it('shows the printed measure number and total', () => {
        setStore(() => useViewerStore.getState().setCurrentMeasureIndex(5));
        renderBar();
        expect(screen.getByText('m. 5 / 8')).toBeInTheDocument();
    });

    it('bpm stepper clamps into range and updates the store', async () => {
        renderBar();
        setStore(() => useViewerStore.getState().setBpm(45));
        await userEvent.click(screen.getByRole('button', { name: 'Slower' }));
        expect(useViewerStore.getState().bpm).toBe(40);
        await userEvent.click(screen.getByRole('button', { name: 'Slower' }));
        expect(useViewerStore.getState().bpm).toBe(40); // clamped at BPM_MIN
    });

    it('hand mutes toggle store state with aria-pressed', async () => {
        renderBar();
        const lh = screen.getByRole('button', { name: /mute left hand/i });
        expect(lh).toHaveAttribute('aria-pressed', 'false');
        await userEvent.click(lh);
        expect(useViewerStore.getState().muteLH).toBe(true);
        expect(screen.getByRole('button', { name: /mute left hand/i })).toHaveAttribute('aria-pressed', 'true');
    });

    it('disables the left hand for single-staff scores', () => {
        const rhOnly = { ...tinyScore, notes: tinyScore.notes.filter((n) => n.h === 0) };
        renderBar({ state: { kind: 'ready', score: rhOnly, bpmDefault: null, bpmOverride: null } });
        expect(screen.getByRole('button', { name: /mute left hand/i })).toBeDisabled();
    });

    it('arms and sets the A-B loop from the current measure', async () => {
        setStore(() => useViewerStore.getState().setCurrentMeasureIndex(2));
        renderBar();
        const loop = screen.getByRole('button', { name: /set loop start/i });
        await userEvent.click(loop);
        setStore(() => useViewerStore.getState().setCurrentMeasureIndex(4));
        await userEvent.click(screen.getByRole('button', { name: /set loop end/i }));
        expect(useViewerStore.getState().loopRange).toEqual({ a: 2, b: 4 });
        await userEvent.click(screen.getByRole('button', { name: /clear practice loop/i }));
        expect(useViewerStore.getState().loopRange).toBeNull();
    });

    it('shows the dotted-quarter equivalent for compound meters', () => {
        setStore(() => useViewerStore.getState().setBpm(90));
        const compound = { ...tinyScore, timeSignatures: [{ tick: 0, num: 6, den: 8 }] };
        renderBar({ state: { kind: 'ready', score: compound, bpmDefault: null, bpmOverride: null } });
        expect(screen.getByText(/♩· = 60/)).toBeInTheDocument();

        cleanup();
        renderBar(); // 4/4 score — quarter display only
        expect(screen.queryByText(/♩· =/)).not.toBeInTheDocument();
    });

    it('surfaces the resume-follow affordance when following is suspended', async () => {
        setStore(() => useViewerStore.getState().setFollowMode('suspended'));
        renderBar();
        const resume = screen.getByRole('button', { name: /resume auto-follow/i });
        await userEvent.click(resume);
        expect(useViewerStore.getState().followMode).toBe('on');
    });
});
