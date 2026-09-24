import { movementIndexFromFilename, workKeyFromText } from './workKey.js';
import { formatFromFilename, sourcePriority, type RankedCandidate, type WorkKey } from './types.js';

export interface ImslpHarvestedFile {
    name: string;
    description: string;
    format: NonNullable<ReturnType<typeof formatFromFilename>>;
}

const AUDIO_SUFFIX = /\.(mp3|ogg|flac|wav|wma|aac|opus|mp4|m4a|webm)$/i;

const OTHER_SCORING_RE =
    /\b(arrangement|arranged|transcription|transcribed|other scoring|quintet|quartet|trio|duo|orchestra|violin|cello|lute|guitar|easy piano|simplified|4\s*hands|four hands|2\s*pianos)\b/i;

export const isArrangementDescription = (description: string, filename: string): boolean => {
    const blob = `${description} ${filename}`;
    return OTHER_SCORING_RE.test(blob);
};

const fileUrl = (name: string): string => `https://imslp.org/wiki/Special:FilePath/${encodeURIComponent(name)}`;

/**
 * Collect `File Name N=` entries from IMSLP work-page wikitext.
 * Keeps .mxl/.xml/.ly/.mscz/.mid; skips audio and arrangement / other-scoring
 * descriptions (BWV 999 lute/cello duo, Gnossienne quintet, etc.).
 */
export const harvestImslpWikitext = (wikitext: string): ImslpHarvestedFile[] => {
    const names = new Map<number, string>();
    const descriptions = new Map<number, string>();
    const nameRe = /\|\s*File\s*Name\s*(\d+)\s*=\s*([^\n|]+)/gi;
    const descRe = /\|\s*File\s*Description\s*(\d+)\s*=\s*([^\n|]+)/gi;
    for (const match of wikitext.matchAll(nameRe)) {
        const n = Number(match[1]);
        const name = (match[2] ?? '').trim();
        if (Number.isFinite(n) && name !== '') {
            names.set(n, name);
        }
    }
    for (const match of wikitext.matchAll(descRe)) {
        const n = Number(match[1]);
        const desc = (match[2] ?? '').trim();
        if (Number.isFinite(n)) {
            descriptions.set(n, desc);
        }
    }
    const out: ImslpHarvestedFile[] = [];
    for (const [n, name] of names) {
        if (AUDIO_SUFFIX.test(name)) {
            continue;
        }
        const format = formatFromFilename(name);
        if (format === null) {
            continue;
        }
        const description = descriptions.get(n) ?? '';
        if (isArrangementDescription(description, name)) {
            continue;
        }
        out.push({ name, description, format });
    }
    return out;
};

export const imslpFilesToCandidates = (
    files: readonly ImslpHarvestedFile[],
    pageTitle: string,
    workKey: WorkKey,
): RankedCandidate[] => {
    const pageKey = workKeyFromText(pageTitle) ?? workKey;
    const out: RankedCandidate[] = [];
    for (const file of files) {
        const fromName = movementIndexFromFilename(file.name);
        const key: WorkKey = { ...pageKey };
        if (fromName !== undefined) {
            key.movementIndex = fromName;
        }
        if (workKey.movementIndex !== undefined && key.movementIndex !== undefined) {
            if (workKey.movementIndex !== key.movementIndex) {
                continue;
            }
        }
        out.push({
            source: 'imslp',
            format: file.format,
            url: fileUrl(file.name),
            workKey: key,
            title: file.name,
            arrangement: false,
            priority: sourcePriority('imslp', file.format),
        });
    }
    return out;
};
