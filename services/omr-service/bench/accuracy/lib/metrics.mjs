/**
 * Accuracy metrics between a ground-truth transcript and an engine transcript.
 *
 * Transcript = { notes: [{ t, d, p, h }], measures: [{ tick, dTicks }] } with
 * ticks at 480/quarter (the service's MusicalScore shape).
 *
 * Two note-level views are reported:
 *  - `aligned`: measures are first aligned (Needleman–Wunsch on pitch-set
 *    similarity) so one dropped or hallucinated bar does not zero out the rest
 *    of the piece; notes are then matched inside aligned bar pairs by
 *    (hand, pitch, onset-in-bar ± tol). This is "how many notes are right".
 *  - `global`: notes matched on absolute tick ± tol with no alignment. This is
 *    "what the user hears when the playhead runs straight through" — every
 *    rhythm slip before a bar shifts everything after it.
 */

export const DEFAULT_TOL_TICKS = 120; // a 16th at 480/quarter

const GAP = -0.35;
const EMPTY_EMPTY = 0.5;

const pitchBag = (notes) => {
    const bag = new Map();
    for (const n of notes) {
        bag.set(n.p, (bag.get(n.p) ?? 0) + 1);
    }
    return bag;
};

const dice = (a, b) => {
    let inter = 0;
    let total = 0;
    for (const [p, c] of a) {
        total += c;
        inter += Math.min(c, b.get(p) ?? 0);
    }
    for (const [, c] of b) {
        total += c;
    }
    if (total === 0) {
        return EMPTY_EMPTY;
    }
    return (2 * inter) / total;
};

/** Notes grouped per measure, onset made relative to the bar start. */
const bucketByMeasure = (transcript) => {
    const buckets = transcript.measures.map(() => []);
    const starts = transcript.measures.map((m) => m.tick);
    for (const n of transcript.notes) {
        // measures are sorted by tick; binary search the containing bar
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= n.t) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        if (buckets[lo]) {
            buckets[lo].push({ ...n, rel: n.t - starts[lo] });
        }
    }
    return buckets;
};

/** Needleman–Wunsch over measures; returns pairs [gtIndex, engIndex] plus unmatched lists. */
export const alignMeasures = (gt, eng) => {
    const gtB = bucketByMeasure(gt).map(pitchBag);
    const enB = bucketByMeasure(eng).map(pitchBag);
    const n = gtB.length;
    const m = enB.length;
    if (n === 0 || m === 0) {
        return { pairs: [], gtOnly: [...gtB.keys()], engOnly: [...enB.keys()] };
    }
    if (n === m) {
        // Same bar count: the natural pairing is what the client would do.
        return { pairs: gtB.map((_, i) => [i, i]), gtOnly: [], engOnly: [] };
    }
    const score = new Float32Array((n + 1) * (m + 1));
    const move = new Uint8Array((n + 1) * (m + 1)); // 0 diag, 1 up (gt gap), 2 left (eng gap)
    const idx = (i, j) => i * (m + 1) + j;
    for (let i = 1; i <= n; i++) {
        score[idx(i, 0)] = i * GAP;
        move[idx(i, 0)] = 1;
    }
    for (let j = 1; j <= m; j++) {
        score[idx(0, j)] = j * GAP;
        move[idx(0, j)] = 2;
    }
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const d = score[idx(i - 1, j - 1)] + dice(gtB[i - 1], enB[j - 1]);
            const u = score[idx(i - 1, j)] + GAP;
            const l = score[idx(i, j - 1)] + GAP;
            let best = d;
            let mv = 0;
            if (u > best) {
                best = u;
                mv = 1;
            }
            if (l > best) {
                best = l;
                mv = 2;
            }
            score[idx(i, j)] = best;
            move[idx(i, j)] = mv;
        }
    }
    const pairs = [];
    const gtOnly = [];
    const engOnly = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        const mv = move[idx(i, j)];
        if (i > 0 && j > 0 && mv === 0) {
            pairs.push([i - 1, j - 1]);
            i--;
            j--;
        } else if (i > 0 && (j === 0 || mv === 1)) {
            gtOnly.push(i - 1);
            i--;
        } else {
            engOnly.push(j - 1);
            j--;
        }
    }
    pairs.reverse();
    gtOnly.reverse();
    engOnly.reverse();
    return { pairs, gtOnly, engOnly };
};

