import { useEffect, useRef, useSyncExternalStore } from 'react';

import { pagePointToViewport } from '@/features/viewer/geometry';
import type { PageLayout } from '@/features/viewer/geometry';
import type { TextIntent } from '@/features/viewer/ink/InkController';
import { textDrawSpec, textForEditor } from '@/features/viewer/ink/musicFont';
import type { AnnotationStore } from '@/sync/annotationStore';
import { isTextPayload } from '@/types/models';
import type { ViewState } from '@/types/models';

export interface TextEditorOverlayProps {
    intent: TextIntent;
    layout: PageLayout;
    view: ViewState;
    store: AnnotationStore;
    /** Commit the edit. Empty text on an existing note deletes it. */
    onCommit: (text: string) => void;
    onCancel: () => void;
}

/** Inline textarea positioned at the tapped point of a page. */
export const TextEditorOverlay = ({ intent, layout, view, store, onCommit, onCancel }: TextEditorOverlayProps) => {
    const ref = useRef<HTMLTextAreaElement | null>(null);

    const existingPayload = intent.existing && isTextPayload(intent.existing.payload) ? intent.existing.payload : null;
    const livePayload = useSyncExternalStore(
        (cb) => store.subscribe(() => cb()),
        () => {
            if (!intent.existing) {
                return null;
            }
            const row = store.get(intent.existing.id);
            return row && isTextPayload(row.payload) ? row.payload : null;
        },
    );
    const styledPayload = livePayload ?? existingPayload;
    const nx = existingPayload ? existingPayload.x : intent.nx;
    const ny = existingPayload ? existingPayload.y : intent.ny;

    const { x: left, y: top } = pagePointToViewport(view, layout, nx, ny);
    const fontPx = (existingPayload ? existingPayload.size : 0.018) * layout.width * view.scale;
    const spec = styledPayload ? textDrawSpec(styledPayload.text, styledPayload.hw === 1, styledPayload) : null;
    const proseFace = spec && !spec.music ? spec : null;

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
            defaultValue={existingPayload ? textForEditor(existingPayload.text) : ''}
            aria-label="Text note"
            rows={2}
            className="absolute z-30 min-w-32 resize rounded border border-accent bg-white/95 p-1 shadow-md outline-none"
            style={{
                left,
                top,
                fontSize: Math.max(10, fontPx),
                lineHeight: 1.25,
                fontFamily: proseFace?.family,
                fontStyle: proseFace?.style,
                fontWeight: proseFace?.weight,
            }}
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
