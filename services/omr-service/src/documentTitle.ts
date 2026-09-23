import { composerSurnameOf } from './era.js';
import { serviceClient } from './supabaseClient.js';

/**
 * The IMSLP work-page title of a document, or null.
 *
 * `importDocumentFromImslp` stores the work page title ("Nocturnes, Op.9
 * (Chopin, Frédéric)") as `documents.title`; an upload stores its file name.
 * There is no source column, so the "(Last, First)" composer suffix the era
 * lookup already keys on is the discriminator: a title without it is a file
 * name and must not reach discover (a bogus wikitext fetch) or the corpus
 * (a user upload written back as public work).
 */
export const imslpTitleOf = (title: string | null | undefined): string | null => {
    const trimmed = title?.trim();
    if (!trimmed || composerSurnameOf(trimmed) === null) {
        return null;
    }
    return trimmed;
};

/** Sibling of `eraForDocument`: the same `documents.title` select, kept as a work title. */
export const titleForDocument = async (documentId: string): Promise<string | null> => {
    const supabase = serviceClient();
    if (!supabase) {
        return null;
    }
    try {
        const { data, error } = await supabase.from('documents').select('title').eq('id', documentId).maybeSingle();
        if (error) {
            console.warn('[title] lookup failed:', error.message);
            return null;
        }
        const title = (data as { title?: unknown } | null)?.title;
        return imslpTitleOf(typeof title === 'string' ? title : null);
    } catch (err) {
        console.warn('[title] lookup threw:', err instanceof Error ? err.message : err);
        return null;
    }
};
