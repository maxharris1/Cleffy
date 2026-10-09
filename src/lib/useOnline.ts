import { useEffect, useState } from 'react';

/** Is the browser online? Follows the online/offline events. */
export const useOnline = (): boolean => {
    const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
    useEffect(() => {
        const update = () => setOnline(navigator.onLine !== false);
        window.addEventListener('online', update);
        window.addEventListener('offline', update);
        return () => {
            window.removeEventListener('online', update);
            window.removeEventListener('offline', update);
        };
    }, []);
    return online;
};

/**
 * A request that never reached the server (offline, DNS, a dropped
 * connection) rather than one the server answered with an error. Browsers
 * word it differently: Chrome "Failed to fetch", Firefox "NetworkError when
 * attempting to fetch resource", Safari "Load failed".
 *
 * Not the same as being offline: a blocker or an outage fails the same way
 * while the browser is online, and no 'online' event will follow. Only
 * navigator.onLine === false justifies telling the user they are offline.
 */
export const isTransportFailure = (err: unknown): boolean => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return true;
    }
    if (err instanceof TypeError) {
        return true;
    }
    return (
        err instanceof Error &&
        /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(err.message)
    );
};
