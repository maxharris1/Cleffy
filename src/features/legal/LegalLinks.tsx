import { Link } from 'react-router';

import { LEGAL_ENTITY } from '@/features/legal/legalEntity';

interface LegalLinksProps {
    className?: string;
    /** Adds the support address — for surfaces with no other way to reach us. */
    withContact?: boolean;
    /**
     * Open in a new tab. For links inside a flow that must not be lost — the
     * pricing dialog, a half-filled sign-up form.
     */
    newTab?: boolean;
}

const LINK = 'transition hover:text-accent hover:underline underline-offset-2';

/** The quiet "Privacy · Terms" line used in footers and menus. */
export const LegalLinks = ({ className = '', withContact = false, newTab = false }: LegalLinksProps) => {
    const target = newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {};
    return (
        <p className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500 ${className}`}>
            <Link to="/privacy" className={LINK} {...target}>
                Privacy
            </Link>
            <span aria-hidden="true">·</span>
            <Link to="/terms" className={LINK} {...target}>
                Terms
            </Link>
            {withContact ? (
                <>
                    <span aria-hidden="true">·</span>
                    <a href={`mailto:${LEGAL_ENTITY.contactEmail}`} className={LINK}>
                        {LEGAL_ENTITY.contactEmail}
                    </a>
                </>
            ) : null}
        </p>
    );
};
