import { getSupabase } from '@/lib/supabase';
import { noteLibraryMutationCommitted, noteLibraryMutation } from '@/features/library/libraryCache';
import type { LibraryTagRow } from '@/types/database';

const normalizeTagName = (name: string): string => name.trim().replace(/\s+/g, ' ');

/** User's library tags, A–Z by name. */
export const listLibraryTags = async (): Promise<LibraryTagRow[]> => {
    const { data, error } = await getSupabase()
        .from('library_tags')
        .select('id, user_id, name, created_at')
        .order('name', { ascending: true });
    if (error) {
        throw new Error(`Could not load tags: ${error.message}`);
    }
    return data;
};

export const createLibraryTag = async (userId: string, name: string): Promise<LibraryTagRow> => {
    noteLibraryMutation();
    const trimmed = normalizeTagName(name);
    if (!trimmed) {
        throw new Error('Enter a tag name.');
    }
    const row = {
        id: crypto.randomUUID(),
        user_id: userId,
        name: trimmed,
    };
    const { data, error } = await getSupabase().from('library_tags').insert(row).select('id, user_id, name, created_at').single();
    if (error) {
        if (error.code === '23505') {
            throw new Error(`A tag named “${trimmed}” already exists.`);
        }
        throw new Error(`Could not create tag: ${error.message}`);
    }
    noteLibraryMutationCommitted();
    return data;
};

export const renameLibraryTag = async (tagId: string, name: string): Promise<void> => {
    noteLibraryMutation();
    const trimmed = normalizeTagName(name);
    if (!trimmed) {
        throw new Error('Enter a tag name.');
    }
    const { error } = await getSupabase().from('library_tags').update({ name: trimmed }).eq('id', tagId);
    if (error) {
        if (error.code === '23505') {
            throw new Error(`A tag named “${trimmed}” already exists.`);
        }
        throw new Error(`Could not rename tag: ${error.message}`);
    }
    noteLibraryMutationCommitted();
};

export const deleteLibraryTag = async (tagId: string): Promise<void> => {
    noteLibraryMutation();
    const { error } = await getSupabase().from('library_tags').delete().eq('id', tagId);
    if (error) {
        throw new Error(`Could not delete tag: ${error.message}`);
    }
    noteLibraryMutationCommitted();
};

/** Map of document id → assigned tag ids for the current user. */
export const listDocumentTagMap = async (): Promise<Map<string, string[]>> => {
    const { data, error } = await getSupabase().from('document_tags').select('document_id, tag_id');
    if (error) {
        throw new Error(`Could not load document tags: ${error.message}`);
    }
    const map = new Map<string, string[]>();
    for (const row of data) {
        const list = map.get(row.document_id) ?? [];
        list.push(row.tag_id);
        map.set(row.document_id, list);
    }
    return map;
};

export const setDocumentTag = async (documentId: string, tagId: string, assigned: boolean): Promise<void> => {
    noteLibraryMutation();
    const supabase = getSupabase();
    if (assigned) {
        const { error } = await supabase
            .from('document_tags')
            .upsert(
                { document_id: documentId, tag_id: tagId },
                { onConflict: 'document_id,tag_id', ignoreDuplicates: true },
            );
        if (error) {
            throw new Error(`Could not add tag: ${error.message}`);
        }
        noteLibraryMutationCommitted();
        return;
    }
    const { error } = await supabase.from('document_tags').delete().eq('document_id', documentId).eq('tag_id', tagId);
    if (error) {
        throw new Error(`Could not remove tag: ${error.message}`);
    }
    noteLibraryMutationCommitted();
};
