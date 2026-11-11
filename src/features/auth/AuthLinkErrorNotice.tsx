import { Link } from 'react-router';

import { authUrlErrorCopy, dismissAuthUrlError, useAuthUrlError } from '@/features/auth/authUrlError';
import { Button } from '@/ui/Button';
import { buttonClassName } from '@/ui/classNames';
import { Dialog } from '@/ui/Dialog';

/**
 * Says why an email link failed, on whichever page it landed — and on the page
 * a gate then redirected to, since the error was captured before any route
 * rendered (authUrlError.ts). Mounted once, inside the router, above the routes.
 */
export const AuthLinkErrorNotice = () => {
    const error = useAuthUrlError();
    if (!error) {
        return null;
    }
    const { title, body } = authUrlErrorCopy(error);
    return (
        <Dialog label={title} onClose={dismissAuthUrlError}>
            <p className="text-sm leading-relaxed text-stone-600">{body}</p>
            <div className="mt-5 flex flex-col gap-2">
                <Link
                    to="/forgot-password"
                    onClick={dismissAuthUrlError}
                    className={buttonClassName('primary', 'md', 'w-full')}
                >
                    Request a new link
                </Link>
                <Button variant="ghost" onClick={dismissAuthUrlError} className="w-full">
                    Not now
                </Button>
            </div>
        </Dialog>
    );
};
