import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router';

import { PdfViewport } from '@/features/viewer/PdfViewport';
import { PdfProvider } from '@/features/viewer/pdf/PdfProvider';
import { getLocalDoc, localDocId, putLocalDoc } from '@/lib/localDocs';

export const ViewerPage = () => {
    const { documentId } = useParams<{ documentId: string }>();
    const [, forceRender] = useState(0);

    const bytes = documentId ? getLocalDoc(documentId) : undefined;

    const reopenFile = useCallback(
        async (file: File) => {
            const buffer = await file.arrayBuffer();
            const id = await localDocId(buffer);
            putLocalDoc(id, buffer);
            if (id === documentId) {
                forceRender((n) => n + 1);
            } else {
                // Different file than the one this URL refers to — open it under its own id.
                window.location.assign(`/doc/${id}`);
            }
        },
        [documentId],
    );

    if (!documentId) {
        return null;
    }

    if (!bytes) {
        return (
            <main className="flex min-h-full flex-col items-center justify-center gap-4 p-8">
                <p className="max-w-md text-center text-stone-600">
                    This score isn&apos;t loaded in this session. Re-open the PDF file to continue.
                </p>
                <label className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white shadow hover:bg-indigo-500">
                    Re-open PDF
                    <input
                        type="file"
                        accept="application/pdf,.pdf"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                                void reopenFile(file);
                            }
                        }}
                    />
                </label>
                <Link to="/" className="text-sm text-indigo-600 underline">
                    Back to library
                </Link>
            </main>
        );
    }

    return (
        <div className="fixed inset-0 flex flex-col">
            <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-3 py-2 shadow-sm">
                <Link
                    to="/"
                    aria-label="Back to library"
                    className="rounded px-2 py-1 text-stone-600 hover:bg-stone-100"
                >
                    ←
                </Link>
                <span className="truncate text-sm font-medium text-stone-700">Score {documentId.slice(0, 12)}</span>
            </header>
            <div className="min-h-0 flex-1">
                <PdfProvider data={bytes}>
                    <PdfViewport key={documentId} docId={documentId} />
                </PdfProvider>
            </div>
        </div>
    );
};
