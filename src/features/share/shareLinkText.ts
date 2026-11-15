import type { DeadLinkState } from '@/features/share/linkSession';
import { linkDateText } from '@/features/share/shareService';

/** What a visitor is told about a link that opens nothing. */
export const deadLinkMessage = (state: DeadLinkState, expiredAt: string | null = null): string => {
    switch (state) {
        case 'revoked':
            return 'The owner turned off this link.';
        case 'expired':
            return expiredAt
                ? `This link expired on ${linkDateText(expiredAt)}. Ask the owner to renew it.`
                : 'This link expired. Ask the owner to renew it.';
        case 'invalid':
            return "This link doesn't work. Check you copied all of it.";
        case 'unavailable':
            return "This score isn't available right now.";
    }
};

export const LINK_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/** The token from /s#<token>; null when the fragment holds none. */
export const tokenFromHash = (hash: string): string | null => {
    const raw = hash.replace(/^#/, '');
    return LINK_TOKEN.test(raw) ? raw : null;
};
