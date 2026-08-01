import { useParams } from 'react-router';

export const ViewerPage = () => {
    const { documentId } = useParams<{ documentId: string }>();

    return (
        <main className="flex min-h-full items-center justify-center p-8">
            <p className="text-stone-500">Viewer for document {documentId} — coming in M1.</p>
        </main>
    );
};
