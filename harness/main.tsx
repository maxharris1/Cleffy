import '@/lib/polyfills';
import '@/index.css';

import { useState } from 'react';
import ReactDOM from 'react-dom/client';

import { ShareExportMenu } from '@/features/export/ShareExportMenu';
import { NotesPanel } from '@/features/notes/NotesPanel';
import { ShareDialog } from '@/features/share/ShareDialog';
import { LessonHistoryButton } from '@/features/viewer/history/LessonHistoryButton';
import type { AnnotationStore } from '@/sync/annotationStore';
import { buttonClassName } from '@/ui/classNames';

const view = new URLSearchParams(location.search).get('view') ?? '';
const store = { docId: 'local-fixture', overlayMode: null } as unknown as AnnotationStore;

const Harness = () => {
    const [open, setOpen] = useState(view);
    return (
        <div className="min-h-dvh bg-paper text-ink">
            <header className="flex flex-wrap items-center justify-end gap-1 border-b border-hairline px-3 py-2">
                <span className="mr-auto text-[15px] font-medium">Für Elise (fixture)</span>
                <LessonHistoryButton store={store} canRestore />
                <button type="button" className={buttonClassName('ghost', 'sm')} onClick={() => setOpen('notes')}>Notes</button>
                <ShareExportMenu docId="local-fixture" title="Für Elise" localOnly />
                <button type="button" className={buttonClassName('ghost', 'sm')} onClick={() => setOpen('share-owner')}>Share</button>
            </header>
            {open === 'share-owner' ? <ShareDialog docId="doc-fixture" userId="teacher" role="owner" onClose={() => setOpen('')} /> : null}
            {open === 'share-member' ? <ShareDialog docId="doc-fixture" userId="student" role="editor" onClose={() => setOpen('')} /> : null}
            {open === 'notes' ? <NotesPanel documentId="doc-fixture" role="owner" onClose={() => setOpen('')} /> : null}
        </div>
    );
};

ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />);
