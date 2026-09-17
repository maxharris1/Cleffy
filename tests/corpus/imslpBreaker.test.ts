import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    IMSLP_AUTO_PAUSE_MS,
    IMSLP_BACKOFF_MS,
    IMSLP_PAUSE_AFTER,
    IMSLP_WAIT_MS,
    classifyImslpResponse,
    crawlerUserAgent,
    createImslpBreaker,
    isImslpRippingBan,
    nextImslpDownloadStep,
    sourceEnabled,
} from '../../scripts/playalong-corpus.mjs';

const CDN = 'https://ks15.imslp.org/files/imglnks/usimg/0/07/IMSLP51037-PMLP01458-Op.27-2_Manuscript.pdf';
/** Shape of the real wait page: ~19 kB of site chrome, then the span, then the countdown message. */
const WAIT_PAGE = `<html><head><title>Piano Sonata No.14</title></head><body>${'<div class="menu">…</div>'.repeat(1500)}<span id="sm_dl_wait" data-id="${CDN.replace(':', '&#58;')}">…</span><script>IMSLPMsg={"js-a4":"15","js-r":"Your download will continue in \`1 seconds..."}</script></body></html>`;
/** IMSLP nginx ripping-ban 403 body (fixture — not fetched from imslp.org). */
const RIPPING_BAN_HTML = `<html><head><title>IMSLP</title></head><body>
<p>You have reached this message because the <b>site ripping ban script</b> has been triggered.
Site ripping is forbidden on this site. You will be automatically unbanned after a short period of time.
If you believe you have been banned in error, drop an e-mail to feldmahler {at} imslp.org.</p>
<p>Please do not reload this page often, because every reload refreshes the ban length. Instead, come back in a day.</p>
</body></html>`;
const MTCAPTCHA_HTML =
    '<html><title>IMSLP - Bot Check</title><script src="https://service.mtcaptcha.com/mtcv1/client/mtcaptcha.loader.js"></script><p>Special:GM/getbotclearedtoken</p></html>';
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('IMSLP source — default path is the live import step, no countdown sleep', () => {
    it('follows the wait page to the CDN file and the 15 s wait is only the opt-in constant', () => {
        const step = nextImslpDownloadStep(Buffer.from(WAIT_PAGE));
        expect(step).toEqual({ action: 'cdn', url: CDN });
        expect(IMSLP_WAIT_MS).toBe(15_000);
        const cli = readFileSync(resolve(process.cwd(), 'scripts/seed-playalong-corpus.mjs'), 'utf8');
        // The only sleep on the IMSLP path is gated on the --imslp-wait flag (imslpWaitMs defaults to 0).
        expect(cli).toMatch(/imslpWaitMs: 0,/);
        expect(cli).toMatch(/if \(ctx\.imslpWaitMs > 0\) \{\s*await sleep\(ctx\.imslpWaitMs\);/);
        expect(cli).toMatch(/case '--imslp-wait':\s*out\.imslpWaitMs = IMSLP_WAIT_MS;/);
    });

    it('does not mistake a genuine wait page for a bot wall, but stops at a real one', () => {
        expect(nextImslpDownloadStep(Buffer.from(`${WAIT_PAGE}<!-- mtcaptcha loader -->`)).action).toBe('cdn');
        expect(nextImslpDownloadStep(Buffer.from('<html><title>IMSLP - Bot Check</title>mtcaptcha</html>'))).toEqual({
            action: 'circuit',
            code: 'bot_check',
        });
        expect(
            nextImslpDownloadStep(Buffer.from('<html>Special:IMSLPDisclaimerAccept/51037 disclaimer</html>')),
        ).toEqual({
            action: 'fail',
            code: 'disclaimer',
        });
        expect(nextImslpDownloadStep(Buffer.from('%PDF-1.4 x'))).toEqual({ action: 'accept' });
    });
});

describe('IMSLP source — ripping-ban classifier', () => {
    it('treats HTTP 403 and the known ban HTML as ripping_ban, and nothing else', () => {
        expect(isImslpRippingBan({ status: 403 })).toBe(true);
        expect(isImslpRippingBan({ status: 403, body: '' })).toBe(true);
        expect(isImslpRippingBan({ status: 403, body: WAIT_PAGE })).toBe(true);
        expect(isImslpRippingBan({ status: 200, body: RIPPING_BAN_HTML })).toBe(true);
        expect(isImslpRippingBan({ body: bytesOf(RIPPING_BAN_HTML) })).toBe(true);
        expect(isImslpRippingBan({ status: 200, body: WAIT_PAGE })).toBe(false);
        expect(isImslpRippingBan({ status: 200, body: MTCAPTCHA_HTML })).toBe(false);
        expect(isImslpRippingBan({ status: 200, body: '%PDF-1.4 x' })).toBe(false);
        expect(isImslpRippingBan({ status: 404, body: 'not found' })).toBe(false);
        expect(isImslpRippingBan({ status: 429 })).toBe(false);
        expect(isImslpRippingBan({ body: '<html>Special:IMSLPDisclaimerAccept/1 disclaimer</html>' })).toBe(false);
        expect(isImslpRippingBan({})).toBe(false);
    });

    it('circuits on a 403 ImagefromIndex body and does not parse a wait page or captcha from it', () => {
        expect(classifyImslpResponse(403, bytesOf(RIPPING_BAN_HTML))).toEqual({
            action: 'circuit',
            code: 'ripping_ban',
        });
        expect(classifyImslpResponse(403, bytesOf(''))).toEqual({ action: 'circuit', code: 'ripping_ban' });
        expect(classifyImslpResponse(403, bytesOf(WAIT_PAGE))).toEqual({ action: 'circuit', code: 'ripping_ban' });
        expect(classifyImslpResponse(200, bytesOf(RIPPING_BAN_HTML))).toEqual({
            action: 'circuit',
            code: 'ripping_ban',
        });
        expect(nextImslpDownloadStep(bytesOf(RIPPING_BAN_HTML))).toEqual({
            action: 'circuit',
            code: 'ripping_ban',
        });
        expect(classifyImslpResponse(200, Buffer.from(WAIT_PAGE))).toEqual({ action: 'cdn', url: CDN });
        expect(classifyImslpResponse(200, bytesOf(MTCAPTCHA_HTML))).toEqual({
            action: 'circuit',
            code: 'bot_check',
        });
        expect(classifyImslpResponse(200, bytesOf('%PDF-1.4 x'))).toEqual({ action: 'accept' });
        expect(classifyImslpResponse(200, bytesOf('<html>no pdf here</html>'))).toEqual({
            action: 'fail',
            code: 'not_pdf',
        });
    });
});

describe('IMSLP source — circuit breaker', () => {
    it('backs off 15 min → 1 h → 6 h and pauses the source for 24 h on the third consecutive wall', () => {
        let t = 1_000_000;
        const breaker = createImslpBreaker({ now: () => t });
        expect(breaker.available()).toBe(true);

        const first = breaker.recordBlock('bot_check', 'https://imslp.org/friendlytest.html');
        expect(first).toEqual({
            paused: false,
            parkedUntil: t + IMSLP_BACKOFF_MS[0]!,
            delayMs: 15 * 60_000,
            reason: 'bot_check (1/3)',
        });
        expect(breaker.available()).toBe(false);
        t += IMSLP_BACKOFF_MS[0]! - 1;
        expect(breaker.available()).toBe(false);
        t += 1;
        expect(breaker.available()).toBe(true);

        const second = breaker.recordBlock('bot_check');
        expect(second).toMatchObject({ paused: false, delayMs: 60 * 60_000, reason: 'bot_check (2/3)' });
        t += IMSLP_BACKOFF_MS[1]!;

        const third = breaker.recordBlock('disclaimer', 'https://imslp.org/wiki/Special:ImagefromIndex/1');
        expect(third).toEqual({
            paused: true,
            parkedUntil: t + IMSLP_AUTO_PAUSE_MS,
            delayMs: IMSLP_AUTO_PAUSE_MS,
            reason: 'disclaimer x3: https://imslp.org/wiki/Special:ImagefromIndex/1',
        });
        expect(breaker.state.paused).toBe(true);
        expect(breaker.available()).toBe(false);
        t += IMSLP_AUTO_PAUSE_MS - 1;
        expect(breaker.available()).toBe(false);
        t += 1;
        // A paused breaker stays paused for the process; a later run reads the control row instead.
        expect(breaker.available()).toBe(false);
        expect(IMSLP_PAUSE_AFTER).toBe(3);
        expect(IMSLP_BACKOFF_MS).toEqual([15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]);
    });

    it('a successful download resets the streak; a pause from an earlier run is honoured until it lapses', () => {
        let t = 0;
        const breaker = createImslpBreaker({ now: () => t });
        breaker.recordBlock('bot_check');
        t += IMSLP_BACKOFF_MS[0]!;
        breaker.recordBlock('bot_check');
        breaker.recordSuccess();
        expect(breaker.state.consecutiveBlocks).toBe(0);
        expect(breaker.available()).toBe(true);
        expect(breaker.recordBlock('rate_limited').reason).toBe('rate_limited (1/3)');

        const resumed = createImslpBreaker({ now: () => t });
        resumed.pauseUntil(t + 60_000, 'bot_check x3: earlier run');
        expect(resumed.available()).toBe(false);
        expect(resumed.state.pauseReason).toBe('bot_check x3: earlier run');
    });

    it('a ripping-ban 403 pauses the IMSLP source for 24h on the first hit and leaves Mutopia/IA enabled', () => {
        let t = 5_000_000;
        const breaker = createImslpBreaker({ now: () => t });
        const hit = breaker.recordBlock(
            'ripping_ban',
            'https://imslp.org/wiki/Special:ImagefromIndex/Heller%20-op.%20135%20-2%20intermezzi%20.pdf',
        );
        expect(hit).toEqual({
            paused: true,
            parkedUntil: t + IMSLP_AUTO_PAUSE_MS,
            delayMs: IMSLP_AUTO_PAUSE_MS,
            reason: 'ripping_ban: https://imslp.org/wiki/Special:ImagefromIndex/Heller%20-op.%20135%20-2%20intermezzi%20.pdf',
        });
        expect(breaker.state.paused).toBe(true);
        expect(breaker.available()).toBe(false);
        t += IMSLP_BACKOFF_MS[0]!;
        expect(breaker.available()).toBe(false);

        const parked = new Set(['imslp']);
        const sources = ['mutopia', 'openscore', 'ia', 'imslp'] as const;
        expect(sourceEnabled('imslp', { sources, parked })).toBe(false);
        expect(sourceEnabled('mutopia', { sources, parked })).toBe(true);
        expect(sourceEnabled('openscore', { sources, parked })).toBe(true);
        expect(sourceEnabled('ia', { sources, parked })).toBe(true);

        const cli = readFileSync(resolve(process.cwd(), 'scripts/seed-playalong-corpus.mjs'), 'utf8');
        expect(cli).toMatch(/res\.status !== 403/);
        expect(cli).toMatch(/classifyImslpResponse\(page\.status, page\.bytes\)/);
        expect(cli).toMatch(/isImslpRippingBan\(\{ status: pdf\.status, body: pdf\.bytes \}\)/);
        expect(cli).toMatch(/imslp_paused_until:/);
        expect(cli).toMatch(/imslp_pause_reason:/);
        expect(cli).not.toMatch(/paused:\s*true/);
        expect(cli).toMatch(/ctx\.parked\.add\('imslp'\)/);
    });

    it('never rotates identity: the UA comes from the environment and a missing contact is flagged', () => {
        expect(crawlerUserAgent({})).toEqual({
            value: 'Cleffy-corpus/1.0 (+https://cleffy.app; contact: unset)',
            contactUnset: true,
        });
        expect(
            crawlerUserAgent({
                IMSLP_CRAWLER_USER_AGENT: 'Cleffy-corpus/1.0 (+https://cleffy.app; contact: max@cleffy.app)',
            }),
        ).toEqual({
            value: 'Cleffy-corpus/1.0 (+https://cleffy.app; contact: max@cleffy.app)',
            contactUnset: false,
        });
        expect(
            crawlerUserAgent({ IMSLP_CRAWLER_USER_AGENT: 'Mozilla/5.0 (pretending to be a browser)' }).contactUnset,
        ).toBe(true);
        const cli = readFileSync(resolve(process.cwd(), 'scripts/seed-playalong-corpus.mjs'), 'utf8');
        expect(cli).toMatch(/IMSLP_CRAWLER\.contactUnset/);
        expect(cli).not.toMatch(/Mozilla\/5\.0/);
    });
});

describe('IMSLP source — the live Edge Function is not part of this', () => {
    it('the seed shares only the pure wait-page helper; imslp-download and _shared/imslp.ts know nothing of the seed', () => {
        const seed = ['scripts/seed-playalong-corpus.mjs', 'scripts/playalong-corpus.mjs'].map((f) =>
            readFileSync(resolve(process.cwd(), f), 'utf8'),
        );
        for (const text of seed) {
            expect(text).not.toMatch(/from\s+['"][^'"]*(imslp-download|_shared\/imslp(\.ts)?)['"]/);
        }
        const edge = readFileSync(resolve(process.cwd(), 'supabase/functions/imslp-download/index.ts'), 'utf8');
        expect(edge).toContain('tryDownloadPdf');
        expect(edge).not.toMatch(/playalong|corpus|IMSLP_CRAWLER_USER_AGENT|imslp_paused|createImslpBreaker/);
        const live = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/imslp.ts'), 'utf8');
        expect(live).not.toMatch(/playalong|corpus|IMSLP_CRAWLER_USER_AGENT|imslp_paused|createImslpBreaker/);
        const shared = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/imslpWaitPage.ts'), 'utf8');
        expect(shared).not.toMatch(/^import /m);
        expect(shared).not.toMatch(/ripping_ban|isImslpRippingBan|classifyImslpResponse/);
        expect(live).not.toMatch(/ripping_ban|isImslpRippingBan|classifyImslpResponse/);
        expect(edge).not.toMatch(/ripping_ban|isImslpRippingBan|classifyImslpResponse/);
    });

    it('records the IMSLP pause on the control row through an idempotent migration', () => {
        const sql = readFileSync(
            resolve(process.cwd(), 'supabase/migrations/20260916190000_playalong_corpus_imslp_pause.sql'),
            'utf8',
        );
        expect(sql).toContain('alter table public.playalong_corpus_control');
        expect(sql).toContain('add column if not exists imslp_paused_until timestamptz');
        expect(sql).toContain('add column if not exists imslp_pause_reason text');
        expect(sql).not.toMatch(/create table|create policy|grant|paused boolean/i);
    });
});
