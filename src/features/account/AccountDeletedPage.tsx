import { Link } from 'react-router';

import { LegalLinks } from '@/features/legal/LegalLinks';
import { BrandShell } from '@/ui/BrandShell';
import { buttonClassName } from '@/ui/classNames';

/**
 * Where a successful account deletion lands. Public, and reached by a full page
 * load (see DeleteAccountSection) so nothing of the deleted account survives in
 * memory: the session, stores and caches were cleared before it navigated here.
 */
export const AccountDeletedPage = () => (
    <BrandShell
        title="Your account is deleted"
        subtitle="Your scores, markings and subscription are gone, and nothing more will be charged. Thank you for using Cleffy."
    >
        <div className="flex flex-col items-center gap-4">
            <Link to="/" className={buttonClassName('primary', 'sm')}>
                Back to home
            </Link>
            <LegalLinks withContact className="justify-center" />
        </div>
    </BrandShell>
);
