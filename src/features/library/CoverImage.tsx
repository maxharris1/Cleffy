import { useEffect, useRef, useState, type ReactNode } from 'react';

import { noteCoverShown, wasCoverShown } from '@/features/library/shownCovers';

/** Where the browser cannot say when an image has decoded, there is nothing to wait for. */
const canDecode = (): boolean => typeof HTMLImageElement !== 'undefined' && 'decode' in HTMLImageElement.prototype;

/**
 * A score's engraved cover, fading in over its placeholder once it has
 * decoded, instead of popping over it whenever the blob happened to land.
 *
 * The placeholder stays underneath until the fade is over, then goes (a shelf
 * of engraved stand-ins nobody can see is work for nothing). Opacity only,
 * 200ms on the ease-out curve (150ms under reduced motion): no scale, which
 * would shimmer across a shelf of two hundred covers (index.css,
 * .cover-fade). A cover this page has shown before — the library, a score,
 * back again — is settled: it appears without the fade, as it did before.
 */
export const CoverImage = ({
    src,
    cacheKey,
    placeholder,
    className = '',
}: {
    src: string;
    /** The score and revision this cover is of. */
    cacheKey: string;
    /** What showed before the cover arrived, kept under it while it fades in. */
    placeholder?: ReactNode;
    className?: string;
}) => {
    const [settled] = useState(() => wasCoverShown(cacheKey) || !canDecode());
    const [loaded, setLoaded] = useState(settled);
    const [faded, setFaded] = useState(settled);
    const imgRef = useRef<HTMLImageElement | null>(null);

    useEffect(() => {
        const img = imgRef.current;
        if (settled || !img) {
            return;
        }
        let current = true;
        // Shown once it is revealed, not on mount: a cover unmounted before
        // it decoded was never seen, and fades in when it comes back.
        const reveal = () => {
            if (current) {
                noteCoverShown(cacheKey);
                setLoaded(true);
            }
        };
        // A cover that fails to decode is still revealed: the broken image
        // is the truth, and the placeholder would otherwise sit there forever.
        img.decode().then(reveal, reveal);
        return () => {
            current = false;
        };
    }, [src, cacheKey, settled]);

    return (
        <>
            {faded ? null : placeholder}
            <img
                ref={imgRef}
                src={src}
                alt=""
                data-loaded={loaded || undefined}
                data-settled={settled || undefined}
                onTransitionEnd={(event) => {
                    if (event.propertyName === 'opacity') {
                        setFaded(true);
                    }
                }}
                className={`cover-fade${className ? ` ${className}` : ''}`}
            />
        </>
    );
};
