import { execFileSync } from 'node:child_process';

/** Offline `.ly` → MusicXML. Injectable so tests and eval do not need LilyPond. */
export interface LyConverter {
    readonly name: string;
    isAvailable(): boolean;
    toMusicXml(ly: Buffer): Buffer;
}

export const LY_CONVERT_FLAG = 'CLEFFY_SYMBOLIC_LY';

export const unavailableLyConverter: LyConverter = {
    name: 'unavailable',
    isAvailable: () => false,
    toMusicXml: (): Buffer => {
        throw new Error('LilyPond MusicXML converter is not available');
    },
};

/**
 * `ly musicxml` (python-ly) or another argv. Gated by CLEFFY_SYMBOLIC_LY=1
 * so a missing binary never surprises ingest.
 */
export const processLyConverter = (
    command = 'ly',
    args: readonly string[] = ['musicxml', '-'],
): LyConverter => ({
    name: `${command} ${args.join(' ')}`,
    isAvailable: () => {
        if (process.env[LY_CONVERT_FLAG] !== '1') {
            return false;
        }
        try {
            execFileSync(command, ['--version'], { stdio: 'pipe' });
            return true;
        } catch {
            return false;
        }
    },
    toMusicXml: (ly: Buffer): Buffer => Buffer.from(execFileSync(command, [...args], { input: ly })),
});

export const defaultLyConverter = (): LyConverter => {
    const candidate = processLyConverter();
    return candidate.isAvailable() ? candidate : unavailableLyConverter;
};
