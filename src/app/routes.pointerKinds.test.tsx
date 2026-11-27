import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from '@/app/routes';
import { useViewerStore } from '@/state/store';
import type { AnnotationStore } from '@/sync/annotationStore';
import { useViewport } from '@/test/touchLayout';

vi.mock('@/lib/supabase', () => ({
    isSupabaseConfigured: () => true,
}));

vi.mock('@/lib/webEvents', () => ({ track: vi.fn(), useTrackPageViews: () => undefined }));

vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: null, loading: false, lastEvent: null }),
    isRegisteredSession: () => false,
    userTypeOf: () => null,
    displayNameOf: () => '',
}));

const fakeStore = {
    canUndo: false,
    canRedo: false,
    subscribeMeta: () => () => undefined,
    undoLast: vi.fn(),
    redoLast: vi.fn(),
} as unknown as AnnotationStore;

vi.mock('@/features/demo/DemoViewer', async () => {
    const { Toolbar } = await import('@/features/viewer/toolbar/Toolbar');
    return { DemoViewer: () => <Toolbar store={fakeStore} /> };
});

const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF\n').buffer;

beforeEach(() => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(pdf.slice(0), { status: 200 })),
    );
    useViewerStore.setState({ penSeen: false, touchSeen: false, fingerDraws: false });
});

afterEach(() => {
    cleanup();
    useViewerStore.setState({ penSeen: false, touchSeen: false, fingerDraws: false });
    vi.unstubAllGlobals();
});

const pressTryItNow = async (pointerType: 'touch' | 'pen') => {
    render(
        <MemoryRouter initialEntries={['/']}>
            <AppRoutes />
        </MemoryRouter>,
    );
    const [tryItNow] = await screen.findAllByRole('link', { name: 'Try it now' });
    act(() => {
        tryItNow!.dispatchEvent(new PointerEvent('pointerdown', { pointerType, button: 0, bubbles: true }));
        tryItNow!.dispatchEvent(new PointerEvent('pointerup', { pointerType, button: 0, bubbles: true }));
    });
    fireEvent.click(tryItNow!);
    await screen.findByRole('button', { name: 'Pen' });
};

const fingerSwitch = () => screen.queryByRole('group', { name: 'What a finger does' });

describe('the first press of the session, made before the viewer mounts', () => {
    it('shows the finger switch after a touch on Try it now, on a fine-pointer device', async () => {
        useViewport({ width: 1280, coarse: false });
        await pressTryItNow('touch');
        expect(fingerSwitch()).toBeInTheDocument();
    });

    it('hides the finger switch after a pen on Try it now, on a coarse-pointer device', async () => {
        useViewport({ width: 1024, coarse: true });
        await pressTryItNow('pen');
        expect(useViewerStore.getState()).toMatchObject({ penSeen: true, touchSeen: false });
        expect(fingerSwitch()).toBeNull();
    });
});
