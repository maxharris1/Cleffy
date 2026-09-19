import { measureInkText, SYSTEM_FONT_FAMILY, textPayloadForInk, type FontSpec } from '@/features/import/textFit';
import { convertGroupToText } from '@/features/viewer/ink/handwriting/convert';
import {
    groupBboxNormalized,
    groupStrokeIds,
    HandwritingGrouper,
    type GrouperOptions,
    type StrokeGroup,
} from '@/features/viewer/ink/handwriting/grouper';
import type { TranscribeInkFn } from '@/features/viewer/ink/handwriting/transcribeApi';
import type { Recognition, Recognizer } from '@/features/viewer/ink/handwriting/types';
import type { AnnotationStore } from '@/sync/annotationStore';
import { isTextPayload, type Annotation } from '@/types/models';

export interface HandwritingControllerOptions {
    store: AnnotationStore;
    /** On-device closed-set reader (digits, dynamics, marks). */
    recognizer: Recognizer;
    /**
     * Metered text-note transcription, tried ONLY for a writing line the
     * on-device reader refused — never for a lone digit or symbol. Absent for
     * local documents; resolves null offline.
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

/** Font the print is measured and drawn in, by what was recognized. */
export const fontForRecognition = (recognition: Recognition): FontSpec =>
    recognition.kind === 'symbol' ? { family: SYSTEM_FONT_FAMILY, style: 'italic' } : { family: SYSTEM_FONT_FAMILY };

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
            if (!recognition && group.kind === 'line' && this.opts.transcribe && this.opts.isEnabled()) {
                const text = await this.opts.transcribe(group);
                recognition = text ? { text, kind: 'text' } : null;
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
        const metrics = measureInkText(text, fontForRecognition(recognition));
        const payload = textPayloadForInk(groupBboxNormalized(group), text, group.aspect, metrics, {
            fitWidth: group.kind === 'line',
            hw: 1,
        });
        await convertGroupToText(this.opts.store, group, payload);
    }
}
