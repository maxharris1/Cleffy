import { useState } from 'react';

import { ACCOUNT_BODY, ACCOUNT_SUB_HEADING } from '@/features/account/AccountSection';
import { AddToHomeScreenDialog } from '@/features/install/AddToHomeScreenDialog';
import { resolveInstallSurface, type InstallSurface } from '@/features/install/installSurface';
import { useInstallPrompt } from '@/features/install/useInstallPrompt';
import { Button } from '@/ui/Button';

const actionsCopy = (surface: InstallSurface): string => {
    switch (surface) {
        case 'standalone':
            return 'The library is already running as an app on this Home Screen.';
        case 'ios-safari':
        case 'ios-other':
        case 'installable':
        case 'other':
            return 'Put your library on an iPhone or iPad like an app — full screen, Cleffy icon on the Home Screen, no App Store.';
        default: {
            const _never: never = surface;
            return _never;
        }
    }
};

/** Account Preferences cluster: this device’s Home Screen shortcut. */
export const HomeScreenPreferences = () => {
    const { canPromptInstall, promptInstall } = useInstallPrompt();
    const surface = resolveInstallSurface(canPromptInstall);
    const [open, setOpen] = useState(false);

    return (
        <>
            <h3 className={ACCOUNT_SUB_HEADING}>Home screen</h3>
            <p className={`${ACCOUNT_BODY} mt-1`}>{actionsCopy(surface)}</p>
            {surface === 'standalone' ? null : (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button variant="secondary" onClick={() => setOpen(true)}>
                        Add to Home Screen
                    </Button>
                    {canPromptInstall ? (
                        <Button variant="secondary" onClick={() => void promptInstall()}>
                            Add to this device
                        </Button>
                    ) : null}
                </div>
            )}
            {open ? <AddToHomeScreenDialog onClose={() => setOpen(false)} surface={surface} /> : null}
        </>
    );
};
