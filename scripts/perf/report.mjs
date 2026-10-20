// Before/after tables from the benchmark's results.jsonl (median of each label's runs).
//   node scripts/perf/report.mjs <before-label> <after-label> [scenario ...]
import { readFileSync } from 'node:fs';

const OUT = process.env.CLEFFY_PERF_DIR ?? '/tmp/cleffy-perf';

/** The metrics worth reading for each scenario, in order. */
const KEYS = {
    landingCold: ['fcp', 'lcp', 'jsKB', 'tbt'],
    libraryCold: ['fcp', 'coversAt', 'lcp', 'tbt', 'jsKB'],
    libraryColdSW: ['coversAt', 'lcp', 'tbt'],
    libraryWarm: ['cachePaint', 'networkPaint', 'coversAt', 'tbt'],
    libraryScroll: ['pageLoadMed', 'fps', 'p95Frame', 'scrollLongTaskMs', 'favMs', 'typeMs'],
    libraryFling: ['stallMs', 'stalls'],
    openNewestCold: ['toFirstPage', 'toConfirmed', 'tbt'],
    openOldCold: ['toFirstPage', 'toConfirmed', 'tbt'],
    openNewestWarm: ['toFirstPage', 'toConfirmed', 'tbt'],
    openNewestBrowse: ['toFirstPage', 'toConfirmed', 'tbt'],
    openNewestWarmBrowse: ['toFirstPage', 'toConfirmed', 'tbt'],
    openNewestColdSW: ['toFirstPage', 'toConfirmed', 'tbt'],
    accountWithCache: ['toStorageSummary', 'tbt'],
    viewerScroll: ['fps', 'p95', 'longMs'],
};
const HIGHER_IS_BETTER = new Set(['fps']);

const [before, after, ...only] = process.argv.slice(2);
if (!before || !after) {
    console.error('usage: node scripts/perf/report.mjs <before-label> <after-label> [scenario ...]');
    process.exit(1);
}

// The last record per label and scenario wins.
const rows = new Map();
for (const line of readFileSync(`${OUT}/results.jsonl`, 'utf8').split('\n')) {
    if (line.trim()) {
        const record = JSON.parse(line);
        rows.set(`${record.label}\u0000${record.name}`, record);
    }
}

const fmt = (v) =>
    v === null || v === undefined ? '–' : Math.abs(v) < 100 && !Number.isInteger(v) ? v.toFixed(1) : v.toFixed(0);

for (const name of only.length ? only : Object.keys(KEYS)) {
    const b = rows.get(`${before}\u0000${name}`);
    const a = rows.get(`${after}\u0000${name}`);
    if (!b || !a) {
        continue;
    }
    console.log(`\n### ${name}  (n=${b.runs.length} vs ${a.runs.length})`);
    console.log('| metric | before | after | change |');
    console.log('|---|---|---|---|');
    for (const key of KEYS[name] ?? Object.keys(b.median)) {
        const vb = b.median[key];
        const va = a.median[key];
        if (vb === null || vb === undefined || va === null || va === undefined) {
            continue;
        }
        let change = '–';
        if (vb !== 0) {
            const pct = ((va - vb) / vb) * 100;
            const better = pct > 0 === HIGHER_IS_BETTER.has(key);
            change = `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%${better && Math.abs(pct) >= 3 ? ' ✓' : ''}`;
        } else if (va !== 0) {
            change = 'new';
        }
        console.log(`| ${key} | ${fmt(vb)} | ${fmt(va)} | ${change} |`);
    }
}
