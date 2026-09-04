import type { OmrGeometry, OmrSheet, OmrStack, OmrSystem } from '../../omrGeometry.js';

/**
 * Cheap geometry is an OmrGeometry (so buildScoreData accepts it unchanged)
 * whose stacks additionally carry the detected chord-column x positions —
 * the raw material for `sl` once the LLM tells us how many onsets a bar has.
 */
export interface CheapStack extends OmrStack {
    /** Page-normalised x of ink columns inside the bar (notes and rests), ascending. */
    columns: number[];
}

export interface CheapSystem extends OmrSystem {
    stacks: CheapStack[];
}

export interface CheapSheet extends OmrSheet {
    systems: CheapSystem[];
}

export interface CheapGeometry extends OmrGeometry {
    sheets: CheapSheet[];
    source: 'cv' | 'audiveris-grid';
    timings: { renderMs: number; detectMs: number; totalMs: number };
}
