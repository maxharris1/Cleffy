import type { Annotation } from '@/types/models';

/** Local calendar day as YYYY-MM-DD (lesson "starting point" key). */
export const localDateString = (date = new Date()): string => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

export interface LocalAnnotationSnapshot {
    id: string;
    docId: string;
    capturedOn: string;
    label: string | null;
    payload: Annotation[];
    createdAt: string;
    createdBy: string | null;
    /** 1 while not yet upserted to Supabase (cloud docs only). */
    pending: 0 | 1;
}
