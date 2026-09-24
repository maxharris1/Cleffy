import { imslpFilesToCandidates, type ImslpHarvestedFile } from './imslp.js';
import { lookupMutopia, type MutopiaPiece } from './mutopia.js';
import { sourcePriority, type RankedCandidate, type WorkKey } from './types.js';

export interface DiscoverInput {
    workKey: WorkKey;
    /** IMSLP page title, used to stamp candidate workKeys. */
    imslpPageTitle?: string;
    mutopiaIndex: readonly MutopiaPiece[];
    imslpFiles: readonly ImslpHarvestedFile[];
    userXml?: RankedCandidate;
}

const byPriority = (a: RankedCandidate, b: RankedCandidate): number => {
    if (a.priority !== b.priority) {
        return a.priority - b.priority;
    }
    return a.url.localeCompare(b.url);
};

/**
 * Ranked symbolic candidates. No ingest. Performance MIDI is never auto-loaded
 * here (that check needs bytes; harvest already dropped audio / arrangements).
 */
export const discoverCandidates = (input: DiscoverInput): RankedCandidate[] => {
    const mutopia = lookupMutopia(input.mutopiaIndex, input.workKey);
    const imslp = imslpFilesToCandidates(
        input.imslpFiles,
        input.imslpPageTitle ?? '',
        input.workKey,
    );
    const user: RankedCandidate[] = [];
    if (input.userXml) {
        user.push({
            ...input.userXml,
            source: 'user',
            priority: sourcePriority('user', input.userXml.format),
        });
    }
    const merged = [...mutopia, ...imslp, ...user];
    const seen = new Set<string>();
    const out: RankedCandidate[] = [];
    for (const cand of merged.sort(byPriority)) {
        if (seen.has(cand.url)) {
            continue;
        }
        seen.add(cand.url);
        out.push(cand);
    }
    return out;
};
