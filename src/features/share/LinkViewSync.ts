import type { TypedSupabaseClient } from '@/lib/supabase';
import type { AnnotationStore } from '@/sync/annotationStore';
import { parseLinkViewMark, type LinkViewMark } from '@/sync/wire';
import type { Annotation, AnnotationPayload } from '@/types/models';

const PAGE_LIMIT = 500;
const NO_PENDING: ReadonlySet<string> = new Set();

/**
 * Keeps a link viewer's in-memory store in step with the score: pulls
 * link_view_snapshot pages and applies the doc-view `mark` events. It takes
 * the sync engine's place for a viewer, who never writes.
 *
 * The watermark moves only on pulls, so a live mark heard ahead of one it
 * missed never makes the next pull skip the gap. A tombstone for a mark not
 * seen yet is remembered, so an older copy arriving later stays erased (PR
 * #98's mergeAnnotations, by maxharris1).
 */
export class LinkViewSync {
    private maxSeq = 0;
    private readonly tombstones = new Map<string, number>();
    private pulling: Promise<void> | null = null;
    private pullAgain = false;
    private stopped = false;

    constructor(private readonly deps: { client: TypedSupabaseClient; store: AnnotationStore }) {}

    pull(): Promise<void> {
        if (this.pulling) {
            this.pullAgain = true;
            return this.pulling;
        }
        this.pulling = this.pullAll().finally(() => {
            this.pulling = null;
            if (this.pullAgain) {
                this.pullAgain = false;
                void this.pull();
            }
        });
        return this.pulling;
    }

    applyMark(mark: LinkViewMark): Promise<void> {
        return this.applyMarks([mark]);
    }

    /** The viewer is closing and its database with it: whatever is still in flight is dropped. */
    stop(): void {
        this.stopped = true;
    }

    private async pullAll(): Promise<void> {
        for (;;) {
            const { data, error } = await this.deps.client.rpc('link_view_snapshot', {
                p_since: this.maxSeq,
                p_limit: PAGE_LIMIT,
            });
            if (error || !data || this.stopped) {
                return;
            }
            const marks = data.marks.map(parseLinkViewMark).filter((m): m is LinkViewMark => m !== null);
            await this.applyMarks(marks);
            this.maxSeq = Math.max(this.maxSeq, data.max_seq);
            if (!data.more) {
                return;
            }
        }
    }

    private async applyMarks(marks: readonly LinkViewMark[]): Promise<void> {
        if (this.stopped) {
            return;
        }
        try {
            await this.writeMarks(marks);
        } catch (err) {
            if (!this.stopped) {
                throw err;
            }
        }
    }

    private async writeMarks(marks: readonly LinkViewMark[]): Promise<void> {
        const { store } = this.deps;
        const remotes: Annotation[] = [];
        for (const mark of marks) {
            if (mark.deleted) {
                this.tombstones.set(mark.id, Math.max(mark.seq, this.tombstones.get(mark.id) ?? 0));
                const known = store.get(mark.id);
                if (known && known.seq < mark.seq) {
                    remotes.push({ ...known, deletedAt: new Date().toISOString(), seq: mark.seq });
                }
                continue;
            }
            if ((this.tombstones.get(mark.id) ?? -1) >= mark.seq) {
                continue;
            }
            remotes.push({
                id: mark.id,
                docId: store.docId,
                page: mark.page,
                kind: mark.kind,
                color: mark.color,
                payload: mark.payload as unknown as AnnotationPayload,
                createdBy: null,
                createdAt: '',
                updatedAt: '',
                deletedAt: null,
                seq: mark.seq,
            });
        }
        if (remotes.length > 0) {
            await store.applyRemoteBatch(remotes, NO_PENDING);
        }
    }
}
