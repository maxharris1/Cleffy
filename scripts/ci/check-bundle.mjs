#!/usr/bin/env node
// Runs after `vite build` (npm run build). See bundleRules.mjs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { bundleProblems } from './bundleRules.mjs';

const dist = path.resolve('dist');
const report = JSON.parse(readFileSync(path.resolve('node_modules/.cache/bundle-modules.json'), 'utf8'));
const problems = bundleProblems(report, (name) => gzipSync(readFileSync(path.join(dist, name))).length);
if (problems.length > 0) {
    for (const problem of problems) {
        console.error(`bundle check: ${problem}`);
    }
    process.exit(1);
}
console.log('bundle check: fake-indexeddb only in the /s viewer chunk, within budget');
