import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    classifyLicense,
    isDownloadable,
    parseWorkPageLicenses,
} from '../../supabase/functions/_shared/imslpLicense';

const fixture = (name: string): string =>
    readFileSync(resolve(process.cwd(), 'tests/imslp/fixtures', name), 'utf8');

describe('classifyLicense', () => {
    it('maps verbatim IMSLP labels to classes', () => {
        expect(classifyLicense('Public Domain')).toBe('pd');
        expect(classifyLicense('Public Domain (dedicated)')).toBe('pd');
        expect(classifyLicense('Creative Commons Attribution 4.0')).toBe('cc');
        expect(classifyLicense('Creative Commons Attribution Non-commercial No Derivatives 3.0')).toBe('cc');
        expect(classifyLicense('Performance Restricted Attribution-NonCommercial-NoDerivs 3.0')).toBe('cc');
        expect(classifyLicense('Non-PD US')).toBe('non-pd');
        expect(classifyLicense(null)).toBe('unknown');
        expect(classifyLicense('Something else entirely')).toBe('unknown');
    });
});

describe('isDownloadable', () => {
    it('requires a clean PD/CC tag, no regional flag, and non-EU hosting', () => {
        expect(isDownloadable({ licenseLabel: 'Public Domain', restriction: null, euHosted: false })).toBe(true);
        expect(
            isDownloadable({ licenseLabel: 'Creative Commons Attribution 4.0', restriction: null, euHosted: false }),
        ).toBe(true);
        expect(isDownloadable({ licenseLabel: 'Public Domain', restriction: 'Non-PD US', euHosted: false })).toBe(
            false,
        );
        expect(isDownloadable({ licenseLabel: 'Public Domain', restriction: null, euHosted: true })).toBe(false);
        expect(isDownloadable({ licenseLabel: null, restriction: null, euHosted: false })).toBe(false);
    });
});

describe('parseWorkPageLicenses', () => {
    it('reads the Gershwin Second Rhapsody page: PD-tagged but Non-PD US and EU-hosted', () => {
        // Real action=parse HTML, saved 2026-08-30. The wikitext for this work
        // says "Public Domain"; only the rendered page carries the red
        // regional flag — the exact case that made wikitext-only parsing wrong.
        const licenses = parseWorkPageLicenses(fixture('gershwin-second-rhapsody.html'));
        const twoPianos = licenses.get('PMLP314974-Gershwin 2nd Rhapsody - 2 pianos.pdf');
        expect(twoPianos).toBeDefined();
        expect(twoPianos?.licenseLabel).toBe('Public Domain');
        expect(twoPianos?.restriction).toBe('Non-PD US');
        expect(twoPianos?.euHosted).toBe(true);
        expect(twoPianos && isDownloadable(twoPianos)).toBe(false);

        const fullScore = licenses.get('PMLP314974-Gershwin - Second Rhapsody.pdf');
        expect(fullScore?.restriction).toBe('Non-PD US');
    });

    it('reads the Moonlight Sonata excerpt: clean PD scan is downloadable, CC recording is classified', () => {
        const licenses = parseWorkPageLicenses(fixture('moonlight-excerpt.html'));

        const manuscript = licenses.get('PMLP01458-Op.27-2 Manuscript.pdf');
        expect(manuscript).toBeDefined();
        expect(manuscript?.licenseLabel).toBe('Public Domain');
        expect(manuscript?.restriction).toBeNull();
        expect(manuscript?.euHosted).toBe(false);
        expect(manuscript && isDownloadable(manuscript)).toBe(true);

        const ccRecording = licenses.get('PMLP01458-beethoven op27.mp3');
        expect(ccRecording).toBeDefined();
        expect(classifyLicense(ccRecording?.licenseLabel ?? null)).toBe('cc');
    });

    it('returns an empty map for HTML without file entries', () => {
        expect(parseWorkPageLicenses('<html><body>nothing here</body></html>').size).toBe(0);
    });
});
