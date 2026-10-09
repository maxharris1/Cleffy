import { useEffect, useState } from 'react';

/**
 * Chromium's deferred install prompt. Not on the DOM lib in every TS target,
 * and iOS Safari never fires it.
 */
export type BeforeInstallPromptEvent = Event & {
    prompt: () => Promise<void>;
};

export const useInstallPrompt = (): { canPromptInstall: boolean; promptInstall: () => Promise<void> } => {
    const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

    useEffect(() => {
        const onPrompt = (event: Event) => {
            event.preventDefault();
            setDeferred(event as BeforeInstallPromptEvent);
        };
        window.addEventListener('beforeinstallprompt', onPrompt);
        return () => window.removeEventListener('beforeinstallprompt', onPrompt);
    }, []);

    const promptInstall = async () => {
        if (!deferred) {
            return;
        }
        await deferred.prompt();
        setDeferred(null);
    };

    return { canPromptInstall: deferred !== null, promptInstall };
};
