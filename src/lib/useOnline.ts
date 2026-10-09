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
