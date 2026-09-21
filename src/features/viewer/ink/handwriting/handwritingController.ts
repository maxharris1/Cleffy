import {
    MAX_MUSIC_TEXT_SIZE,
    measureInkText,
    SYSTEM_FONT_FAMILY,
    textPayloadForInk,
    type FontSpec,
} from '@/features/import/textFit';
import { convertGroupToText } from '@/features/viewer/ink/handwriting/convert';
import {
    groupBboxNormalized,
    groupStrokeIds,
    HandwritingGrouper,
    type GrouperOptions,
    type StrokeGroup,
} from '@/features/viewer/ink/handwriting/grouper';
import { splitDigitRun, splitMixedLine } from '@/features/viewer/ink/handwriting/recognizer';
import type { TranscribeInkFn } from '@/features/viewer/ink/handwriting/transcribeApi';
import type { Recognition, Recognizer } from '@/features/viewer/ink/handwriting/types';
import { ensureMusicFontLoaded, isMusicFontReady, textDrawSpec } from '@/features/viewer/ink/musicFont';
import type { AnnotationStore } from '@/sync/annotationStore';
import { isTextPayload, type Annotation } from '@/types/models';

export interface HandwritingControllerOptions {
    store: AnnotationStore;
    /** On-device closed-set reader (digits, dynamics, marks). */
    recognizer: Recognizer;
    /**
     * Metered text-note transcription. Tried for a writing line the on-device
     * reader refused, including each letter run peeled off a mixed
     * digit+letter line. Never for a digit or symbol, and never given the
     * digit strokes of a mixed line. Absent for local documents and for
     * non-owners; resolves null offline.
     */
    transcribe?: TranscribeInkFn;
    /** The writer's opt-in (read at commit AND at convert time). */
    isEnabled: () => boolean;
    /** Page height / page width for a page index (null when unknown). */
    getAspect: (pageIndex: number) => number | null;
    /** Timer injection for tests. */
    schedule?: GrouperOptions['schedule'];
    cancel?: GrouperOptions['cancel'];
}

/**
 * Font the print is measured in — the same choice the renderer makes for an
 * `hw` payload, so the sized text lands where the ink was. Music-font
 * symbols do not wait for Bravura: the canvas already draws a system-ui
 * fallback and repaints on `onMusicFontReady`. Print-on warmup loads the
 * face in the background so the first `f`/`mf` usually measures the real
 * metrics.
 */
export const fontForRecognition = (recognition: Recognition): { font: FontSpec; text: string; music: boolean } => {
    const spec = textDrawSpec(recognition.text, true);
    if (spec.music) {
        if (isMusicFontReady()) {
            return { font: { family: spec.family, style: spec.style }, text: spec.glyphs, music: true };
        }
        void ensureMusicFontLoaded();
        // Match the canvas fallback: system-ui italic of the ASCII spelling.
        return { font: { family: SYSTEM_FONT_FAMILY, style: 'italic' }, text: recognition.text, music: false };
    }
    return { font: { family: spec.family, style: spec.style }, text: spec.glyphs, music: false };
};

/**
 * Writer-side handwriting → print pipeline: feeds the local InkController's
 * committed strokes into the grouper, reads each flushed group with the
 * recognizer, and swaps confident groups for print in one undo batch.
 *
 * Only strokes committed by THIS controller's writer arrive here — remote ink
 * is never converted on this device. Highlighter is never a candidate.
 */
export class HandwritingController {
    private readonly grouper: HandwritingGrouper;
    private readonly unsubscribe: () => void;
    private readonly inflight = new Set<Promise<void>>();
    private disposed = false;

    constructor(private readonly opts: HandwritingControllerOptions) {
        this.grouper = new HandwritingGrouper({
            onFlush: (group) => {
                const task = this.handleGroup(group).finally(() => this.inflight.delete(task));
                this.inflight.add(task);
            },
            schedule: opts.schedule,
            cancel: opts.cancel,
        });
        // A pending stroke that disappears (eraser, undo, peer delete) must
        // not convert — watch the store rather than only the eraser path.
        this.unsubscribe = opts.store.subscribe(() => this.dropErased());
    }

