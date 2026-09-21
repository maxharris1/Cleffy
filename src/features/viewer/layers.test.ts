import { describe, expect, it } from 'vitest';

import { annotationLayer, annotationVisible, type LayerAudience } from '@/features/viewer/layers';
import { parseDbChange, parseDocumentChange } from '@/sync/wire';
import type { Annotation } from '@/types/models';

const audience = (patch: Partial<LayerAudience>): LayerAudience => ({
    userId: 'me',
    role: 'editor',
    shareStudentLayer: false,
    canUseTeacherLayer: true,
    canShareStudentLayer: false,
    ...patch,
});

const mark = (layer: 'teacher' | 'student' | undefined, createdBy: string | null): Annotation => ({
    id: 'a',
    docId: 'd',
    page: 0,
    kind: 'stroke',
    color: '#111',
    payload: layer ? { pts: [0.1, 0.1, 0.5], w: 0.005, layer } : { pts: [0.1, 0.1, 0.5], w: 0.005 },
    createdBy,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
    deletedAt: null,
    seq: 1,
});

describe('annotation layers', () => {
    it('treats a missing layer as teacher', () => {
        expect(annotationLayer(undefined)).toBe('teacher');
        expect(annotationLayer({})).toBe('teacher');
        expect(annotationLayer({ layer: 'student' })).toBe('student');
    });

    it('lets the owner and a local file see both layers', () => {
        const student = mark('student', 'other');
        expect(annotationVisible(student, audience({ role: 'owner' }))).toBe(true);
        expect(annotationVisible(student, audience({ role: 'local' }))).toBe(true);
    });

    it('shows teacher marks, including unmarked legacy rows, to every member', () => {
        const member = audience({ role: 'viewer' });
        expect(annotationVisible(mark(undefined, 'other'), member)).toBe(true);
        expect(annotationVisible(mark('teacher', 'other'), member)).toBe(true);
    });

    it('shows a student their own marks and hides everyone else’s until the owner shares', () => {
        const member = audience({ role: 'editor', userId: 'me' });
        expect(annotationVisible(mark('student', 'me'), member)).toBe(true);
        expect(annotationVisible(mark('student', null), member)).toBe(true);
        expect(annotationVisible(mark('student', 'other'), member)).toBe(false);
        expect(annotationVisible(mark('student', 'other'), audience({ shareStudentLayer: true }))).toBe(true);
    });

    it('keeps layer and hairpin fields on the wire', () => {
        const row = parseDbChange({
            operation: 'INSERT',
            schema: 'public',
            table: 'annotations',
            record: {
                id: 'h1',
                document_id: 'd',
                page: 0,
                kind: 'shape',
                color: '#111',
                payload: {
                    type: 'hairpin',
                    x1: 0.1,
                    y1: 0.2,
                    x2: 0.4,
                    y2: 0.2,
                    spread: 0.02,
                    open: 'end',
                    layer: 'student',
                },
                created_by: 'me',
                created_at: '2026-09-21T00:00:00.000Z',
                updated_at: '2026-09-21T00:00:00.000Z',
                deleted_at: null,
                seq: 3,
            },
        });
        expect(row?.kind).toBe('shape');
        expect(row?.payload).toMatchObject({ type: 'hairpin', layer: 'student', open: 'end' });
    });

    it('reads a student-layer share off a document broadcast', () => {
        expect(
            parseDocumentChange({
                table: 'documents',
                record: { id: 'd', content_rev: 2, share_student_layer: true },
            })?.share_student_layer,
        ).toBe(true);
    });
});
