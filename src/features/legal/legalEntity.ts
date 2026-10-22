/**
 * Who runs Cleffy and how to reach them.
 *
 * Kept apart from the documents — which all read it — because several
 * always-loaded screens (the library shell, the footer links, the Account page)
 * need the support address, and importing it from a document module would
 * carry the whole Privacy Policy and Terms into the main bundle, defeating the
 * lazy legal routes. Import from here outside src/features/legal.
 */

/** Business details. Change these here and every document follows. */
export const LEGAL_ENTITY = {
    /** The trading name customers see. */
    brand: 'Cleffy',
    /**
     * The contracting party — the trader, controller and service provider every
     * document names. Being formed as a New York LLC (LEGAL_REVIEW.md §1); the
     * documents name it as decided, and stay drafts until it exists.
     */
    name: 'Cleffy LLC',
    legalForm: 'a New York limited liability company',
    address: {
        street: '245 East 37th Street, Apt 3E',
        city: 'New York',
        region: 'NY',
        postalCode: '10016',
        country: 'United States',
    },
    /** One line, for a sentence or an email footer. */
    postalAddress: '245 East 37th Street, Apt 3E, New York, NY 10016, USA',
    emails: {
        /** Copyright and illegal-content notices, authorities' requests, the DSA point of contact. */
        legal: 'legal@cleffy.io',
        /** Data-protection requests. */
        privacy: 'privacy@cleffy.io',
        /** Everything else, including refunds and billing. */
        support: 'support@cleffy.io',
    },
    /**
     * The general address that reaches a human (supabase/functions/resend-inbound).
     * Kept as its own key: screens outside src/features/legal name it.
     */
    contactEmail: 'support@cleffy.io',
    website: 'cleffy.io',
    /**
     * Where the database and file storage are hosted, as Supabase reports it
     * (Project Settings → General → Region) for production.
     */
    dataRegion: 'United States (AWS us-west-2, Oregon)' as string | null,
} as const;
