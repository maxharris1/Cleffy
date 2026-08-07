#!/usr/bin/env node
/**
 * Musicality metrics for a built ScoreData — the measurements that found the
 * bugs in the first place, made repeatable.
 *
 * Run it on Audiveris output:
 *   node scripts/score-metrics.mjs <dir-with-.mxl-and-.omr>
 * or on a stored analysis:
 *   node scripts/score-metrics.mjs --json path/to/scoredata.json
 *
 * The numbers that matter, and how to read them:
 *
 *   RH/LH velocity identity — the share of simultaneous two-hand onsets playing
 *   at the same volume. Read it TOGETHER with the `dynamics_not_staff_split`
 *   warning, never alone. A high rate with that warning present is the correct
 *   outcome, not a leak: it means the exporter did not tell the hands apart, so
 *   every mark was broadcast on purpose. Measured on Schubert D.780, Audiveris
 *   attributed 137 dynamics to staff 1 and 4 to staff 2, which is no attribution
 *   at all in practice, and the rate stayed at 92.7% — correctly. Only a high
 *   rate WITHOUT that warning is worth chasing. Below ~40% the sticky rule is
 *   leaking and the hands have been over-separated.
 *
 *   Distinct velocities — one value per printed dynamic level means no hairpin
 *   was interpolated. A shaped score should show dozens.
 *
 *   Bars matching their signature — low means either OMR rhythm damage or a
 *   misread meter; check the meter_corrected / meter_suspect warnings first.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TICKS_PER_QUARTER = 480;

const loadFromDir = async (dir) => {
    const { parseMxlFiles } = await import('../dist/musicxml.js');
    const { parseOmrGeometry } = await import('../dist/omrGeometry.js');
    const { buildScoreData } = await import('../dist/buildScoreData.js');

    const walk = (d, depth = 0) => {
        if (depth > 3) return [];
        return readdirSync(d, { withFileTypes: true }).flatMap((e) => {
            const full = join(d, e.name);
            return e.isDirectory() ? walk(full, depth + 1) : [full];
        });
    };
    const files = walk(dir);
    const mxl = files.filter((f) => f.toLowerCase().endsWith('.mxl')).sort();
    const omr = files.find((f) => f.toLowerCase().endsWith('.omr')) ?? null;
    if (mxl.length === 0) {
        throw new Error(`no .mxl under ${dir}`);
    }
    console.log(`# ${mxl.length} .mxl file(s), geometry: ${omr ? 'yes' : 'none'}`);
    const musical = parseMxlFiles(mxl.map((f) => readFileSync(f)));
    const geometry = omr ? parseOmrGeometry(readFileSync(omr)) : null;
    return buildScoreData(musical, geometry);
};

const pct = (n, d) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`);

const report = (score) => {
    const notes = score.notes;
    const rows = [];

    rows.push(['notes', notes.length]);
    rows.push(['measures', score.measures.length]);
    rows.push(['version', score.version]);
    rows.push(['warnings', JSON.stringify(score.warnings)]);

    // --- dynamics -----------------------------------------------------------
    // One vote per ONSET, not per note: a six-note chord against a single bass
    // note is one moment of two hands agreeing or disagreeing, and counting its
    // members separately would weight dense textures into the answer.
    const byTickHand = new Map();
    for (const n of notes) {
        const key = `${n.t}:${n.h}`;
        if (!byTickHand.has(key)) byTickHand.set(key, n.v);
    }
    let pairs = 0;
    let identical = 0;
    for (const tick of new Set(notes.map((n) => n.t))) {
        if (!byTickHand.has(`${tick}:0`) || !byTickHand.has(`${tick}:1`)) continue;
        pairs += 1;
        if (byTickHand.get(`${tick}:0`) === byTickHand.get(`${tick}:1`)) identical += 1;
    }
    rows.push(['simultaneous RH/LH onsets', pairs]);
    rows.push(['  sharing a velocity', `${identical} (${pct(identical, pairs)})`]);

    const velocities = new Set(notes.map((n) => n.v));
    rows.push(['distinct velocity values', velocities.size]);
    const soft = notes.filter((n) => (n.v ?? 0.75) <= 0.46).length;
    rows.push(['  notes at p or softer', pct(soft, notes.length)]);

    // --- articulation -------------------------------------------------------
    // Every notated value — including dotted ones and triplets — is a multiple
    // of 20 ticks, and multiplying by the 0.9 default gate always breaks that.
    // So the share NOT on the grid is a decent read on how much was shortened.
    // (A staccato halving is invisible here: 480 -> 240 still looks notated.)
    const NOTATED_UNIT = 20;
    const onGridDur = notes.filter((n) => n.d % NOTATED_UNIT === 0).length;
    rows.push(['notes at a full notated length', `${onGridDur} (${pct(onGridDur, notes.length)})`]);
    rows.push(['  shortened by articulation', pct(notes.length - onGridDur, notes.length)]);
    rows.push(['grace notes (110 ticks)', notes.filter((n) => n.d === 110).length]);

    // --- tempo --------------------------------------------------------------
    rows.push(['defaultBpm', String(score.defaultBpm)]);
    rows.push(['tempo points', (score.tempos ?? []).length]);
    const printed = (score.tempos ?? []).filter((t) => t.src === 'sound' || t.src === 'metronome').length;
    const worded = (score.tempos ?? []).filter((t) => t.src === 'word').length;
    rows.push(['  printed / inferred / ramp', `${printed} / ${worded} / ${(score.tempos ?? []).length - printed - worded}`]);
    rows.push(['fermata holds', (score.holds ?? []).length]);

    // --- meter --------------------------------------------------------------
    rows.push(['time signatures', JSON.stringify(score.timeSignatures.map((s) => `${s.num}/${s.den}@${s.tick}`))]);
    const sigAt = (tick) => {
        let active = score.timeSignatures[0];
        for (const s of score.timeSignatures) {
            if (s.tick > tick) break;
            active = s;
        }
        return active ?? { num: 4, den: 4 };
    };
    let onGrid = 0;
    for (const m of score.measures) {
        const sig = sigAt(m.tick);
        if (m.dTicks === Math.round(sig.num * ((TICKS_PER_QUARTER * 4) / sig.den))) onGrid += 1;
    }
    rows.push(['bars matching their signature', `${onGrid} / ${score.measures.length} (${pct(onGrid, score.measures.length)})`]);
    rows.push(['totalTicks', score.totalTicks]);

    const width = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) {
        console.log(`${k.padEnd(width)}  ${v}`);
    }
};

const arg = process.argv[2];
if (!arg) {
    console.error('usage: score-metrics.mjs <audiveris-output-dir> | --json <scoredata.json>');
    process.exit(1);
}
const score =
    arg === '--json'
        ? JSON.parse(readFileSync(process.argv[3], 'utf8'))
        : await loadFromDir(statSync(arg).isDirectory() ? arg : join(arg, '..'));
report(score);
