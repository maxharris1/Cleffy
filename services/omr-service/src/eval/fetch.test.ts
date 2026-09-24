import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';

import { extractZipSafely, midiPath } from './fetch.js';

describe('extractZipSafely', () => {
    it('writes basenames only', () => {
        const dir = mkdtempSync(join(tmpdir(), 'omr-eval-zip-'));
        const zipPath = join(dir, 'in.zip');
        const dest = join(dir, 'out');
        mkdirSync(dest);
        const zip = new AdmZip();
        zip.addFile('nested/ok.mid', Buffer.from('MThd-ok'));
        zip.writeZip(zipPath);
        extractZipSafely(zipPath, dest);
        expect(readFileSync(join(dest, 'ok.mid'), 'utf8')).toBe('MThd-ok');
        rmSync(dir, { recursive: true, force: true });
    });

    it('refuses path-traversal entries', () => {
        const dir = mkdtempSync(join(tmpdir(), 'omr-eval-slip-'));
        const zipPath = join(dir, 'evil.zip');
        const dest = join(dir, 'out');
        mkdirSync(dest);
        const zip = new AdmZip();
        zip.addFile('evil.mid', Buffer.from('nope'));
        const entry = zip.getEntries()[0];
        if (entry) {
            entry.entryName = '../evil.mid';
        }
        zip.writeZip(zipPath);
        expect(() => extractZipSafely(zipPath, dest)).toThrow(/path traversal/);
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('midiPath', () => {
    it('rejects a path-shaped MIDI name', () => {
        expect(() => midiPath({ pdfPath: null, midiDir: tmpdir() }, '../x.mid')).toThrow(/basename/);
    });
});