/**
 * Greedy one-to-one matching: for every GT note pick the closest unmatched
 * engine note with equal pitch (and hand unless ignoreHand) within tol.
 */
const matchNotes = (gtNotes, engNotes, key, tol, ignoreHand) => {
    const pool = new Map();
    for (const [i, n] of engNotes.entries()) {
        const k = ignoreHand ? `${n.p}` : `${n.h}:${n.p}`;
        if (!pool.has(k)) {
            pool.set(k, []);
        }
        pool.get(k).push(i);
    }
    const used = new Uint8Array(engNotes.length);
    const matches = [];
    const sorted = [...gtNotes.entries()].sort((a, b) => a[1][key] - b[1][key]);
    for (const [gi, g] of sorted) {
        const k = ignoreHand ? `${g.p}` : `${g.h}:${g.p}`;
        const cands = pool.get(k);
        if (!cands) {
            continue;
        }
        let best = -1;
        let bestD = Infinity;
        for (const ei of cands) {
            if (used[ei]) {
                continue;
            }
            const d = Math.abs(engNotes[ei][key] - g[key]);
            if (d <= tol && d < bestD) {
                bestD = d;
                best = ei;
            }
        }
        if (best >= 0) {
            used[best] = 1;
            matches.push({ gi, ei: best, dt: engNotes[best][key] - g[key], dd: engNotes[best].d - g.d });
        }
    }
    return matches;
};

const prf = (tp, gtCount, engCount) => {
    const precision = engCount === 0 ? 0 : tp / engCount;
    const recall = gtCount === 0 ? 0 : tp / gtCount;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { tp, gt: gtCount, eng: engCount, precision: round(precision), recall: round(recall), f1: round(f1) };
};

const round = (x, digits = 4) => (Number.isFinite(x) ? Number(x.toFixed(digits)) : null);

