import { useEffect, useRef } from 'react';

import type { PageLayout } from '@/features/viewer/geometry';
import type { TextIntent } from '@/features/viewer/ink/InkController';
import { isTextPayload } from '@/types/models';
import type { ViewState } from '@/types/models';

export interface TextEditorOverlayProps {
    intent: TextIntent;
    layout: PageLayout;
    view: ViewState;
    /** Commit the edit. Empty text on an existing note deletes it. */
    onCommit: (text: string) => void;
    onCancel: () => void;
}

/** Inline textarea positioned at the tapped point of a page. */
export const TextEditorOverlay = ({ intent, layout, view, onCommit, onCancel }: TextEditorOverlayProps) => {
    const ref = useRef<HTMLTextAreaElement | null>(null);

    const existingPayload = intent.existing && isTextPayload(intent.existing.payload) ? intent.existing.payload : null;
    const nx = existingPayload ? existingPayload.x : intent.nx;
    const ny = existingPayload ? existingPayload.y : intent.ny;

    const left = (layout.left + nx * layout.width) * view.scale - view.scrollX;
    const top = (layout.top + ny * layout.height) * view.scale - view.scrollY;
    const fontPx = (existingPayload ? existingPayload.size : 0.018) * layout.width * view.scale;

    useEffect(() => {
        const el = ref.current;
        if (el) {
            el.focus();
            el.select();
        }
    }, []);

    return (
        <textarea
            ref={ref}
            data-ui-overlay
            defaultValue={existingPayload?.text ?? ''}
            aria-label="Text note"
            rows={2}
            className="absolute z-30 min-w-32 resize rounded border border-indigo-400 bg-white/95 p-1 shadow-md outline-none"
            style={{ left, top, fontSize: Math.max(10, fontPx), lineHeight: 1.25 }}
            onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onCommit(e.currentTarget.value);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    onCancel();
                }
                e.stopPropagation();
            }}
            onBlur={(e) => onCommit(e.currentTarget.value)}
            onPointerDown={(e) => e.stopPropagation()}
        />
    );
};
