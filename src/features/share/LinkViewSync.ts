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
 * #98's mergeAnnotations, by maxharris1). Writes run one at a time, so a
 * tombstone always sees the copy written before it. Each pull reports the
 * score's content_rev, so a PDF replaced while the viewer was away is noticed.
 */
export class LinkViewSync {
    private maxSeq = 0;
    private readonly tombstones = new Map<string, number>();
    private pulling: Promise<void> | null = null;
    private pullAgain = false;
    private stopped = false;
    private writing: Promise<void> = Promise.resolve();

    constructor(
        private readonly deps: {
            client: TypedSupabaseClient;
            store: AnnotationStore;
            onContentRev?: (contentRev: number) => void;
        },
    ) {}

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
            this.deps.onContentRev?.(data.doc.content_rev);
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
        const write = this.writing.then(() => this.writeMarks(marks));
        this.writing = write.catch(() => undefined);
        try {
            await write;
        } catch (err) {
            if (!this.stopped) {
                throw err;
            }
        }
    }

    private async writeMarks(marks: readonly LinkViewMark[]): Promise<void> {
        if (this.stopped) {
            return;
        }
        const { store } = this.deps;
        await store.load();
        const remotes = new Map<string, Annotation>();
        for (const mark of marks) {
            const known = remotes.get(mark.id) ?? store.get(mark.id);
            if (mark.deleted) {
                this.tombstones.set(mark.id, Math.max(mark.seq, this.tombstones.get(mark.id) ?? 0));
                if (known && known.seq < mark.seq) {
                    remotes.set(mark.id, { ...known, deletedAt: new Date().toISOString(), seq: mark.seq });
                }
                continue;
            }
            if ((this.tombstones.get(mark.id) ?? -1) >= mark.seq || (known && known.seq >= mark.seq)) {
                continue;
            }
            remotes.set(mark.id, {
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
        if (remotes.size > 0) {
            await store.applyRemoteBatch([...remotes.values()], NO_PENDING);
        }
    }
}
