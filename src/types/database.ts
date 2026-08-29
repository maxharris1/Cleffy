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
    /** Non-null once the score is over the free cap: read-only, still viewable and exportable. */
    archived_at: string | null;
};

export type DocumentInsert = {
    id: string;
    owner_id: string;
    title: string;
    storage_path: string;
    page_count?: number | null;
    content_rev?: number;
    archived_at?: string | null;
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

/**
 * Billing tiers. 'personal' and 'teacher' share the same unlimited ceilings —
 * what separates them is the student roster, which 'personal' has none of.
 * Founding Teacher is a second price on the Teacher product, so it resolves to
 * 'teacher'.
 */
export type BillingTier = 'free' | 'personal' | 'teacher' | 'academy';

/**
 * What an account effectively is. 'student' is a provisioned student account —
 * a real user carrying app_metadata.user_type = 'student' — which is entitled
 * by their teacher and can never be bought, so it is not a BillingTier.
 */
export type EffectiveTier = BillingTier | 'student';

/**
 * Metered metrics. `cloud_scores` and `students` are stocks — live counts taken
 * from the table itself, never written to usage_counters — and the rest are
 * monthly flows.
 */
export type UsageMetric = 'cloud_scores' | 'omr_runs' | 'vision_reads' | 'smart_imports' | 'pdf_exports' | 'students';

/** Per-metric ceilings; -1 means unlimited. Mirrors public.tier_limits(). */
export type EntitlementLimits = Record<UsageMetric, number>;

/**
 * How the tier was reached: own subscription, a seat in someone's Academy, a
 * teacher-provisioned student account, or nothing. The 'studio_member' value
 * keeps the SQL table's name — 'studio' in the database is 'Academy' in the UI.
 */
export type EntitlementSource = 'subscription' | 'studio_member' | 'managed' | 'none';

export type Entitlements = {
    user_id: string;
    tier: EffectiveTier;
    status: string | null;
    source: EntitlementSource;
    current_period_end: string | null;
    limits: EntitlementLimits;
};

/**
 * One row per user PER STRIPE ACCOUNT — `mode` is half the primary key since
 * 20260828180000_billing_stripe_mode.sql. A `cus_…` belongs to exactly one
 * account, so the sandbox customer a teacher picked up on localhost is a second
 * row rather than their live one overwritten.
 */
export type BillingCustomerRow = {
    user_id: string;
    mode: 'live' | 'test';
    stripe_customer_id: string;
    created_at: string;
};

export type SubscriptionRow = {
    stripe_subscription_id: string;
    user_id: string;
    /** The account that sold it. Only the modes `entitling_billing_modes()` names grant a tier. */
    mode: 'live' | 'test';
    tier: BillingTier;
    status: string;
    price_id: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    created_at: string;
    updated_at: string;
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

export type StudioRow = {
    id: string;
    owner_id: string;
    name: string;
    seat_limit: number;
    created_at: string;
};

export type StudioInsert = {
    id: string;
    owner_id: string;
    name: string;
};

export type StudioMemberRow = {
    studio_id: string;
    user_id: string;
    created_at: string;
};

/**
 * A teacher's roster row for one provisioned student. The student account itself
 * is a real auth user — this is the teaching side of it, and archiving a row is
 * what frees the seat it holds against the `students` limit.
 *
 * `auth_method` decides which of the two doors the student came through, and the
 * columns beside it are that door's state: a 'code' student claims a printed
 * setup code once and thereafter signs in with `username`; an 'email' student was
 * invited at `student_email` and signs in with it. `claimed_at` is null until the
 * credential is actually chosen, which is the whole of "Invited" vs "Active" —
 * before it is set no sign-in path exists for the account at all.
 *
 * `login_code_hash` is deliberately absent: the table has it, but `authenticated`
 * holds no SELECT grant on that column (see 20260826194426_roster.sql), because
 * the select policy has a student branch and the hash is of the one-time token
 * that claims the account. Only the student-facing functions read it, under the
 * service role. That is also why the queries below name their columns instead
 * of `*`.
 */
export type ManagedStudentRow = {
    id: string;
    teacher_id: string;
    student_user_id: string;
    display_name: string;
    parent_email: string | null;
    auth_method: 'code' | 'email';
    /** The credential a 'code' student chose; null until they claim. */
    username: string | null;
    /** The student's own address on the 'email' path; null on the code path. */
    student_email: string | null;
    /** Null while Invited; set the moment the student chooses their password. */
    claimed_at: string | null;
    archived_at: string | null;
    created_at: string;
    updated_at: string;
};

/** 'edit' makes the student an editor on the score; 'view' makes them a viewer. */
export type AssignmentAccess = 'edit' | 'view';

export type AssignmentRow = {
    id: string;
    document_id: string;
    student_user_id: string;
    assigned_by: string;
    note: string | null;
    due_at: string | null;
    access: AssignmentAccess;
    created_at: string;
    updated_at: string;
};

/**
 * A teacher's practice journal entry. Private to its author until `shared` is
 * set, which is what lets lesson notes and notes-to-self live in one place.
 */
export type PracticeNoteRow = {
    id: string;
    document_id: string;
    /** Null means a note about the score in general rather than about one student. */
    student_user_id: string | null;
    author_id: string;
    /** ISO date, no time: the lesson day the note belongs to. */
    noted_on: string;
    body: string;
    shared: boolean;
    created_at: string;
    updated_at: string;
};

export type PracticeNoteInsert = {
    id: string;
    document_id: string;
    student_user_id?: string | null;
    author_id: string;
    noted_on?: string;
    body: string;
    shared?: boolean;
};

/** The fields a note's author edits after the fact — never who it is about. */
export type PracticeNoteUpdate = Partial<Pick<PracticeNoteRow, 'body' | 'shared' | 'noted_on'>>;

export type UsageCounterRow = {
    user_id: string;
    /** Flow metrics only — the stocks (`cloud_scores`, `students`) are counted live. */
    metric: UsageMetric;
    /** First day of the calendar month, ISO date. */
    month: string;
    count: number;
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
            // Billing tables are read-only to clients — every write happens in an
            // Edge Function under the service role, or in a SECURITY DEFINER RPC.
            billing_customers: {
                Row: BillingCustomerRow;
                Insert: never;
                Update: never;
                Relationships: [];
            };
            subscriptions: {
                Row: SubscriptionRow;
                Insert: never;
                Update: never;
                Relationships: [];
            };
            usage_counters: {
                Row: UsageCounterRow;
                Insert: never;
                Update: never;
                Relationships: [];
            };
            // The Academy tier's teacher seats. The table names predate the
            // rename and are deliberately unchanged — 'studio' in SQL is
            // 'Academy' everywhere a teacher can see it.
            studios: {
                Row: StudioRow;
                Insert: StudioInsert;
                Update: Partial<Pick<StudioRow, 'name'>>;
                Relationships: [];
            };
            studio_members: {
                // Seats are added/removed via studio_invite_member / studio_remove_member.
                Row: StudioMemberRow;
                Insert: never;
                Update: never;
                Relationships: [];
            };
            managed_students: {
                // The roster. Rows are written by the student-provision Edge
                // Function under the service role — provisioning a student means
                // creating an auth user, which no client may do.
                Row: ManagedStudentRow;
                Insert: never;
                Update: never;
                Relationships: [];
            };
            assignments: {
                // Written through assign_score / unassign_score, which keep the
                // document_members row in step with the assignment.
                Row: AssignmentRow;
                Insert: never;
                Update: never;
                Relationships: [];
            };
            practice_notes: {
                // The one roster table clients write directly: the teacher's own
                // journal, under RLS that keeps it to scores they own.
                Row: PracticeNoteRow;
                Insert: PracticeNoteInsert;
                Update: PracticeNoteUpdate;
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
            // p_user is omitted by clients — the function resolves auth.uid() and
            // rejects any attempt to read another user's entitlements.
            get_entitlements: {
                Args: { p_user?: string };
                Returns: Entitlements;
            };
            tier_limits: {
                // Answers for 'student' too, which is why this is EffectiveTier.
                Args: { p_tier: EffectiveTier };
                Returns: EntitlementLimits;
            };
            // The honest-UI export counter. The export runs on-device, so this is
            // called before it starts and never blocks anything by itself.
            consume_pdf_export: {
                Args: Record<string, never>;
                Returns: { ok: boolean; count?: number; limit?: number; exempt?: 'anonymous' | 'student' };
            };
            // Upserts the assignment AND the document_members row that carries the
            // access, returning the assignment id.
            assign_score: {
                Args: {
                    p_document: string;
                    p_student: string;
                    p_access?: AssignmentAccess;
                    p_note?: string | null;
                    p_due_at?: string | null;
                };
                Returns: string;
            };
            unassign_score: {
                Args: { p_document: string; p_student: string };
                Returns: undefined;
            };
            // Stamps claimed_at on the caller's own roster row — the student is
            // the only one who can say they finished choosing a password, and
            // they hold no write policy on managed_students to say it directly.
            // Takes no arguments: the row is resolved from auth.uid().
            mark_student_claimed: {
                Args: Record<string, never>;
                Returns: undefined;
            };
            document_is_archived: {
                Args: { doc: string };
                Returns: boolean;
            };
            studio_invite_member: {
                Args: { p_studio: string; p_email: string };
                Returns: string;
            };
            studio_remove_member: {
                Args: { p_studio: string; p_user: string };
                Returns: undefined;
            };
            studio_roster: {
                Args: { p_studio: string };
                Returns: Array<{ user_id: string; email: string }>;
            };
            set_document_page_count: {
                Args: { doc: string; pages: number };
                Returns: undefined;
            };
        };
        Enums: Record<string, never>;
        CompositeTypes: Record<string, never>;
    };
};
