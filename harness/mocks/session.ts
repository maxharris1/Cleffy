import type { Session } from '@supabase/supabase-js';

export * from '../../src/features/auth/session';

const session = { user: { id: 'teacher', email: 'teacher@cleffy.local', is_anonymous: false }, access_token: 'fixture' } as unknown as Session;

export const useSession = () => ({ session, loading: false, lastEvent: null });
