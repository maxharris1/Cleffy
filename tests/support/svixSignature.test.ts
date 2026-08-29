import { describe, expect, it } from 'vitest';

import {
    buildSvixSignatureHeader,
    computeSvixSignature,
    DEFAULT_TOLERANCE_SEC,
    parseSvixSignatures,
    secretKeyBytes,
    verifySvixSignature,
} from '../../supabase/functions/_shared/svixSignature';

/**
 * The gate on the inbound-mail endpoint. Anyone can POST to it — it runs with
 * `verify_jwt = false`, because Resend has no Supabase JWT to present — so this
 * signature check is the only thing between the open internet and a row in
 * `support_messages` plus an email forwarded out of our account.
 */

// A realistic Svix secret: the prefix plus base64 that decodes to real bytes.
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const ID = 'msg_2abcDEF';
const BODY = '{"type":"email.received","data":{"email_id":"e1"}}';

const at = (nowSec: number) => nowSec;

describe('secretKeyBytes', () => {
    it('decodes the base64 body of a whsec_ secret', () => {
        const bytes = secretKeyBytes(SECRET);
        expect(bytes).toBeInstanceOf(Uint8Array);
        // Decoded bytes, not the 32 ASCII characters of the base64 text — this is
        // the difference that silently breaks every signature if got wrong.
        expect(bytes!.length).toBe(24);
    });

    it('accepts a bare secret with no prefix', () => {
        expect(secretKeyBytes('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw')).toBeInstanceOf(Uint8Array);
    });

    it('refuses an empty or undecodable secret', () => {
        expect(secretKeyBytes('whsec_')).toBeNull();
        expect(secretKeyBytes('whsec_!!!not base64!!!')).toBeNull();
    });
});

describe('parseSvixSignatures', () => {
    it('reads a space-separated list, keeping only v1', () => {
        expect(parseSvixSignatures('v1,aaa v1,bbb')).toEqual(['aaa', 'bbb']);
        expect(parseSvixSignatures('v2,zzz v1,aaa')).toEqual(['aaa']);
    });

    it('yields nothing for junk', () => {
        expect(parseSvixSignatures('')).toEqual([]);
        expect(parseSvixSignatures('garbage')).toEqual([]);
        expect(parseSvixSignatures('v1,')).toEqual([]);
    });
});

describe('verifySvixSignature', () => {
    const now = 1_787_000_000;

    const headersFor = async (opts: { id?: string; ts?: string; body?: string; secret?: string } = {}) => {
        const id = opts.id ?? ID;
        const ts = opts.ts ?? String(now);
        const signature = await buildSvixSignatureHeader(id, ts, opts.body ?? BODY, opts.secret ?? SECRET);
        return { id, timestamp: ts, signature };
    };

    it('accepts a signature it just built', async () => {
        expect(await verifySvixSignature(BODY, await headersFor(), SECRET, at(now))).toEqual({ ok: true });
    });

    it('accepts when one of several rotated signatures matches', async () => {
        const good = await computeSvixSignature(ID, String(now), BODY, SECRET);
        const headers = { id: ID, timestamp: String(now), signature: `v1,otherSignatureEntirely= v1,${good}` };
        expect(await verifySvixSignature(BODY, headers, SECRET, at(now))).toEqual({ ok: true });
    });

    it.each([
        ['id', { id: null }],
        ['timestamp', { timestamp: null }],
        ['signature', { signature: null }],
    ])('refuses a request missing the %s header', async (_label, override) => {
        const headers = { ...(await headersFor()), ...override };
        expect(await verifySvixSignature(BODY, headers, SECRET, at(now))).toEqual({
            ok: false,
            reason: 'missing_header',
        });
    });

    it('refuses a non-numeric timestamp', async () => {
        const headers = { ...(await headersFor()), timestamp: 'not-a-number' };
        expect(await verifySvixSignature(BODY, headers, SECRET, at(now))).toEqual({
            ok: false,
            reason: 'malformed_timestamp',
        });
    });

    // The replay window. A captured-and-resent delivery must stop working.
    it('refuses a timestamp outside the tolerance, in either direction', async () => {
        const stale = await headersFor({ ts: String(now - DEFAULT_TOLERANCE_SEC - 1) });
        expect(await verifySvixSignature(BODY, stale, SECRET, at(now))).toEqual({
            ok: false,
            reason: 'timestamp_out_of_tolerance',
        });
        const future = await headersFor({ ts: String(now + DEFAULT_TOLERANCE_SEC + 1) });
        expect(await verifySvixSignature(BODY, future, SECRET, at(now))).toEqual({
            ok: false,
            reason: 'timestamp_out_of_tolerance',
        });
    });

    it('accepts right at the edge of the window', async () => {
        const edge = await headersFor({ ts: String(now - DEFAULT_TOLERANCE_SEC) });
        expect(await verifySvixSignature(BODY, edge, SECRET, at(now))).toEqual({ ok: true });
    });

    it('refuses a header carrying no v1 entry', async () => {
        const headers = { ...(await headersFor()), signature: 'v2,something' };
        expect(await verifySvixSignature(BODY, headers, SECRET, at(now))).toEqual({
            ok: false,
            reason: 'no_v1_signature',
        });
    });

    it('refuses an unusable secret rather than passing the request', async () => {
        const headers = await headersFor();
        expect(await verifySvixSignature(BODY, headers, 'whsec_', at(now))).toEqual({
            ok: false,
            reason: 'malformed_secret',
        });
    });

    // The three ways a real forgery attempt looks.
    it('refuses a body altered after signing', async () => {
        const headers = await headersFor();
        const tampered = BODY.replace('e1', 'e2');
        expect(await verifySvixSignature(tampered, headers, SECRET, at(now))).toEqual({
            ok: false,
            reason: 'signature_mismatch',
        });
    });

    it('refuses a signature made with a different secret', async () => {
        const headers = await headersFor({ secret: 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
        expect(await verifySvixSignature(BODY, headers, SECRET, at(now))).toEqual({
            ok: false,
            reason: 'signature_mismatch',
        });
    });

    // The id is part of the signed content, so replaying a valid body under a
    // fresh id must not verify.
    it('refuses when the id does not match the one signed', async () => {
        const headers = { ...(await headersFor()), id: 'msg_different' };
        expect(await verifySvixSignature(BODY, headers, SECRET, at(now))).toEqual({
            ok: false,
            reason: 'signature_mismatch',
        });
    });
});
