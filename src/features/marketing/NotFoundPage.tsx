import { Link } from 'react-router';

import { BrandShell } from '@/ui/BrandShell';
import { buttonClassName, linkClassName } from '@/ui/classNames';

/** Catch-all 404 — the PWA navigateFallback lands unknown URLs on the SPA, which renders this. */
export const NotFoundPage = () => (
    <BrandShell title="Tacet" subtitle="This page is silent — there's nothing at this address.">
        <div className="flex flex-col items-center gap-4">
            <Link to="/library" className={buttonClassName('primary', 'sm')}>
                Go to your library
            </Link>
            <Link to="/" className={linkClassName}>
                Back to home
            </Link>
        </div>
    </BrandShell>
);
