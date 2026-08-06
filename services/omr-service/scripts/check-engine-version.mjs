#!/usr/bin/env node
/**
 * CI guard: PRs that touch OMR parser/geometry/contract/flags must change
 * the ENGINE_VERSION string in job.ts (not merely touch the file).
 *
 * Usage: node scripts/check-engine-version.mjs [--base REF]
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const WATCHED = [
    'src/musicxml.ts',
    'src/omrGeometry.ts',
    'src/buildScoreData.ts',
    'src/scoreData.ts',
    'src/audiveris.ts',
];

const ENGINE_FILE = 'src/job.ts';
const VERSION_RE = /export const ENGINE_VERSION = '(audiveris-\d+\.\d+\.\d+\+svc-\d+)'/;

const baseArg = process.argv.find((a) => a.startsWith('--base='));
const base =
    baseArg?.slice('--base='.length) ||
    process.env.GITHUB_BASE_REF ||
    process.env.ENGINE_VERSION_BASE ||
    'origin/main';

const extractVersion = (src) => {
    const m = src.match(VERSION_RE);
    return m?.[1] ?? null;
};

let diff = '';
try {
    diff = execSync(`git diff --name-only ${base}...HEAD`, { cwd: ROOT, encoding: 'utf8' });
} catch {
    console.log('[engine-version] skip: could not diff against', base);
    process.exit(0);
}

const changed = new Set(
    diff
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((p) => p.replace(/^services\/omr-service\//, '')),
);

const hit = WATCHED.filter((f) => changed.has(f));
if (hit.length === 0) {
    console.log('[engine-version] ok: no watched parser files changed');
    process.exit(0);
}

const headSrc = readFileSync(join(ROOT, ENGINE_FILE), 'utf8');
const headVer = extractVersion(headSrc);
if (!headVer) {
    console.error('[engine-version] FAIL: ENGINE_VERSION constant missing or malformed in job.ts');
    process.exit(1);
}

let baseVer = null;
try {
    const baseSrc = execSync(`git show ${base}:services/omr-service/${ENGINE_FILE}`, {
        cwd: ROOT,
        encoding: 'utf8',
    });
    baseVer = extractVersion(baseSrc);
} catch {
    // File may not exist on base — treat as first introduction.
    baseVer = null;
}

if (baseVer !== null && baseVer === headVer) {
    console.error(
        `[engine-version] FAIL: changed ${hit.join(', ')} but ENGINE_VERSION is still '${headVer}'.\n` +
            `Bump audiveris-<semver>+svc-<n> in ${ENGINE_FILE}.`,
    );
    process.exit(1);
}

console.log(`[engine-version] ok: ${baseVer ?? '(none)'} → ${headVer} (touched ${hit.join(', ')})`);
