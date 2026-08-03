// Regenerate the bundled piano voice: public/audio/piano/*.mp3
//
// Source: Salamander Grand Piano by Alexander Holm (CC BY 3.0), via the
// velocity-flattened mp3 set in github.com/nbrosowsky/tonejs-instruments.
// We keep ~30 anchors (every minor third, C1–C8) and slim each one for the
// web: mono, 22.05 kHz, 48 kbps, trimmed to 6 s with a 250 ms fade — the
// playback engine applies its own release envelope at note end, so the long
// natural tails are dead weight.
//
// Usage (one-time deps, not part of the app):
//   npm install --no-save mpg123-decoder@1 @breezystack/lamejs
//   node scripts/fetch-piano-samples.mjs
//
// Keep the anchor list in sync with PIANO_ANCHORS in
// src/features/playback/pianoSampler.ts.

import { mkdir, writeFile } from 'node:fs/promises';
import { MPEGDecoder } from 'mpg123-decoder';
import * as lamejs from '@breezystack/lamejs';

const ANCHORS = [
    'C1', 'Ds1', 'Fs1', 'A1', 'C2', 'Ds2', 'Fs2', 'A2', 'C3', 'Ds3', 'Fs3', 'A3',
    'C4', 'Ds4', 'Fs4', 'A4', 'C5', 'Ds5', 'Fs5', 'A5', 'C6', 'Ds6', 'Fs6', 'A6',
    'C7', 'Ds7', 'Fs7', 'A7', 'C8',
];
const SOURCE = 'https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/master/samples/piano';
const OUT_DIR = new URL('../public/audio/piano/', import.meta.url);
const OUT_RATE = 22050;
const MAX_SECONDS = 6;
const FADE_SECONDS = 0.25;
const KBPS = 48;

const toMono = (channels) => {
    if (channels.length === 1) return channels[0];
    const [l, r] = channels;
    const out = new Float32Array(l.length);
    for (let i = 0; i < l.length; i++) out[i] = (l[i] + r[i]) / 2;
    return out;
};

const resample = (input, fromRate, toRate) => {
    const outLength = Math.floor((input.length * toRate) / fromRate);
    const out = new Float32Array(outLength);
    const step = fromRate / toRate;
    for (let i = 0; i < outLength; i++) {
        const pos = i * step;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const a = input[i0] ?? 0;
        const b = input[i0 + 1] ?? a;
        out[i] = a + (b - a) * frac;
    }
    return out;
};

// Musicality: the note attack must sit at t=0. The source mp3s carry encoder
// pre-roll, and our own lamejs encode adds ~26 ms more (no gapless tag, so
// browsers can't strip it) — untrimmed, every piano note lands audibly late
// against the metronome click and playhead.
const ONSET_PRE_ROLL_S = 0.002;
const FADE_IN_S = 0.002;

const onsetIndex = (input, rate) => {
    let peak = 0;
    for (let i = 0; i < input.length; i++) peak = Math.max(peak, Math.abs(input[i]));
    const threshold = Math.max(0.004, peak * 0.01);
    for (let i = 0; i < input.length; i++) {
        if (Math.abs(input[i]) > threshold) {
            return Math.max(0, i - Math.floor(rate * ONSET_PRE_ROLL_S));
        }
    }
    return 0;
};

const trimAndFade = (input, rate, extraLeadTrim = 0) => {
    const start = Math.min(input.length, onsetIndex(input, rate) + extraLeadTrim);
    const max = Math.min(input.length, start + Math.floor(rate * MAX_SECONDS));
    const out = input.slice(start, max);
    const fadeIn = Math.min(out.length, Math.floor(rate * FADE_IN_S));
    for (let i = 0; i < fadeIn; i++) {
        out[i] *= i / fadeIn;
    }
    const fadeSamples = Math.min(out.length, Math.floor(rate * FADE_SECONDS));
    for (let i = 0; i < fadeSamples; i++) {
        const k = out.length - fadeSamples + i;
        out[k] *= 1 - i / fadeSamples;
    }
    return out;
};

const encodeMp3 = (mono, rate) => {
    const encoder = new lamejs.Mp3Encoder(1, rate, KBPS);
    const int16 = new Int16Array(mono.length);
    for (let i = 0; i < mono.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(mono[i] * 32767)));
    }
    const chunks = [];
    for (let i = 0; i < int16.length; i += 1152) {
        const chunk = encoder.encodeBuffer(int16.subarray(i, i + 1152));
        if (chunk.length > 0) chunks.push(Buffer.from(chunk));
    }
    const tail = encoder.flush();
    if (tail.length > 0) chunks.push(Buffer.from(tail));
    return Buffer.concat(chunks);
};

await mkdir(OUT_DIR, { recursive: true });
const decoder = new MPEGDecoder();
await decoder.ready;

// NOTE on residual latency: mp3 always decodes with codec padding at the
// front (lamejs writes no gapless header, so browsers cannot strip it).
// Source-silence is trimmed here, and the app measures each decoded buffer's
// true onset at load time and plays from that offset
// (src/features/playback/pianoSampler.ts) — that pairing is what keeps note
// attacks sample-accurate against the metronome and playhead.

let total = 0;
for (const name of ANCHORS) {
    const res = await fetch(`${SOURCE}/${name}.mp3`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { channelData, sampleRate } = decoder.decode(bytes);
    decoder.reset();
    const source = resample(toMono(channelData), sampleRate, OUT_RATE);
    const mp3 = encodeMp3(trimAndFade(source, OUT_RATE), OUT_RATE);
    await writeFile(new URL(`${name}.mp3`, OUT_DIR), mp3);
    total += mp3.length;
    console.log(`${name}.mp3  ${(mp3.length / 1024).toFixed(0)} KiB`);
}
decoder.free();
console.log(`total ${(total / 1024 / 1024).toFixed(2)} MiB across ${ANCHORS.length} samples`);
