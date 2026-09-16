import { printedBarCountFromMeasures } from '../symbolic/signals.js';
import type { ScoreData } from '../scoreData.js';

/**
 * Corpus-promotion gate.
 *
 * A bulk mirror sometimes hands us a file that is not the work it is filed
 * under, and no metadata says so: the Internet Archive `imslp` item for Piano
 * Sonata No.23, Op.57 is a one-page organ transcription of the Andante, filed
 * with the work's own title, creator, date and "For piano" subject. The engine
 * happily transcribes it, so the only place left to notice is the transcription
 * itself.
 *
 * This gate decides whether an analysis may become a `playalong_corpus` row that
 * other users are served. It NEVER affects the analysis the requesting user
 * gets: a rejected score is still written to `score_analyses` and still plays.
 */

export type CorpusGateReason = 'staves' | 'bars';

export interface CorpusGateVerdict {
    promoted: boolean;
    reason?: CorpusGateReason;
}

/** Editions of one movement whose bar counts may differ by at most this factor. */
const BAR_COUNT_TOLERANCE = 2;

const PASS: CorpusGateVerdict = { promoted: true };

const staffBandCounts = (score: ScoreData): number[] =>
    score.systems.map((system) => system.staves?.length ?? 0).filter((count) => count > 0);

/**
 * Does the engraving look like the two-staff keyboard score Cleffy plays?
 *
 * Measured on the seeded corpus: every Mutopia piano score reports exactly two
 * staff bands on every system, the IA organ transcription reports one to three,
 * the IA string-quintet cello part reports one, and the OpenScore string quartet
 * reports four. `single_staff_all_rh` is the parser's own word for a score with
 * nothing to put in the left hand.
 */
const looksLikeKeyboard = (score: ScoreData): boolean => {
    if (score.warnings.includes('single_staff_all_rh')) {
        return false;
    }
    const counts = staffBandCounts(score);
    // v1-v4 payloads carry no staff bands at all; nothing to judge, so pass.
    return counts.length === 0 || counts.every((count) => count === 2);
};

/**
 * Decide whether this analysis may be promoted to the corpus.
 *
 * `siblingPrintedBars` are bar counts already in the corpus for the same
 * movement from other editions; pass an empty list when none are known.
 */
export const corpusGate = (input: {
    tier: 'symbolic' | 'omr';
    score: ScoreData;
    siblingPrintedBars?: readonly number[];
}): CorpusGateVerdict => {
    // A symbolic accept already proved itself: the candidate's own meter, key and
    // opening matched, and its bars aligned onto this PDF's printed bar boxes.
    if (input.tier === 'symbolic') {
        return PASS;
    }
    if (!looksLikeKeyboard(input.score)) {
        return { promoted: false, reason: 'staves' };
    }
    const bars = printedBarCountFromMeasures(input.score.measures);
    const siblings = (input.siblingPrintedBars ?? []).filter((n) => Number.isFinite(n) && n > 0);
    if (bars > 0 && siblings.length > 0) {
        const agrees = siblings.some(
            (sibling) => bars <= sibling * BAR_COUNT_TOLERANCE && sibling <= bars * BAR_COUNT_TOLERANCE,
        );
        if (!agrees) {
            return { promoted: false, reason: 'bars' };
        }
    }
    return PASS;
};

/** Ledger `last_error` for a row the gate held back, e.g. `needs_review:staves`. */
export const needsReviewError = (reason: CorpusGateReason): string => `needs_review:${reason}`;
