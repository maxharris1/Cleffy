import { useEffect, useRef, useState } from 'react';

/** True once the element has entered the viewport; latches (never reverts).
 *  Environments without IntersectionObserver (jsdom) resolve to true immediately
 *  so the finished state renders. */
export const useInViewOnce = <T extends HTMLElement>(threshold = 0.35) => {
    const ref = useRef<T | null>(null);
    // Latched from the first render where there is no observer, rather than
    // from the effect: setState in an effect body is a cascading render (and
    // react-hooks/set-state-in-effect rejects it).
    const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');

    useEffect(() => {
        const node = ref.current;
        if (!node || typeof IntersectionObserver === 'undefined') {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setInView(true);
                    observer.disconnect();
                }
            },
            { threshold },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [threshold]);

    return { ref, inView };
};
