import { serveMeteredAnalysis } from '../_shared/analyzeScaffold.ts';

/**
 * Play-along (OMR) analysis of a score. Metered as `omr_runs` — free tier gets 3
 * per calendar month, paid tiers are unlimited.
 *
 * The gate is live; the analysis itself is not implemented yet (see
 * _shared/analyzeScaffold.ts).
 */
serveMeteredAnalysis('score-analyze');
