import { Fragment } from 'react';
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
    tone?: 'paper' | 'ink';
}

// Same touch hit area as linkClassName: ~44px tall on coarse pointers, text unmoved.
const LINK_BASE =
    'relative transition-colors underline-offset-2 pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3.5';

// On ink the accent is under 3:1, so hover goes to paper instead.
const TONE = {
    paper: { line: 'text-stone-500', link: `${LINK_BASE} hover:text-accent hover:underline` },
    ink: { line: 'text-on-ink-faint', link: `${LINK_BASE} underline hover:text-paper` },
} as const;

const FOOTER_LINKS = [
    { to: '/privacy', label: 'Privacy' },
    { to: '/children-privacy', label: 'Children’s privacy' },
    { to: '/terms', label: 'Terms' },
    { to: '/refunds', label: 'Refunds' },
    { to: '/copyright', label: 'Copyright' },
    // The notice-and-action form (DSA Art. 16): reachable from every page that has this line.
    { to: '/report', label: 'Report content' },
] as const;

/** The quiet "Privacy · Children’s privacy · Terms · Refunds · Copyright · Report content" line used in footers. */
export const LegalLinks = ({
    className = '',
    withContact = false,
    newTab = false,
    tone = 'paper',
}: LegalLinksProps) => {
    const { line, link } = TONE[tone];
    const target = newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {};
    return (
        <p
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-xs pointer-coarse:gap-x-5 pointer-coarse:gap-y-7 ${line} ${className}`}
        >
            {FOOTER_LINKS.map(({ to, label }, index) => (
                <Fragment key={to}>
                    {index > 0 ? <span aria-hidden="true">·</span> : null}
                    <Link to={to} className={link} {...target}>
                        {label}
                    </Link>
                </Fragment>
            ))}
            {withContact ? (
                <>
                    <span aria-hidden="true">·</span>
                    <a href={`mailto:${LEGAL_ENTITY.contactEmail}`} className={link}>
                        {LEGAL_ENTITY.contactEmail}
                    </a>
                </>
            ) : null}
        </p>
    );
};
