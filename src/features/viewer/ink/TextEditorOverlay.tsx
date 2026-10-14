import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

import { pagePointToViewport } from '@/features/viewer/geometry';
import type { PageLayout } from '@/features/viewer/geometry';
import type { TextIntent } from '@/features/viewer/ink/InkController';
import { SYSTEM_FONT_FAMILY } from '@/features/import/textFit';
import { TEXT_LINE_HEIGHT, textDrawSpec, textForEditor, textWrapEm } from '@/features/viewer/ink/musicFont';
import type { AnnotationStore } from '@/sync/annotationStore';
import { isTextPayload, MAX_TEXT_NOTE_CHARS } from '@/types/models';
import type { ViewState } from '@/types/models';

export interface TextEditorOverlayProps {
    intent: TextIntent;
    layout: PageLayout;
    view: ViewState;
    store: AnnotationStore;
    /** The viewer's size (CSS px), which the editor never runs past (unbounded when omitted). */
    viewportWidth?: number;
    viewportHeight?: number;
    /** Commit the edit. Empty text on an existing note deletes it. */
    onCommit: (text: string) => void;
    onCancel: () => void;
}

/** Gap (CSS px) the editor keeps from the viewer's right and bottom edges. */
const VIEWPORT_MARGIN = 8;
/** The textarea's p-1 padding plus its 1px border, both sides. */
const BOX_EXTRA = 10;

/** Inline textarea positioned at the tapped point of a page. */
export const TextEditorOverlay = ({
    intent,
    layout,
    view,
    store,
    viewportWidth = Infinity,
    viewportHeight = Infinity,
    onCommit,
    onCancel,
}: TextEditorOverlayProps) => {
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

    // The box sits back by its padding and border, so the typed glyphs start
    // where the committed note will draw them.
    const anchor = pagePointToViewport(view, layout, nx, ny);
    const left = anchor.x - BOX_EXTRA / 2;
    const top = anchor.y - BOX_EXTRA / 2;
    const size = existingPayload ? existingPayload.size : 0.018;
    const fontPx = size * layout.width * view.scale;
    const spec = styledPayload ? textDrawSpec(styledPayload.text, styledPayload.hw === 1, styledPayload) : null;
    const proseFace = spec && !spec.music ? spec : null;
    // As wide as the committed note may run (up to the page's right edge, see
    // textNoteLines), so the text wraps where it will be drawn — but never
    // past the viewer, where typing would scroll the score sideways.
    const wrapPx = textWrapEm({ x: nx, size }) * fontPx;
    const width = Math.max(48, Math.min(wrapPx + BOX_EXTRA, viewportWidth - VIEWPORT_MARGIN - left));
    const maxHeight = Number.isFinite(viewportHeight)
        ? Math.max(48, viewportHeight - VIEWPORT_MARGIN - top)
        : undefined;

    // Grow with the text instead of scrolling it inside a fixed two rows.
    const fitHeight = (el: HTMLTextAreaElement) => {
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    };
    useLayoutEffect(() => {
        if (ref.current) {
            fitHeight(ref.current);
        }
    }, [width, fontPx, proseFace?.family]);

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
            // The server's cap; a longer note would be refused and rolled back.
            maxLength={MAX_TEXT_NOTE_CHARS}
            rows={1}
            className="absolute z-30 resize-none overflow-y-auto rounded border border-accent bg-white/95 p-1 shadow-md outline-none"
            style={{
                left,
                top,
                width,
                maxHeight,
                fontSize: Math.max(10, fontPx),
                lineHeight: TEXT_LINE_HEIGHT,
                // The face the note is drawn in, so the editor wraps like the page.
                fontFamily: proseFace?.family ?? SYSTEM_FONT_FAMILY,
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
            onInput={(e) => fitHeight(e.currentTarget)}
            onBlur={(e) => onCommit(e.currentTarget.value)}
            onPointerDown={(e) => e.stopPropagation()}
        />
    );
};
