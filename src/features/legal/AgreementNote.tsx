import { linkClassName } from '@/ui/classNames';

interface AgreementNoteProps {
    /** What the person is about to do, completing "By … you agree": "creating an account". */
    action: string;
    className?: string;
}

// No wrap on touch: a link split across two lines can't carry linkClassName's enlarged hit area.
const LINK = `${linkClassName} text-xs pointer-coarse:whitespace-nowrap`;

/**
 * "By creating an account you agree to the Terms of Service and Privacy Policy."
 *
 * Shown next to every control that creates an account or a paid relationship.
 * The links open in a new tab: they sit beside a half-filled form or an open
 * pricing dialog, and following one must not throw that away. Plain anchors
 * rather than router Links for the same reason — a new tab is a full page load
 * either way, and this way the note needs no router above it (the pricing
 * dialog is mounted from places that have none in tests).
 */
export const AgreementNote = ({ action, className = '' }: AgreementNoteProps) => (
    // Looser lines on touch so the two links' enlarged hit areas don't cover each other when they stack.
    <p className={`text-xs leading-relaxed text-stone-500 pointer-coarse:leading-8 ${className}`}>
        By {action} you agree to the{' '}
        <a href="/terms" target="_blank" rel="noopener noreferrer" className={LINK}>
            Terms of Service
        </a>{' '}
        and{' '}
        <a href="/privacy" target="_blank" rel="noopener noreferrer" className={LINK}>
            Privacy Policy
        </a>
        .
    </p>
);
