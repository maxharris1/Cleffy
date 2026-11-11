import { useCallback, useState } from 'react';

import { normalizeCountry } from '../../../supabase/functions/_shared/billingTerms';

/**
 * Which country the buyer is in, as far as the storefront is concerned: it
 * picks the currency every price is shown (and charged) in, and it is the
 * country recorded on the consent. Stripe Tax then works out the tax from the
 * billing address the buyer enters on Checkout, and the webhook records that
 * country beside this one.
 *
 * A guess from the browser's language (`en-GB` -> GB) to start with, always
 * shown and always changeable, and remembered on this device once changed.
 */

/** ISO 3166-1 alpha-2, every officially assigned code. Names come from Intl.DisplayNames. */
export const COUNTRY_CODES: readonly string[] = (
    'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
    'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
    'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
    'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO ' +
    'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW ' +
    'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
    'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

const STORAGE_KEY = 'cleffy.billingCountry';

/** The country's English name, or the code where the runtime has no names. */
export const countryName = (code: string): string => {
    try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
    } catch {
        return code;
    }
};

/** The countries sorted by name, for the picker. */
export const countryOptions = (): Array<{ code: string; name: string }> =>
    COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name));

/** The region subtag of the first browser language that has one. */
export const guessCountry = (languages: readonly string[] | undefined): string => {
    for (const language of languages ?? []) {
        const region = language.split(/[-_]/)[1];
        const code = normalizeCountry(region);
        if (code && COUNTRY_CODES.includes(code)) {
            return code;
        }
    }
    return 'US';
};

const readStored = (): string | null => {
    try {
        const stored = normalizeCountry(window.localStorage.getItem(STORAGE_KEY));
        return stored && COUNTRY_CODES.includes(stored) ? stored : null;
    } catch {
        return null;
    }
};

export const initialBillingCountry = (): string =>
    readStored() ?? guessCountry(typeof navigator === 'undefined' ? undefined : navigator.languages);

/** The buyer's country, and a setter that remembers it on this device. */
export const useBillingCountry = (): [string, (country: string) => void] => {
    const [country, setCountry] = useState(initialBillingCountry);
    const choose = useCallback((next: string) => {
        const code = normalizeCountry(next);
        if (!code) {
            return;
        }
        setCountry(code);
        try {
            window.localStorage.setItem(STORAGE_KEY, code);
        } catch {
            // A private window: the choice lasts for this dialog only.
        }
    }, []);
    return [country, choose];
};
