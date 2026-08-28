import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';

/**
 * Drop target for uploading a score by dragging it onto the page.
 *
 * Two details carry the behaviour:
 *  - a depth counter, because dragenter/dragleave fire for every descendant
 *    the pointer crosses; a plain boolean flickers off over child elements.
 *  - window-level preventDefault on dragover/drop, because a file dropped
 *    anywhere OUTSIDE the zone makes the browser navigate to it, silently
 *    replacing the SPA (and losing unsynced work) with a raw PDF.
 */
export const FileDropZone = ({
    disabled,
    onFile,
    children,
}: {
    disabled: boolean;
    onFile: (file: File) => void;
    children: ReactNode;
}) => {
    const depth = useRef(0);
    const [active, setActive] = useState(false);

    useEffect(() => {
        const swallow = (e: Event) => {
            e.preventDefault();
        };
        window.addEventListener('dragover', swallow);
        window.addEventListener('drop', swallow);
        return () => {
            window.removeEventListener('dragover', swallow);
            window.removeEventListener('drop', swallow);
        };
    }, []);

    /** Text and links drag around inside the page constantly — only files count. */
    const hasFiles = (dt: DataTransfer | null): boolean => dt !== null && Array.from(dt.types).includes('Files');

    const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
        if (!hasFiles(e.dataTransfer)) {
            return;
        }
        depth.current += 1;
        setActive(true);
    };

    const onDragOver = (e: DragEvent<HTMLDivElement>) => {
        if (!hasFiles(e.dataTransfer)) {
            return;
        }
        // Without this the drop event never fires at all.
        e.preventDefault();
        e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    };

    const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
        if (!hasFiles(e.dataTransfer)) {
            return;
        }
        depth.current -= 1;
        if (depth.current <= 0) {
            depth.current = 0;
            setActive(false);
        }
    };

    const onDrop = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        depth.current = 0;
        setActive(false);
        if (disabled) {
            return;
        }
        const file = e.dataTransfer?.files[0];
        if (file) {
            onFile(file);
        }
    };

    return (
        <div
            className="relative"
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            {children}
            {active && !disabled ? (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent-soft backdrop-blur-[2px]">
                    <div className="text-center">
                        <p className="font-medium text-accent">Drop to upload</p>
                        <p className="mt-1 text-xs text-stone-600">PDF or photo of a score</p>
                    </div>
                </div>
            ) : null}
        </div>
    );
};
