import type { DocumentMemberListing, ShareLinkRow } from '../../src/types/database';

export * from '../../src/features/share/shareService';

const DOC = 'doc-fixture';
const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

const LINKS: ShareLinkRow[] = [
    { token: 'k3Xq9TzvLm2PwR8sYb4N', document_id: DOC, role: 'editor', created_by: 'teacher', created_at: day(12), expires_at: new Date(Date.now() + 18 * 86_400_000).toISOString(), revoked_at: null },
    { token: 'Hf7Gd2LqVc5RtW1zMn6P', document_id: DOC, role: 'viewer', created_by: 'teacher', created_at: day(3), expires_at: null, revoked_at: null },
];

const MEMBERS: DocumentMemberListing[] = [
    { user_id: 'teacher', role: 'owner', display_name: 'Ms. Alvarez', email: 'teacher@cleffy.local', is_anonymous: false, is_assigned: false, joined_via_link: null, joined_at: day(30) },
    { user_id: 'student', role: 'editor', display_name: 'Maya Chen', email: 'student@cleffy.local', is_anonymous: false, is_assigned: true, joined_via_link: 'k3Xq9TzvLm2PwR8sYb4N', joined_at: day(11) },
    { user_id: 'guest', role: 'viewer', display_name: null, email: null, is_anonymous: true, is_assigned: false, joined_via_link: 'Hf7Gd2LqVc5RtW1zMn6P', joined_at: day(2) },
];

export const listShareLinks = async (_docId: string) => LINKS;
export const listDocumentMembers = async (_docId: string) => MEMBERS;
