import '@/index.css';

import { createRoot } from 'react-dom/client';

import { Toolbar } from '@/features/viewer/toolbar/Toolbar';
import { useRecordPointerKinds } from '@/features/viewer/useRecordPointerKinds';
import type { AnnotationStore } from '@/sync/annotationStore';
import { useViewerStore } from '@/state/store';

declare global {
    interface Window {
        invoked: string[];
        viewerState: () => { tool: string | null; fingerDraws: boolean; touchSeen: boolean };
    }
}

window.invoked = [];
window.viewerState = () => {
    const { tool, fingerDraws, touchSeen } = useViewerStore.getState();
    return { tool, fingerDraws, touchSeen };
};

const store = {
    canUndo: true,
    canRedo: true,
    subscribeMeta: () => () => undefined,
    undoLast: () => {
        window.invoked.push('Undo');
        return Promise.resolve();
    },
    redoLast: () => {
        window.invoked.push('Redo');
        return Promise.resolve();
    },
} as unknown as AnnotationStore;

export const Fixture = () => {
    useRecordPointerKinds();
    return (
        <div className="relative h-screen">
            <button type="button" className="absolute left-4 top-1/2" onClick={() => window.invoked.push('Outside')}>
                Outside
            </button>
            <Toolbar store={store} />
        </div>
    );
};

createRoot(document.getElementById('root')!).render(<Fixture />);
