import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

import { pagePointToViewport } from '@/features/viewer/geometry';
import type { PageLayout } from '@/features/viewer/geometry';
import type { TextIntent } from '@/features/viewer/ink/InkController';
import { SYSTEM_FONT_FAMILY } from '@/features/import/textFit';
import {
    hardWrapText,
    TEXT_LINE_HEIGHT,
    textDrawSpec,
    textForEditor,
    textWrapEm,
} from '@/features/viewer/ink/musicFont';
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
    /** Height (CSS px) covered at the viewer's bottom (toolbar, floating controls), which the editor stays above. */
    bottomInset?: number;
    /** Also keep clear of the safe-area inset (floating controls sit above it). */
    bottomInsetSafe?: boolean;
    /**
     * Commit the edit. Empty text on an existing note deletes it. `at` is set
     * when the editor sat away from the note's point (moved in from an edge).
     */
    onCommit: (text: string, at?: { nx: number; ny: number }) => void;
    onCancel: () => void;
}

/** Gap (CSS px) the editor keeps from the viewer's right and bottom edges. */
const VIEWPORT_MARGIN = 8;
/** The textarea's p-1 padding plus its 1px border, both sides. */
const BOX_EXTRA = 10;
/** Smallest font (CSS px) the editor lays text out at; smaller notes are scaled down from it. */
const MIN_EDITOR_FONT = 10;
/** Narrowest the editor gets (CSS px) before it moves left instead of shrinking. */
const MIN_EDITOR_WIDTH = 160;
/** Shortest the editor gets (CSS px) before it moves up instead of shrinking. */
const MIN_EDITOR_HEIGHT = 48;

/** Inline textarea positioned at the tapped point of a page. */
export const TextEditorOverlay = ({
    intent,
    layout,
    view,
    store,
    viewportWidth = Infinity,
    viewportHeight = Infinity,
    bottomInset = 0,
    bottomInsetSafe = false,
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

    const size = existingPayload ? existingPayload.size : 0.018;
    const fontPx = size * layout.width * view.scale;
    // Lay out at no less than MIN_EDITOR_FONT and scale the box down to the
    // drawn size, so the editor breaks lines exactly where the note will.
    const editorFont = Math.max(MIN_EDITOR_FONT, fontPx);
    const k = fontPx / editorFont;
    const spec = styledPayload ? textDrawSpec(styledPayload.text, styledPayload.hw === 1, styledPayload) : null;
    const proseFace = spec && !spec.music ? spec : null;

    // The box sits back by its padding and border, so the typed glyphs start
    // where the committed note will draw them. Sizes below are on screen.
    const anchor = pagePointToViewport(view, layout, nx, ny);
    const anchorLeft = anchor.x - (BOX_EXTRA / 2) * k;
    const anchorTop = anchor.y - (BOX_EXTRA / 2) * k;
    let left = anchorLeft;
    let top = anchorTop;
    // As wide as the committed note may run (up to the page's right edge, see
    // textNoteLines), so the text wraps where it will be drawn — but never
    // past the viewer, where typing would scroll the score sideways. When
    // that leaves too little room (zoomed in, tapped near the edge), the box
    // moves left rather than becoming a sliver.
    const wantWidth = textWrapEm({ x: nx, size }) * fontPx + BOX_EXTRA * k;
    let width = wantWidth;
    if (Number.isFinite(viewportWidth)) {
        const room = viewportWidth - VIEWPORT_MARGIN - left;
        if (room < width) {
            const minWidth = Math.min(width, MIN_EDITOR_WIDTH, viewportWidth - 2 * VIEWPORT_MARGIN);
            width = Math.max(room, minWidth);
            left = Math.max(VIEWPORT_MARGIN, Math.min(left, viewportWidth - VIEWPORT_MARGIN - width));
        }
    }
    // Grow down to the bottom toolbar / controls, not under them.
    let maxHeight: string | undefined;
    if (Number.isFinite(viewportHeight)) {
        const bottom = viewportHeight - bottomInset - VIEWPORT_MARGIN;
        top = Math.max(0, Math.min(top, bottom - MIN_EDITOR_HEIGHT));
        const safe = bottomInsetSafe ? ' - var(--safe-bottom)' : '';
        maxHeight = `max(${MIN_EDITOR_HEIGHT / k}px, calc((${bottom - top}px${safe}) / ${k}))`;
    }

    // Zoomed in near an edge the box is narrower than the note's page room,
    // or moved: commit what was typed where it was typed, with the box's line
    // breaks, rather than rewrapping it at the page edge off to the right.
    const commit = (value: string) => {
        // Narrower than the page room at the note's point, or moved left into
        // more of it: either way the page would wrap it wider than the box.
        const narrowed = width < wantWidth - 0.5 || left < anchorLeft - 0.5;
        const moved = Math.abs(left - anchorLeft) > 0.5 || Math.abs(top - anchorTop) > 0.5;
        const original = existingPayload ? textForEditor(existingPayload.text) : '';
        if ((!narrowed && !moved) || value === original || value.trim() === '') {
            onCommit(value);
            return;
        }
        // The inverse of pagePointToViewport, at the box's text origin.
        const at = {
            nx: ((view.scrollX + left + (BOX_EXTRA / 2) * k) / view.scale - layout.left) / layout.width,
            ny: ((view.scrollY + top + (BOX_EXTRA / 2) * k) / view.scale - layout.top) / layout.height,
        };
        const boxEm = (width - BOX_EXTRA * k) / fontPx;
        const prose = {
            font: proseFace ? styledPayload?.font : undefined,
            bold: styledPayload?.bold,
            italic: styledPayload?.italic,
        };
        const wrapped = hardWrapText({ x: at.nx, y: at.ny, size, text: value.trim(), ...prose }, boxEm);
        onCommit(narrowed ? wrapped : value, at);
    };

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
                width: width / k,
                maxHeight,
                fontSize: editorFont,
                transform: k < 1 ? `scale(${k})` : undefined,
                transformOrigin: 'top left',
                lineHeight: TEXT_LINE_HEIGHT,
                // The face the note is drawn in, so the editor wraps like the page.
                fontFamily: proseFace?.family ?? SYSTEM_FONT_FAMILY,
                fontStyle: proseFace?.style,
                fontWeight: proseFace?.weight,
            }}
            onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commit(e.currentTarget.value);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    onCancel();
                }
                e.stopPropagation();
            }}
            onInput={(e) => fitHeight(e.currentTarget)}
            onBlur={(e) => commit(e.currentTarget.value)}
            onPointerDown={(e) => e.stopPropagation()}
        />
    );
};
