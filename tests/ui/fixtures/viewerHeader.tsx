import '@/index.css';

import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

import { ShareExportMenu } from '@/features/export/ShareExportMenu';
import { LessonHistoryButton } from '@/features/viewer/history/LessonHistoryButton';
import { PresenceBar } from '@/features/viewer/presence/PresenceBar';
import { ScoreSourceButton } from '@/features/viewer/ScoreSourceButton';
import { StandModeButton } from '@/features/viewer/stand/StandOverlay';
import { ViewerHeader } from '@/features/viewer/ViewerHeader';
import { SyncDot } from '@/features/viewer/ViewerPage';
import type { DocumentRow } from '@/types/database';
import type { AnnotationStore } from '@/sync/annotationStore';
import type { PresencePeer } from '@/sync/wire';
import { Button } from '@/ui/Button';
import { buttonClassName } from '@/ui/classNames';
import { INK_TEXT_ACTION } from '@/ui/onInk';

const params = new URLSearchParams(location.search);
const names = params.getAll('name');
const count = Number(params.get('count'));
const source = params.get('source') === '1';

const peers: PresencePeer[] = Array.from({ length: count }, (_, i) => ({
    userId: `peer-${i}`,
    name: names[i] ?? `Person Number ${String(i).padStart(2, '0')} Here`,
    color: '#c2410c',
    page: i,
    isAnonymous: false,
}));

const doc = {
    id: 'doc-1',
    title: 'Sonata in C — Allegro',
    source_url: source ? 'https://imslp.org/wiki/File:Example.pdf' : null,
    source_filename: null,
    source_license: source ? 'Public Domain' : null,
    source_attribution: null,
} as unknown as DocumentRow;

createRoot(document.getElementById('root')!).render(
    <MemoryRouter>
        <ViewerHeader
            backTo="/"
            backLabel="Back to library"
            title={doc.title}
            primary={
                <Button variant="inkPrimary" size="sm" className="lg:rounded-xl lg:px-[18px] lg:text-[15px]">
                    Share
                </Button>
            }
        >
            <StandModeButton />
            <PresenceBar peers={peers} selfUserId="me" />
            <SyncDot status="synced" />
            <LessonHistoryButton store={{} as AnnotationStore} canRestore />
            <button type="button" className={buttonClassName('inkGhost', 'sm', INK_TEXT_ACTION)}>
                Notes
            </button>
            <ScoreSourceButton doc={doc} />
            <ShareExportMenu docId={doc.id} doc={doc} role="owner" title={doc.title} />
        </ViewerHeader>
    </MemoryRouter>,
);
