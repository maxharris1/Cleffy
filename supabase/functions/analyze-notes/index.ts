import { serveMeteredAnalysis } from '../_shared/analyzeScaffold.ts';

/**
 * AI fingering vision read over a score's engraved notes. Metered as
 * `vision_reads`, sharing one monthly budget with analyze-annotations — free
 * tier gets 5, paid tiers 500 as a silent fair-use ceiling.
 *
 * The gate is live; the analysis itself is not implemented yet (see
 * _shared/analyzeScaffold.ts).
 */
serveMeteredAnalysis('analyze-notes');
