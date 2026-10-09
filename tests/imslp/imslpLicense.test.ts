import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { editionAvailability } from '@/features/imslp/imslpDisplay';

import {
    canonicalImslpFilename,
    classifyLicense,
    isDownloadable,
    parseWorkPageLicenses,
} from '../../supabase/functions/_shared/imslpLicense';

const fixture = (name: string): string =>
    readFileSync(resolve(process.cwd(), 'tests/imslp/fixtures', name), 'utf8');

describe('canonicalImslpFilename', () => {
    it('turns underscores, extra spaces, and a lower first letter into the cache key', () => {
        expect(canonicalImslpFilename('pmlp01458-Op.27-2_Manuscript.pdf')).toBe('Pmlp01458-Op.27-2 Manuscript.pdf');
        expect(canonicalImslpFilename('  Moonlight   Sonata.pdf  ')).toBe('Moonlight Sonata.pdf');
        expect(canonicalImslpFilename('already Canonical.pdf')).toBe('Already Canonical.pdf');
    });
});

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

describe('editionAvailability', () => {
    it('claims a restriction only where IMSLP stated one', () => {
        // A red regional flag is IMSLP's own wording — quote it.
        expect(
            editionAvailability({
                license: 'pd',
                licenseLabel: 'Public Domain',
                restriction: 'Non-PD US',
                downloadable: false,
            }),
        ).toEqual({ kind: 'restricted', label: 'Non-PD US' });

        // A Non-PD license tag is a real restriction even without a separate flag.
        expect(
            editionAvailability({
                license: 'non-pd',
                licenseLabel: 'Non-PD US',
                restriction: null,
                downloadable: false,
            }),
        ).toEqual({ kind: 'restricted', label: 'Non-PD US' });

        // Clean PD tag held back only by EU-mirror hosting: IMSLP said the
        // opposite of restricted, so the panel must not assert one.
        expect(
            editionAvailability({
                license: 'pd',
                licenseLabel: 'Public Domain',
                restriction: null,
                downloadable: false,
            }),
        ).toEqual({ kind: 'unknown', label: 'License unverified' });

        // Page parsed, but this file was never bound to a Copyright cell.
        expect(
            editionAvailability({
                license: 'unknown',
                licenseLabel: null,
                restriction: null,
                downloadable: false,
            }),
        ).toEqual({ kind: 'unknown', label: 'License unverified' });
    });
});
