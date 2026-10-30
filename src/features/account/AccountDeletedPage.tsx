import { Link, useSearchParams } from 'react-router';

import { LegalLinks } from '@/features/legal/LegalLinks';
import { BrandShell } from '@/ui/BrandShell';
import { buttonClassName } from '@/ui/classNames';

/**
 * Where a successful account deletion lands. Public, and reached by a full page
 * load (see DeleteAccountSection) so nothing of the deleted account survives in
 * memory: the session, stores and caches were cleared before it navigated here.
 *
 * `?guest=1` is a share-link guest who deleted their guest profile from the
 * score's Sharing panel (GUEST_DELETED_PATH): they had no scores or
 * subscription of their own, so the account wording would not be true of them.
 */
export const AccountDeletedPage = () => {
    const [params] = useSearchParams();
    const guest = params.get('guest') === '1';
    return (
        <BrandShell
            title={guest ? 'Your guest profile is deleted' : 'Your account is deleted'}
            subtitle={
                guest
                    ? 'You have been removed from every score shared with you, and this device has forgotten you. Marks you made stay on those scores. Thank you for using Cleffy.'
                    : 'Your scores, markings and subscription are gone, and nothing more will be charged. Thank you for using Cleffy.'
            }
        >
            <div className="flex flex-col items-center gap-4">
                <Link to="/" className={buttonClassName('primary', 'sm')}>
                    Back to home
                </Link>
                <LegalLinks withContact className="justify-center" />
            </div>
        </BrandShell>
    );
};
