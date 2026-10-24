import { Link } from 'react-router';

// The footer link treatment LegalLinks uses: ~44px tall on coarse pointers, text unmoved.
const LINK =
    'relative transition-colors hover:text-accent hover:underline underline-offset-2 pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3.5';

/**
 * "Cancel subscription" for every footer, signed in or not: /cancel needs no
 * account (CancelPage). Kept beside LegalLinks rather than inside it while the
 * legal-pages work restructures that component; fold it in once both land.
 */
export const CancelSubscriptionLink = ({ className = '' }: { className?: string }) => (
    <p className={`text-xs text-stone-500 ${className}`}>
        <Link to="/cancel" className={LINK}>
            Cancel subscription
        </Link>
    </p>
);
