// Uploads the benchmark's objects to the LOCAL Supabase storage with the
// service key: the scan and vector scores, and a published cover for every
// score the teacher sees first (seed.sql stamps thumb_rev 0 on them).
//   node scripts/perf/seed-storage.mjs
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REPO = new URL('../..', import.meta.url).pathname;
const env = Object.fromEntries(
    execSync('npx supabase status -o env', { cwd: REPO, encoding: 'utf8' })
        .split('\n')
        .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
);
const API = env.API_URL;
const KEY = env.SERVICE_ROLE_KEY;
if (!API.includes('127.0.0.1')) throw new Error('local only');

const FIX = `${process.env.CLEFFY_PERF_DIR ?? '/tmp/cleffy-perf'}/fixtures`;
const docId = (n) => `e0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const put = async (bucket, path, body, type) => {
    const res = await fetch(`${API}/storage/v1/object/${bucket}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, apikey: KEY, 'Content-Type': type, 'x-upsert': 'true' },
        body,
    });
    if (!res.ok) throw new Error(`${bucket}/${path}: ${res.status} ${await res.text()}`);
};

const scan = readFileSync(`${FIX}/scan-24.pdf`);
const vector = readFileSync(`${FIX}/vector-16.pdf`);
// Newest (page 1), and two old ones that only "load more" reaches.
await put('scores', `${docId(1)}/original.pdf`, scan, 'application/pdf');
await put('scores', `${docId(2)}/original.pdf`, vector, 'application/pdf');
await put('scores', `${docId(450)}/original.pdf`, scan, 'application/pdf');
console.log('pdfs uploaded');

const covers = Array.from({ length: 12 }, (_, i) => readFileSync(`${FIX}/cover-${i}.jpg`));
const queue = Array.from({ length: 600 }, (_, i) => i + 1);
await Promise.all(
    Array.from({ length: 16 }, async () => {
        while (queue.length) {
            const n = queue.shift();
            await put('thumbnails', `${docId(n)}/0.jpg`, covers[n % 12], 'image/jpeg');
        }
    }),
);
// The three scores the stock local seed creates.
for (const n of [1, 2, 3]) {
    await put('thumbnails', `b0000000-0000-4000-8000-00000000000${n}/0.jpg`, covers[3], 'image/jpeg');
}
console.log('covers uploaded');
