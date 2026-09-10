import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const sha256Buffer = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

export const sha256File = (path: string): string => sha256Buffer(readFileSync(path));

export const sha256Files = (paths: readonly string[]): string => {
    const hash = createHash('sha256');
    for (const path of [...paths].sort()) {
        hash.update(path.split(/[/\\]/).pop() ?? path);
        hash.update('\0');
        hash.update(readFileSync(path));
        hash.update('\0');
    }
    return hash.digest('hex');
};
