import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createContext, useContext } from 'react';

import type { PageSize } from '@/types/models';

export type PdfStatus = 'loading' | 'ready' | 'error';

export interface PdfContextValue {
    doc: PDFDocumentProxy | null;
    pageSizes: readonly PageSize[];
    status: PdfStatus;
    error: string | null;
}

export const LOADING_VALUE: PdfContextValue = { doc: null, pageSizes: [], status: 'loading', error: null };

export const PdfContext = createContext<PdfContextValue | null>(null);

export const usePdf = (): PdfContextValue => {
    const value = useContext(PdfContext);
    if (!value) {
        throw new Error('usePdf must be used inside <PdfProvider>');
    }
    return value;
};
