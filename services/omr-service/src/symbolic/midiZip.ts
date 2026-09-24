import AdmZip from 'adm-zip';
import { basename } from 'node:path';

import { concatMidiBuffers, concatParts, concatUrl, isConcatUrl, ZIP_CONCAT_MEMBER } from './midiConcat.js';
import { isMutopiaMidiZip } from './mutopia.js';
import type { RankedCandidate } from './types.js';

export interface ZipBytesFetcher {
    fetchBytes: (url: string, signal?: AbortSignal) => Promise<Buffer>;
}

const isTranscriptionFilename = (filename: string): boolean => /guitar|[-_]tab[-_.]|ukulele/i.test(filename);

export const splitZipMemberUrl = (url: string): { zipUrl: string; member: string } | null => {
    const hash = url.indexOf('#');
    if (hash <= 0) {
        return null;
    }
    const zipUrl = url.slice(0, hash);
    if (!isMutopiaMidiZip(basename(zipUrl))) {
        return null;
    }
    return { zipUrl, member: decodeURIComponent(url.slice(hash + 1)) };
};

const midiEntries = (zipBytes: Buffer): string[] => {
    const zip = new AdmZip(zipBytes);
    const names: string[] = [];
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) {
            continue;
        }
        const name = basename(entry.entryName.replace(/\\/g, '/'));
        if (isTranscriptionFilename(name) || isTranscriptionFilename(entry.entryName)) {
            continue;
        }
        if (!/\.(mid|midi)$/i.test(name)) {
            continue;
        }
        names.push(entry.entryName);
    }
    return names;
};

const entryBytes = (zipBytes: Buffer, member: string): Buffer | null => {
    const zip = new AdmZip(zipBytes);
    const wanted = member.replace(/\\/g, '/');
    const hit = zip.getEntries().find((entry) => {
        const name = entry.entryName.replace(/\\/g, '/');
        return name === wanted || basename(name) === basename(wanted);
    });
    if (hit === undefined) {
        return null;
    }
    return hit.getData();
};

/**
 * Fetch a Mutopia `-mids.zip` once and serve `#member` URLs from the cache.
 */
export const wrapZipBytesFetcher = (inner: ZipBytesFetcher): ZipBytesFetcher => {
    const cache = new Map<string, Buffer>();
    const fetchOne = async (url: string, signal?: AbortSignal): Promise<Buffer> => {
        if (isConcatUrl(url)) {
            const parts: Buffer[] = [];
            for (const part of concatParts(url)) {
                parts.push(await fetchOne(part, signal));
            }
            return concatMidiBuffers(parts);
        }
        const split = splitZipMemberUrl(url);
        if (split === null) {
            return inner.fetchBytes(url, signal);
        }
        let zip = cache.get(split.zipUrl);
        if (zip === undefined) {
            zip = await inner.fetchBytes(split.zipUrl, signal);
            cache.set(split.zipUrl, zip);
        }
        if (split.member === ZIP_CONCAT_MEMBER) {
            const members = midiEntries(zip);
            const parts: Buffer[] = [];
            for (const member of members) {
                const bytes = entryBytes(zip, member);
                if (bytes !== null) {
                    parts.push(bytes);
                }
            }
            return concatMidiBuffers(parts);
        }
        const bytes = entryBytes(zip, split.member);
        if (bytes === null) {
            throw new Error(`zip member missing: ${split.member}`);
        }
        return bytes;
    };
    return {
        fetchBytes: fetchOne,
    };
};

/**
 * Replace each Mutopia `-mids.zip` candidate with one MIDI candidate per
 * member so matching can use per-movement bar counts. `signal` aborts the zip
 * downloads (an aborted zip is skipped like a failed one).
 */
export const expandMutopiaMidiZips = async (
    ranked: readonly RankedCandidate[],
    bytes: ZipBytesFetcher,
    signal?: AbortSignal,
): Promise<RankedCandidate[]> => {
    const out: RankedCandidate[] = [];
    for (const cand of ranked) {
        if (!isMutopiaMidiZip(basename(cand.url))) {
            out.push(cand);
            continue;
        }
        let zipBytes: Buffer;
        try {
            zipBytes = await bytes.fetchBytes(cand.url, signal);
        } catch {
            continue;
        }
        if (zipBytes.length < 4 || zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b) {
            continue;
        }
        const members = midiEntries(zipBytes);
        const memberUrls: string[] = [];
        for (const member of members) {
            const url = `${cand.url}#${encodeURIComponent(member)}`;
            memberUrls.push(url);
            out.push({
                ...cand,
                format: 'mid',
                url,
            });
        }
        if (memberUrls.length >= 2) {
            out.push({
                ...cand,
                format: 'mid',
                url: concatUrl(memberUrls),
                title: cand.title !== undefined ? `${cand.title} (all movements)` : 'all movements',
            });
        }
    }
    return out;
};
