/**
 * Hand-authored Supabase schema types (mirrors supabase/migrations — keep in
 * lockstep). Regenerate-with-CLI is preferred once network access to the
 * project exists; until then this file is the typed boundary.
 *
 * NOTE: these MUST be `type` aliases, not interfaces — interfaces lack
 * implicit index signatures and fail postgrest-js's Record<string, unknown>
 * schema constraint, silently collapsing every query type to `never`.
 */

import type { Annotation, AnnotationKind, AnnotationPayload } from '@/types/models';
import type { ScoreData } from '@/types/scoreData';

export type MemberRole = 'owner' | 'editor' | 'viewer';
export type ShareRole = 'editor' | 'viewer';

export type DocumentRow = {
    id: string;
    owner_id: string;
    title: string;
    storage_path: string;
    page_count: number | null;
    /** Bumped when the stored PDF bytes are replaced (smart import cleanup). */
    content_rev: number;
    created_at: string;
    updated_at: string;
};

export type DocumentInsert = {
    id: string;
    owner_id: string;
    title: string;
    storage_path: string;
    page_count?: number | null;
    content_rev?: number;
};

export type ImportStatusValue = 'prompted' | 'declined' | 'imported';

export type DocumentImportRow = {
    document_id: string;
    status: ImportStatusValue;
    backup_path: string | null;
    pages_cleaned: number[];
    created_by: string | null;
    created_at: string;
    updated_at: string;
};

export type DocumentImportInsert = {
    document_id: string;
    status: ImportStatusValue;
    backup_path?: string | null;
    pages_cleaned?: number[];
    created_by?: string | null;
};

export type DocumentImportUpdate = {
    status?: ImportStatusValue;
    backup_path?: string | null;
    pages_cleaned?: number[];
    updated_at?: string;
};

export type DocumentMemberRow = {
    document_id: string;
    user_id: string;
    role: MemberRole;
    created_at: string;
};

export type DocumentFavoriteRow = {
    document_id: string;
    user_id: string;
    created_at: string;
};

export type DocumentFavoriteInsert = {
    document_id: string;
    user_id: string;
};

export type LibraryTagRow = {
    id: string;
    user_id: string;
    name: string;
    created_at: string;
};

export type LibraryTagInsert = {
    id: string;
    user_id: string;
    name: string;
};

export type DocumentTagRow = {
    document_id: string;
    tag_id: string;
    created_at: string;
};

export type DocumentTagInsert = {
    document_id: string;
    tag_id: string;
};

export type ShareLinkRow = {
    token: string;
    document_id: string;
    role: ShareRole;
    created_by: string;
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
};

export type ShareLinkInsert = {
    document_id: string;
    role: ShareRole;
    created_by: string;
    expires_at?: string | null;
};

export type AnnotationRow = {
    id: string;
    document_id: string;
    page: number;
    kind: AnnotationKind;
    color: string;
    payload: AnnotationPayload;
    created_by: string;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
    seq: number;
};

export type AnnotationInsert = {
    id: string;
    document_id: string;
    page: number;
    kind: AnnotationKind;
    color: string;
    payload: AnnotationPayload;
    created_by: string;
    created_at?: string;
    deleted_at?: string | null;
};

export type AnnotationUpdate = {
    color?: string;
    payload?: AnnotationPayload;
    deleted_at?: string | null;
};

export type AnnotationSnapshotRow = {
    id: string;
    document_id: string;
    captured_on: string;
    label: string | null;
    payload: Annotation[];
    created_at: string;
    created_by: string | null;
};

export type AnnotationSnapshotInsert = {
    id: string;
    document_id: string;
    captured_on: string;
    label?: string | null;
    payload: Annotation[];
    created_by?: string | null;
};

export type ScoreAnalysisStatus = 'pending' | 'processing' | 'ready' | 'failed';

export type ScoreAnalysisRow = {
    document_id: string;
    status: ScoreAnalysisStatus;
    /** Machine error code (services/omr-service/src/errors.ts taxonomy). */
    error: string | null;
    /** Pages processed so far (OMR service heartbeat). */
    progress: number | null;
    engine_version: string | null;
    bpm_default: number | null;
    score: ScoreData | null;
    created_by: string | null;
    created_at: string;
    updated_at: string;
};

export type ScoreAnalysisInsert = {
    document_id: string;
    status: ScoreAnalysisStatus;
    error?: string | null;
    progress?: number | null;
    engine_version?: string | null;
    bpm_default?: number | null;
    score?: ScoreData | null;
    created_by?: string | null;
};

export type ScoreAnalysisUpdate = Partial<Omit<ScoreAnalysisInsert, 'document_id'>>;

export type Database = {
    public: {
        Tables: {
            documents: {
                Row: DocumentRow;
                Insert: DocumentInsert;
                Update: Partial<DocumentInsert>;
                Relationships: [];
            };
            document_members: {
                // Client code never writes memberships (SECURITY DEFINER paths only);
                // RLS enforces it — the types just mirror the table.
                Row: DocumentMemberRow;
                Insert: DocumentMemberRow;
                Update: Partial<DocumentMemberRow>;
                Relationships: [];
            };
            document_favorites: {
                // Per-user favorites (a flag on documents would be shared state).
                Row: DocumentFavoriteRow;
                Insert: DocumentFavoriteInsert;
                Update: never;
                Relationships: [];
            };
            library_tags: {
                Row: LibraryTagRow;
                Insert: LibraryTagInsert;
                Update: Partial<Pick<LibraryTagRow, 'name'>>;
                Relationships: [];
            };
            document_tags: {
                Row: DocumentTagRow;
                Insert: DocumentTagInsert;
                Update: never;
                Relationships: [];
            };
            document_imports: {
                // Smart-import offer/decision + backup pointer, one row per doc.
                Row: DocumentImportRow;
                Insert: DocumentImportInsert;
                Update: DocumentImportUpdate;
                Relationships: [];
            };
            share_links: {
                Row: ShareLinkRow;
                Insert: ShareLinkInsert;
                Update: Partial<Pick<ShareLinkRow, 'revoked_at' | 'expires_at'>>;
                Relationships: [];
            };
            annotations: {
                Row: AnnotationRow;
                Insert: AnnotationInsert;
                Update: AnnotationUpdate;
                Relationships: [];
            };
            annotation_snapshots: {
                Row: AnnotationSnapshotRow;
                Insert: AnnotationSnapshotInsert;
                Update: never;
                Relationships: [];
            };
            score_analyses: {
                Row: ScoreAnalysisRow;
                Insert: ScoreAnalysisInsert;
                Update: ScoreAnalysisUpdate;
                Relationships: [];
            };
        };
        Views: Record<string, never>;
        Functions: {
            document_role: {
                Args: { doc: string };
                Returns: MemberRole | null;
            };
            redeem_share_link: {
                Args: { p_token: string };
                Returns: Array<{ document_id: string; granted_role: MemberRole }>;
            };
            insert_annotations_batch: {
                Args: { p_rows: AnnotationInsert[] };
                Returns: undefined;
            };
            patch_annotations_batch: {
                Args: { p_patches: Array<{ id: string; document_id: string } & AnnotationUpdate> };
                Returns: undefined;
            };
            check_edge_rate_limit: {
                Args: { p_key: string; p_limit: number; p_window_ms: number };
                Returns: { ok: boolean; retryAfterSec?: number };
            };
        };
        Enums: Record<string, never>;
        CompositeTypes: Record<string, never>;
    };
};