const median = (xs) => {
    if (xs.length === 0) {
        return null;
    }
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export const compareTranscripts = (gt, eng, options = {}) => {
    const tol = options.tolTicks ?? DEFAULT_TOL_TICKS;
    const alignment = alignMeasures(gt, eng);
    const gtBuckets = bucketByMeasure(gt);
    const engBuckets = bucketByMeasure(eng);

    let tpStrict = 0;
    let tpAnyHand = 0;
    const onsetErrs = [];
    const durOk = [];
    let barsExact = 0;
    let barsOver = 0;
    let barsUnder = 0;
    let engNotesInAligned = 0;
    let gtNotesInAligned = 0;
    for (const [gi, ei] of alignment.pairs) {
        const g = gtBuckets[gi];
        const e = engBuckets[ei];
        gtNotesInAligned += g.length;
        engNotesInAligned += e.length;
        const strict = matchNotes(g, e, 'rel', tol, false);
        tpStrict += strict.length;
        tpAnyHand += matchNotes(g, e, 'rel', tol, true).length;
        for (const m of strict) {
            onsetErrs.push(Math.abs(m.dt));
            durOk.push(Math.abs(m.dd) <= tol ? 1 : 0);
        }
        const gd = gt.measures[gi].dTicks;
        const ed = eng.measures[ei].dTicks;
        if (ed === gd) {
            barsExact++;
        } else if (ed > gd) {
            barsOver++;
        } else {
            barsUnder++;
        }
    }
    // Unaligned bars count fully against precision/recall.
    const gtTotal = gt.notes.length;
    const engTotal = eng.notes.length;

    const global = matchNotes(gt.notes, eng.notes, 't', tol, false);
    const globalAnyHand = matchNotes(gt.notes, eng.notes, 't', tol, true);

    return {
        tolTicks: tol,
        aligned: {
            ...prf(tpStrict, gtTotal, engTotal),
            anyHandF1: prf(tpAnyHand, gtTotal, engTotal).f1,
            onsetAbsMeanTicks: round(mean(onsetErrs), 1),
            onsetAbsMedianTicks: round(median(onsetErrs), 1),
            durationAccuracy: round(mean(durOk)),
        },
        global: {
            ...prf(global.length, gtTotal, engTotal),
            anyHandF1: prf(globalAnyHand.length, gtTotal, engTotal).f1,
        },
        measures: {
            gt: gt.measures.length,
            eng: eng.measures.length,
            aligned: alignment.pairs.length,
            gtOnly: alignment.gtOnly.length,
            engOnly: alignment.engOnly.length,
            exactDuration: barsExact,
            overfull: barsOver,
            underfull: barsUnder,
            countMatch: gt.measures.length === eng.measures.length,
        },
        totalTicks: { gt: gt.totalTicks ?? null, eng: eng.totalTicks ?? null },
    };
};

/**
 * Geometry: engine boxes vs reference boxes (both page-normalised
 * { page, x0, x1, y0, y1 }). A reference bar is "found" when an engine bar on
 * the same page contains its vertical centre and the two x-ranges overlap; the
 * quality of the find is the 1-D x IoU (what the playhead needs). System bands
 * differ by convention between producers, so y is only used for pairing.
 */
export const compareGeometry = (engineBoxes, referenceBoxes) => {
    if (!referenceBoxes || referenceBoxes.length === 0 || !engineBoxes || engineBoxes.length === 0) {
        return null;
    }
    const byPage = new Map();
    for (const [i, b] of engineBoxes.entries()) {
        if (b.page < 0 || b.sys < 0) {
            continue;
        }
        if (!byPage.has(b.page)) {
            byPage.set(b.page, []);
        }
        byPage.get(b.page).push({ ...b, i });
    }
    const used = new Set();
    const ious = [];
    let found = 0;
    for (const ref of referenceBoxes) {
        const cands = byPage.get(ref.page) ?? [];
        const yc = (ref.y0 + ref.y1) / 2;
        let best = null;
        let bestIou = 0;
        for (const c of cands) {
            if (used.has(c.i)) {
                continue;
            }
            const cyc = (c.y0 + c.y1) / 2;
            const vertical = (yc >= c.y0 && yc <= c.y1) || (cyc >= ref.y0 && cyc <= ref.y1);
            if (!vertical) {
                continue;
            }
            const inter = Math.max(0, Math.min(ref.x1, c.x1) - Math.max(ref.x0, c.x0));
            const union = Math.max(ref.x1, c.x1) - Math.min(ref.x0, c.x0);
            const iou = union > 0 ? inter / union : 0;
            if (iou > bestIou) {
                bestIou = iou;
                best = c;
            }
        }
        if (best && bestIou > 0) {
            used.add(best.i);
            found++;
            ious.push(bestIou);
        }
    }
    const engPlaced = engineBoxes.filter((b) => b.page >= 0 && b.sys >= 0).length;
    return {
        referenceBars: referenceBoxes.length,
        engineBarsPlaced: engPlaced,
        engineBarsTotal: engineBoxes.length,
        found,
        recall: round(found / referenceBoxes.length),
        precision: round(engPlaced === 0 ? 0 : found / engPlaced),
        meanXIou: round(mean(ious)),
        shareXIouOver08: round(ious.length === 0 ? 0 : ious.filter((x) => x >= 0.8).length / referenceBoxes.length),
        pagesRef: new Set(referenceBoxes.map((b) => b.page)).size,
        pagesEng: byPage.size,
    };
};

/** ScoreData measures+systems → flat page-normalised boxes for compareGeometry. */
export const scoreDataBoxes = (scoreData) =>
    scoreData.measures.map((m) => {
        const sys = m.sys >= 0 ? scoreData.systems[m.sys] : null;
        return {
            page: sys ? sys.page : -1,
            sys: m.sys,
            x0: m.x0,
            x1: m.x1,
            y0: sys ? sys.y0 : 0,
            y1: sys ? sys.y1 : 0,
            slots: m.sl?.length ?? 0,
        };
    });
