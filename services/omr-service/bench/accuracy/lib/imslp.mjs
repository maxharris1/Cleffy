/**
 * IMSLP PDF download for the benchmark corpus (public-domain scans).
 *
 * The site gates downloads behind three cosmetic steps, all reproducible
 * without a browser (verified 2026-09-04):
 *   1. a JS "friendly redirect" that only wants a `redirectPassed=1` cookie;
 *   2. the copyright disclaimer, accepted by GET-ing
 *      `Special:IMSLPDisclaimerAccept/<file>` (sets `imslpdisclaimeraccepted`);
 *   3. a 15 s wait page whose `#sm_dl_wait[data-id]` carries the CDN URL
 *      (main mirrors), or — for EU-hosted files — an `IMSLP-EU` page linking
 *      `/files/imglnks/euimg/...`, served from imslp.eu.
 * The same shape as `supabase/functions/_shared/imslp.ts`, plus the cookie
 * and EU handling that the edge function does not need.
 */

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36 cleffy-bench';
const ORIGIN = 'https://imslp.org';
const EU_ORIGIN = 'https://imslp.eu';

class CookieJar {
    constructor() {
        this.cookies = new Map([['redirectPassed', '1']]);
    }

    absorb(res) {
        const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        for (const raw of setCookies) {
            const [pair] = raw.split(';');
            const eq = pair.indexOf('=');
            if (eq > 0) {
                this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            }
        }
    }

    header() {
        return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
}

const fetchFollowing = async (url, jar, accept) => {
    let current = url;
    for (let hop = 0; hop < 8; hop++) {
        const res = await fetch(current, {
            headers: { 'User-Agent': UA, Accept: accept, Cookie: jar.header() },
            redirect: 'manual',
            signal: AbortSignal.timeout(300_000),
        });
        jar.absorb(res);
        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (!location) {
                throw new Error(`redirect without location from ${current}`);
            }
            current = new URL(location, current).toString();
            continue;
        }
        return { res, url: current };
    }
    throw new Error(`too many redirects for ${url}`);
};

const decodeEntities = (s) => s.replace(/&#58;/g, ':').replace(/&amp;/g, '&').replace(/&#38;/g, '&');

/** Download one IMSLP file (as named on the work page, e.g. `PMLP01969-Chopin 10-3.pdf`). */
export const downloadImslpPdf = async (filename) => {
    const jar = new CookieJar();
    const wikiName = encodeURIComponent(filename.replace(/ /g, '_'));
    const accept = 'application/pdf,text/html,*/*';
    let { res, url } = await fetchFollowing(`${ORIGIN}/wiki/Special:IMSLPDisclaimerAccept/${wikiName}`, jar, accept);
    let bytes = Buffer.from(await res.arrayBuffer());
    if (isPdf(bytes)) {
        return bytes;
    }
    const html = bytes.toString('utf8');
    if (/bot check|mtcaptcha/i.test(html)) {
        throw new Error(`IMSLP bot check for ${filename}`);
    }
    const wait = /id="sm_dl_wait"[^>]*data-id="([^"]+)"/i.exec(html);
    const eu = /href="(\/files\/imglnks\/euimg\/[^"]+)"/i.exec(html);
    let cdn = null;
    if (wait?.[1]) {
        cdn = decodeEntities(wait[1]);
    } else if (eu?.[1]) {
        cdn = `${EU_ORIGIN}${decodeEntities(eu[1])}`;
    }
    if (!cdn) {
        throw new Error(`IMSLP: no download link found for ${filename} (landed on ${url})`);
    }
    ({ res } = await fetchFollowing(cdn, jar, 'application/pdf,*/*'));
    bytes = Buffer.from(await res.arrayBuffer());
    if (!isPdf(bytes)) {
        throw new Error(`IMSLP: CDN returned non-PDF for ${filename} (${res.headers.get('content-type')})`);
    }
    return bytes;
};

export const isPdf = (bytes) => bytes.length > 4 && bytes.subarray(0, 4).toString('latin1') === '%PDF';
