import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import { localDocId, putLocalDoc } from '@/lib/localDocs';

export const LibraryPage = () => {
    const navigate = useNavigate();
    const [isDragging, setIsDragging] = useState(false);
    const [openError, setOpenError] = useState<string | null>(null);

    const openFile = useCallback(
        async (file: File) => {
            setOpenError(null);
            if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
                setOpenError('Please choose a PDF file.');
                return;
            }
            const buffer = await file.arrayBuffer();
            const id = await localDocId(buffer);
            putLocalDoc(id, buffer);
            navigate(`/doc/${id}`);
        },
        [navigate],
    );

    return (
        <main
            className={`flex min-h-full flex-col items-center justify-center gap-6 p-8 transition-colors ${
                isDragging ? 'bg-indigo-50' : ''
            }`}
            onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const file = e.dataTransfer.files[0];
                if (file) {
                    void openFile(file);
                }
            }}
        >
            <h1 className="text-3xl font-bold text-indigo-700">Sheet Music Scribbler</h1>
            <p className="max-w-md text-center text-stone-600">
                Real-time collaborative sheet music annotation. Open a score, share a link, and annotate together.
            </p>

            <label className="cursor-pointer rounded-lg bg-indigo-600 px-5 py-3 font-medium text-white shadow hover:bg-indigo-500">
                Open a PDF
                <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                            void openFile(file);
                        }
                    }}
                />
            </label>
            <p className="text-sm text-stone-400">…or drag &amp; drop a PDF anywhere on this page</p>
            {openError ? <p className="text-sm text-red-600">{openError}</p> : null}
        </main>
    );
};
