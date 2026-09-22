import { parseMidi, writeMidi, type MidiData, type MidiEvent } from 'midi-file';

export const CONCAT_URL_PREFIX = 'cleffy-concat:';
export const ZIP_CONCAT_MEMBER = '__concat__.mid';

type AbsEvent = { tick: number; event: MidiEvent };

export const isConcatUrl = (url: string): boolean => url.startsWith(CONCAT_URL_PREFIX);

export const concatUrl = (parts: readonly string[]): string => `${CONCAT_URL_PREFIX}${parts.join('|')}`;

export const concatParts = (url: string): string[] => {
    if (!isConcatUrl(url)) {
        return [];
    }
    return url.slice(CONCAT_URL_PREFIX.length).split('|').filter((part) => part.length > 0);
};

const toDelta = (abs: AbsEvent[]): MidiEvent[] => {
    const ordered = [...abs].sort((a, b) => a.tick - b.tick);
    let prev = 0;
    const out: MidiEvent[] = [];
    for (const row of ordered) {
        out.push({ ...row.event, deltaTime: row.tick - prev });
        prev = row.tick;
    }
    out.push({ type: 'endOfTrack', deltaTime: 0, meta: true });
    return out;
};

/**
 * Append MIDI files in order so a whole-sonata PDF can match the sum of
 * Mutopia / piano-midi.de movement files.
 */
export const concatMidiBuffers = (parts: readonly Buffer[]): Buffer => {
    if (parts.length === 0) {
        throw new Error('concatMidiBuffers: empty');
    }
    if (parts.length === 1) {
        const only = parts[0];
        if (only === undefined) {
            throw new Error('concatMidiBuffers: empty');
        }
        return only;
    }
    const parsed = parts.map((part) => parseMidi(part));
    const ticksPerBeat = parsed[0]?.header.ticksPerBeat ?? 480;
    const nTracks = Math.max(1, ...parsed.map((file) => file.tracks.length));
    const absTracks: AbsEvent[][] = Array.from({ length: nTracks }, () => []);
    let offset = 0;
    for (const file of parsed) {
        const from = file.header.ticksPerBeat ?? ticksPerBeat;
        const scale = from === 0 ? 1 : ticksPerBeat / from;
        let fileDur = 0;
        for (let i = 0; i < nTracks; i += 1) {
            const track = file.tracks[i] ?? [];
            let tick = 0;
            const dest = absTracks[i];
            if (dest === undefined) {
                continue;
            }
            for (const event of track) {
                tick += event.deltaTime;
                if (event.type === 'endOfTrack') {
                    continue;
                }
                dest.push({
                    tick: offset + Math.round(tick * scale),
                    event: { ...event, deltaTime: 0 },
                });
            }
            fileDur = Math.max(fileDur, Math.round(tick * scale));
        }
        offset += fileDur;
    }
    const tracks = absTracks.map(toDelta);
    const data: MidiData = {
        header: { format: 1, numTracks: tracks.length, ticksPerBeat },
        tracks,
    };
    return Buffer.from(writeMidi(data));
};
