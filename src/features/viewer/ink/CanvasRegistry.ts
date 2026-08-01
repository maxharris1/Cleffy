export interface PageCanvases {
    committed: HTMLCanvasElement;
    live: HTMLCanvasElement;
}

/**
 * Rendezvous between React (PageView mounts/unmounts canvases) and the
 * imperative ink layer (InkController paints them). Framework-free and
 * created during render, so components can hold it as a stable prop.
 */
export class CanvasRegistry {
    private pages = new Map<number, PageCanvases>();
    private listeners = new Set<(pageIndex: number) => void>();

    register(pageIndex: number, canvases: PageCanvases): void {
        this.pages.set(pageIndex, canvases);
        for (const listener of this.listeners) {
            listener(pageIndex);
        }
    }

    unregister(pageIndex: number): void {
        this.pages.delete(pageIndex);
    }

    get(pageIndex: number): PageCanvases | undefined {
        return this.pages.get(pageIndex);
    }

    /** Notified after a page's canvases (re)register — repaint hook. */
    onRegister(listener: (pageIndex: number) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    clear(): void {
        this.pages.clear();
        this.listeners.clear();
    }
}
