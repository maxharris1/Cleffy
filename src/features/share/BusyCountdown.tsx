import { useEffect, useRef, useState } from 'react';

import { Button } from '@/ui/Button';

/**
 * "Busy, trying again in N s" with Try now: share-session's 429 (too many
 * viewers, or too many requests). Tries by itself when the count reaches 0.
 */
export const BusyCountdown = ({
    retryAfterSec,
    onRetry,
    className = '',
}: {
    retryAfterSec: number;
    onRetry: () => void;
    className?: string;
}) => {
    const [left, setLeft] = useState(retryAfterSec);
    const onRetryRef = useRef(onRetry);

    useEffect(() => {
        onRetryRef.current = onRetry;
    }, [onRetry]);

    useEffect(() => {
        const started = Date.now();
        const timer = setInterval(() => {
            const remaining = Math.max(0, retryAfterSec - Math.floor((Date.now() - started) / 1000));
            setLeft(remaining);
            if (remaining === 0) {
                clearInterval(timer);
                onRetryRef.current();
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [retryAfterSec]);

    return (
        <div role="status" className={`flex flex-wrap items-center justify-center gap-3 ${className}`}>
            <span>Lots of people are on this score right now. Trying again in {left} s.</span>
            <Button size="sm" variant="secondary" onClick={() => onRetryRef.current()}>
                Try now
            </Button>
        </div>
    );
};
