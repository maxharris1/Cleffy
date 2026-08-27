import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileDropZone } from '@/features/library/FileDropZone';

const pdf = () => new File(['%PDF-1.7'], 'sonata.pdf', { type: 'application/pdf' });

/** jsdom has no DataTransfer; testing-library copies this object onto the event. */
const fileTransfer = (files: File[] = [pdf()]) => ({ files, types: ['Files'] });

const renderZone = (over: { disabled?: boolean; onFile?: (file: File) => void } = {}) => {
    const onFile = over.onFile ?? vi.fn();
    const view = render(
        <FileDropZone disabled={over.disabled ?? false} onFile={onFile}>
            <p>Library</p>
        </FileDropZone>,
    );
    return { onFile, zone: view.getByText('Library').parentElement as HTMLElement };
};

afterEach(() => {
    cleanup();
});

describe('FileDropZone', () => {
    it('shows the drop overlay while a file is over the page', () => {
        const { zone } = renderZone();
        fireEvent.dragEnter(zone, { dataTransfer: fileTransfer() });
        expect(screen.getByText('Drop to upload')).toBeInTheDocument();
    });

    it('hides the overlay when the drag leaves', () => {
        const { zone } = renderZone();
        fireEvent.dragEnter(zone, { dataTransfer: fileTransfer() });
        fireEvent.dragLeave(zone, { dataTransfer: fileTransfer() });
        expect(screen.queryByText('Drop to upload')).not.toBeInTheDocument();
    });

    it('survives crossing a child element (enter/enter/leave keeps it up)', () => {
        // dragenter/dragleave fire per descendant — a plain boolean flickers.
        const { zone } = renderZone();
        fireEvent.dragEnter(zone, { dataTransfer: fileTransfer() });
        fireEvent.dragEnter(screen.getByText('Library'), { dataTransfer: fileTransfer() });
        fireEvent.dragLeave(zone, { dataTransfer: fileTransfer() });
        expect(screen.getByText('Drop to upload')).toBeInTheDocument();
    });

    it('hands the dropped file to onFile and clears the overlay', () => {
        const { zone, onFile } = renderZone();
        const file = pdf();
        fireEvent.dragEnter(zone, { dataTransfer: fileTransfer([file]) });
        fireEvent.drop(zone, { dataTransfer: fileTransfer([file]) });
        expect(onFile).toHaveBeenCalledWith(file);
        expect(screen.queryByText('Drop to upload')).not.toBeInTheDocument();
    });

    it('accepts nothing while an upload is already running', () => {
        const { zone, onFile } = renderZone({ disabled: true });
        fireEvent.dragEnter(zone, { dataTransfer: fileTransfer() });
        expect(screen.queryByText('Drop to upload')).not.toBeInTheDocument();
        fireEvent.drop(zone, { dataTransfer: fileTransfer() });
        expect(onFile).not.toHaveBeenCalled();
    });

    it('ignores drags that carry no files (selected text, links)', () => {
        const { zone } = renderZone();
        fireEvent.dragEnter(zone, { dataTransfer: { files: [], types: ['text/plain'] } });
        expect(screen.queryByText('Drop to upload')).not.toBeInTheDocument();
    });
});
