import { useState } from 'react';

import { AddToHomeScreenDialog } from '@/features/install/AddToHomeScreenDialog';
import { readHomeScreenPromptDismissed, writeHomeScreenPromptDismissed } from '@/features/install/installPrefs';
import { resolveInstallSurface } from '@/features/install/installSurface';
import { Button } from '@/ui/Button';

/**
 * Library-only nudge: iOS Safari, not already installed, and not dismissed.
 * Desktop never sees this — resolveInstallSurface is `other` there.
 */
export const HomeScreenPromptBanner = () => {
    const [dismissed, setDismissed] = useState(readHomeScreenPromptDismissed);
    const [open, setOpen] = useState(false);
    const surface = resolveInstallSurface();

    if (surface !== 'ios-safari' || dismissed) {
        return null;
    }

    const dismiss = () => {
        writeHomeScreenPromptDismissed();
        setDismissed(true);
    };

    return (
        <>
            <div role="status" className="mb-5 rounded-xl border border-stone-200 bg-white/70 px-4 py-3">
                <p className="text-sm text-stone-800">
                    Put your library on this Home Screen like an app — full screen, with the Cleffy icon.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setOpen(true)}>
                        Show me
                    </Button>
                    <Button size="sm" variant="secondary" onClick={dismiss}>
                        Not now
                    </Button>
                </div>
            </div>
            {open ? <AddToHomeScreenDialog onClose={() => setOpen(false)} surface={surface} /> : null}
        </>
    );
};
