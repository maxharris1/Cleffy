import { getSupabase } from '@/lib/supabase';
import type { StudioRow } from '@/types/database';

/**
 * Studio seat management. Deliberately minimal: the owner adds teachers by
 * email and every member gets Pro-equivalent entitlements through
 * get_entitlements()'s studio branch.
 *
 * Seat writes all go through SECURITY DEFINER RPCs — studio_members has no
 * client write policy, and the seat limit is a database trigger, so the cap
 * cannot be talked around from here.
 */

export interface StudioSeat {
    userId: string;
    email: string;
}

export const fetchOwnedStudio = async (ownerId: string): Promise<StudioRow | null> => {
    const { data, error } = await getSupabase()
        .from('studios')
        .select('*')
        .eq('owner_id', ownerId)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
    if (error) {
        throw new Error(`Could not load studio: ${error.message}`);
    }
    return data;
};

export const createStudio = async (ownerId: string, name: string): Promise<StudioRow> => {
    const { data, error } = await getSupabase()
        .from('studios')
        .insert({ id: crypto.randomUUID(), owner_id: ownerId, name })
        .select()
        .single();
    if (error) {
        throw new Error(`Could not create studio: ${error.message}`);
    }
    return data;
};

export const fetchStudioSeats = async (studioId: string): Promise<StudioSeat[]> => {
    const { data, error } = await getSupabase().rpc('studio_roster', { p_studio: studioId });
    if (error) {
        throw new Error(`Could not load seats: ${error.message}`);
    }
    return (data ?? []).map((row) => ({ userId: row.user_id, email: row.email }));
};

/**
 * The seats the studio may fill, owner included: 5 on Academy, or a district's
 * contracted count while its invoice-billed subscription is live. The count
 * lives behind a definer RPC because the override that raises it is admin-only.
 */
export const fetchStudioSeatLimit = async (studioId: string): Promise<number> => {
    const { data, error } = await getSupabase().rpc('studio_seat_limit', { p_studio: studioId });
    if (error) {
        throw new Error(`Could not load the seat limit: ${error.message}`);
    }
    return data;
};

/** One seat as the server ranks it: active, or read-only past the studio's limit. */
export interface StudioSeatState {
    active: boolean;
    /** The owner chose it to stay active. */
    kept: boolean;
}

/**
 * Which seats are active, owner only. A studio over its limit -- a district
 * whose override was lowered, cleared or lapsed -- has read-only seats past it.
 */
export const fetchStudioSeatStatus = async (studioId: string): Promise<Map<string, StudioSeatState>> => {
    const { data, error } = await getSupabase().rpc('studio_seat_status', { p_studio: studioId });
    if (error) {
        throw new Error(`Could not load seat status: ${error.message}`);
    }
    return new Map((data ?? []).map((row) => [row.user_id, { active: row.active, kept: row.kept_active }]));
};

/** The owner's pick of seats to keep active; everyone else goes by seniority. */
export const setActiveStudioSeats = async (studioId: string, userIds: string[]): Promise<void> => {
    const { error } = await getSupabase().rpc('studio_set_active_seats', { p_studio: studioId, p_members: userIds });
    if (!error) {
        return;
    }
    if (error.message.includes('seats can be active')) {
        throw new Error('That is more teachers than your seats allow. Untick some first.');
    }
    throw new Error(`Could not save the active seats: ${error.message}`);
};

export const inviteStudioMember = async (studioId: string, email: string): Promise<void> => {
    const { error } = await getSupabase().rpc('studio_invite_member', { p_studio: studioId, p_email: email });
    if (!error) {
        return;
    }
    // The RPC raises structured errors so the UI can say something useful.
    if (error.message.includes('no Cleffy account')) {
        throw new Error('No Cleffy account with that email — ask them to sign up first.');
    }
    if (error.message.includes('seat_limit_reached')) {
        throw new Error('All seats are taken. Remove a teacher first.');
    }
    if (error.message.includes('owner already holds a seat')) {
        throw new Error('You already hold a seat as the studio owner.');
    }
    throw new Error(`Could not add that teacher: ${error.message}`);
};

export const removeStudioMember = async (studioId: string, userId: string): Promise<void> => {
    const { error } = await getSupabase().rpc('studio_remove_member', { p_studio: studioId, p_user: userId });
    if (error) {
        throw new Error(`Could not remove that teacher: ${error.message}`);
    }
};
