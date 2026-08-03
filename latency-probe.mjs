import { readFileSync } from 'node:fs';
import { MPEGDecoder } from 'mpg123-decoder';
const decoder = new MPEGDecoder();
await decoder.ready;
for (const name of ['C2', 'C4', 'A4', 'C6']) {
    const bytes = new Uint8Array(readFileSync(`public/audio/piano/${name}.mp3`));
    const { channelData, sampleRate } = decoder.decode(bytes);
    decoder.reset();
    const mono = channelData[0];
    let first = -1;
    let peak = 0;
    for (let i = 0; i < mono.length; i++) peak = Math.max(peak, Math.abs(mono[i]));
    const threshold = Math.max(0.01, peak * 0.02);
    for (let i = 0; i < mono.length; i++) { if (Math.abs(mono[i]) > threshold) { first = i; break; } }
    console.log(`${name}: onset at ${(first / sampleRate * 1000).toFixed(1)} ms (peak ${peak.toFixed(2)}, rate ${sampleRate})`);
}
decoder.free();
