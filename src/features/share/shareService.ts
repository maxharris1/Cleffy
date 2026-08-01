import { getSupabase } from '@/lib/supabase';
import type { ShareLinkRow, ShareRole } from '@/types/database';

export const createShareLink = async (docId: string, role: ShareRole, createdBy: string): Promise<ShareLinkRow> => {
    const { data, error } = await getSupabase()
        .from('share_links')
        .insert({ document_id: docId, role, created_by: createdBy })
        .select()
        .single();
    if (error) {
        throw new Error(`Could not create share link: ${error.message}`);
    }
    return data;
};

export const listShareLinks = async (docId: string): Promise<ShareLinkRow[]> => {
    const { data, error } = await getSupabase()
        .from('share_links')
        .select('*')
        .eq('document_id', docId)
        .is('revoked_at', null)
        .order('created_at', { ascending: false });
    if (error) {
        throw new Error(`Could not load share links: ${error.message}`);
    }
    return data;
};

export const revokeShareLink = async (token: string): Promise<void> => {
    const { error } = await getSupabase()
        .from('share_links')
        .update({ revoked_at: new Date().toISOString() })
        .eq('token', token);
    if (error) {
        throw new Error(`Could not revoke link: ${error.message}`);
    }
};

export interface RedeemResult {
    documentId: string;
    role: string;
}

/** Join a document via share token (SECURITY DEFINER RPC — see migrations). */
export const redeemShareLink = async (token: string): Promise<RedeemResult> => {
    const { data, error } = await getSupabase().rpc('redeem_share_link', { p_token: token });
    if (error) {
        throw new Error(error.message.includes('invalid or expired') ? 'invalid_link' : error.message);
    }
    const first = data[0];
    if (!first) {
        throw new Error('invalid_link');
    }
    return { documentId: first.document_id, role: first.granted_role };
};

export const shareUrlFor = (token: string): string => {
    return `${window.location.origin}/join/${token}`;
};