    /** Called by the InkController right after it commits a stroke. */
    onStrokeCommitted(annotation: Annotation): void {
        if (this.disposed || annotation.kind !== 'stroke' || isTextPayload(annotation.payload)) {
            return;
        }
        if (!this.opts.isEnabled()) {
            return;
        }
        const aspect = this.opts.getAspect(annotation.page);
        if (aspect === null) {
            return;
        }
        this.grouper.add(
            {
                id: annotation.id,
                page: annotation.page,
                color: annotation.color,
                pts: annotation.payload.pts,
                w: annotation.payload.w,
                at: Date.now(),
            },
            aspect,
        );
    }

    /** Ids still waiting for a pause (tests). */
    pendingIds(): string[] {
        return this.grouper.pendingIds();
    }

    /** Force the pending group out now (tests / tool switch). */
    flush(): void {
        this.grouper.flush();
    }

    /** Resolves once every flushed group has been read and converted or dropped. */
    async settle(): Promise<void> {
        while (this.inflight.size > 0) {
            await Promise.all([...this.inflight]);
        }
    }

    dispose(): void {
        this.disposed = true;
        this.unsubscribe();
        this.grouper.dispose();
    }

    private dropErased(): void {
        for (const id of this.grouper.pendingIds()) {
            const live = this.opts.store.get(id);
            if (!live || live.deletedAt) {
                this.grouper.remove(id);
            }
        }
    }

    private async handleGroup(group: StrokeGroup): Promise<void> {
        if (this.disposed || !this.opts.isEnabled()) {
            return;
        }
        let recognition: Recognition | null;
        try {
            recognition = await this.opts.recognizer(group);
            if (!recognition && group.kind === 'line') {
                const digits = splitDigitRun(group);
                if (digits) {
                    for (const piece of digits) {
                        await this.handleGroup(piece);
                    }
                    return;
                }
                // A digit anywhere on the line used to leave the whole line as
                // ink. Peel each digit off for on-device `$P` and keep each
                // letter run as its own object (lexicon on device, otherwise
                // one transcription). Digits are not in the letter groups.
                const mixed = splitMixedLine(group);
                if (mixed) {
                    for (const piece of mixed) {
                        await this.handleGroup(piece);
                    }
                    return;
                }
                if (this.opts.transcribe && this.opts.isEnabled()) {
                    const text = await this.opts.transcribe(group);
                    recognition = text ? { text, kind: 'text' } : null;
                }
            }
        } catch (err) {
            console.warn('Handwriting recognition failed; ink stays', err);
            return;
        }
        if (!recognition || recognition.text.trim() === '') {
            return;
        }
        // The pause may have outlived the setting or the strokes themselves.
        if (this.disposed || !this.opts.isEnabled()) {
            return;
        }
        for (const id of groupStrokeIds(group)) {
            const live = this.opts.store.get(id);
            if (!live || live.deletedAt) {
                return;
            }
        }
        const text = recognition.text.trim();
        const measured = fontForRecognition({ ...recognition, text });
        if (this.disposed || !this.opts.isEnabled()) {
            return;
        }
        for (const id of groupStrokeIds(group)) {
            const live = this.opts.store.get(id);
            if (!live || live.deletedAt) {
                return;
            }
        }
        const metrics = measureInkText(measured.text, measured.font);
        const payload = textPayloadForInk(groupBboxNormalized(group), text, group.aspect, metrics, {
            fitWidth: group.kind === 'line',
            hw: 1,
            maxSize: measured.music ? MAX_MUSIC_TEXT_SIZE : undefined,
        });
        await convertGroupToText(this.opts.store, group, payload);
    }
}
