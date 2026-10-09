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
    /**
     * content_rev of the cover published to the `thumbnails` bucket at
     * `{id}/{thumb_rev}.jpg`; null until the owner's browser has rendered one
     * (a fresh upload is content_rev 0, so 0 is a real revision, not "none").
     */
    thumb_rev: number | null;
    created_at: string;
    updated_at: string;
    /** Non-null once the score is over the free cap: read-only, still viewable and exportable. */
    archived_at: string | null;
    /**
     * Why it is archived: 'plan_lapse' (apply_free_tier_archival, undone by
     * restore_plan_archived_scores on resubscribe or an Academy seat) or
     * 'owner'. Null exactly when
     * archived_at is. Server-stamped by the documents_archived_reason trigger --
     * a client value is overwritten -- and optional here because the client's
     * column lists do not select it.
     */
    archived_reason?: ArchivedReason | null;
    // Provenance of an imported score (IMSLP), written only by imslp-download
    // under the service role — clients can neither set nor change it
    // (documents_guard_provenance). Present on a full-row read (`select('*')`,
    // fetchDocument); optional because the library list, library_bootstrap and
    // a cache-synthesized offline row don't carry it. Null for an uploaded PDF
    // and for imports made before provenance was recorded.
    /** The IMSLP work page, e.g. https://imslp.org/wiki/Piano_Sonata_No.14… */
    source_url?: string | null;
    /** The IMSLP file the PDF came from. */
    source_filename?: string | null;
    /** IMSLP's license tag, verbatim, e.g. "Creative Commons Attribution 4.0". */
    source_license?: string | null;
    source_attribution?: DocumentSourceAttribution | null;
};

/** documents.source_attribution — who IMSLP credits for the file (mirrors _shared/imslpProvenance.ts). */
export type DocumentSourceAttribution = {
    source: 'imslp';
    work: string;
    composer: string | null;
    editor: string | null;
    arranger: string | null;
    publisher: string | null;
    year: number | null;
};

export type ArchivedReason = 'plan_lapse' | 'owner';

export type DocumentInsert = {
    id: string;
    owner_id: string;
    title: string;
    storage_path: string;
    page_count?: number | null;
    content_rev?: number;
    thumb_rev?: number | null;
    archived_at?: string | null;
};

/**
 * What an owner may change on a score. id, owner_id, storage_path and
 * created_at are immutable for clients (documents_guard_columns, migration
 * 20261007120100); updated_at is stamped by documents_touch.
 */
export type DocumentUpdate = Partial<
    Pick<DocumentRow, 'title' | 'page_count' | 'content_rev' | 'thumb_rev' | 'archived_at'>
>;

/**
 * A deleted score whose Storage folder may still hold bytes. Written only by
 * the documents AFTER DELETE trigger; the former owner reads it to finish the
 * cleanup and deletes it once the folder is empty.
 */
export type DocumentStorageCleanupRow = {
    document_id: string;
    owner_id: string;
    storage_path: string;
    thumb_rev: number | null;
    deleted_at: string;
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

/**
 * created_by / created_at / updated_at are stamped by the server
 * (document_imports_guard_columns); backup_path may only be null or
 * '{document_id}/pre-import-original.pdf' (CHECK constraint).
 */
export type DocumentImportInsert = {
    document_id: string;
    status: ImportStatusValue;
    backup_path?: string | null;
    pages_cleaned?: number[];
};

export type DocumentImportUpdate = {
    status?: ImportStatusValue;
    backup_path?: string | null;
    pages_cleaned?: number[];
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

/**
 * One row of list_document_members(). Labels are resolved server-side because
 * auth.users is not client-readable; `email`, `joined_via_link` and
 * `is_assigned` are only ever filled for the score's owner (an editor may be a
 * link guest).
 */
export type DocumentMemberListing = {
    user_id: string;
    role: MemberRole;
    /**
     * The caller's own roster name for a student on their roster, else the
     * account's display_name (what presence shows); null when neither is set.
     */
    display_name: string | null;
    email: string | null;
    is_anonymous: boolean;
    /** The member has an assignment on THIS score (owner only; false for everyone else). */
    is_assigned: boolean;
    /** Token of the share link that granted this access, when one did. */
    joined_via_link: string | null;
    joined_at: string;
};

/** The token is always minted by the server (share_links_guard_columns). */
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
    /**
     * Null once the author's account has been deleted: the mark stays on the
     * score it was drawn on (20261007120600_account_deletion.sql). Inserts still
     * always carry the caller's id — RLS requires created_by = auth.uid().
     */
    created_by: string | null;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
    seq: number;
};

/**
 * created_by must be the caller (annotations_insert); created_at is clamped
 * into [the score's created_at, server clock] (annotations_guard_columns).
 * seq / updated_at are server-stamped.
 */
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

/**
 * Everything an editor may change on a mark. id, document_id, page, kind,
 * created_by and created_at are refused by annotations_guard_columns.
 */
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
    /**
     * Ignored: the server stamps the caller (annotation_snapshots_guard_columns),
     * so whatever is sent here — the client sends null — never becomes the author.
     */
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

/** What claim_pdf_export() answers. */
export type PdfExportClaim = {
    ok: boolean;
    count?: number;
    /** -1 on an unlimited plan; absent for an exempt caller. */
    limit?: number;
    /** True when nothing was counted: an unlimited plan, or an exempt caller. */
    unlimited?: boolean;
    tier?: EffectiveTier;
    /** 'anonymous' only from servers predating the guest metering; kept so their answer still types. */
    exempt?: 'anonymous' | 'student';
    /** Set on a share-link guest's claim: the unit, if any, came from the score owner's allowance. */
    billed_to?: 'owner';
    /**
     * The claim id was already answered ok (a retry of the same export), so this
     * answer counted nothing. Since 20261009120100.
     */
    replayed?: boolean;
};

export type Entitlements = {
    user_id: string;
    tier: EffectiveTier;
    status: string | null;
    source: EntitlementSource;
    current_period_end: string | null;
    /**
     * The plan stops at current_period_end instead of renewing (the subscriber
     * cancelled; for an Academy seat, the owner did). Optional because servers
     * before 20261009120101, and entitlements cached from them, do not carry it.
     */
    cancel_at_period_end?: boolean;
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
                Update: DocumentUpdate;
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
            document_storage_cleanup: {
                // Trigger-written tombstones; clients only read and delete them.
                Row: DocumentStorageCleanupRow;
                Insert: never;
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
            // Storage-policy helper: the caller owned this deleted score's folder
            // and has not finished cleaning it up.
            document_storage_cleanup_pending: {
                Args: { folder: string };
                Returns: boolean;
            };
            redeem_share_link: {
                Args: { p_token: string };
                Returns: Array<{ document_id: string; granted_role: MemberRole }>;
            };
            // Owners and editors only; see DocumentMemberListing for what each sees.
            list_document_members: {
                Args: { p_document: string };
                Returns: DocumentMemberListing[];
            };
            // Owner only. The owner's own row can be neither changed nor removed.
            set_document_member_role: {
                Args: { p_document: string; p_user: string; p_role: ShareRole };
                Returns: undefined;
            };
            remove_document_member: {
                Args: { p_document: string; p_user: string };
                Returns: undefined;
            };
            // Any non-owner, for themselves. Refused for a score assigned to a
            // roster student (detail code 'assigned_score').
            leave_document: {
                Args: { p_document: string };
                Returns: undefined;
            };
            // Owner only. Returns how many members' link-granted access was
            // withdrawn (always 0 unless p_remove_members).
            revoke_share_link: {
                Args: { p_token: string; p_remove_members?: boolean };
                Returns: number;
            };
            insert_annotations_batch: {
                Args: { p_rows: AnnotationInsert[] };
                Returns: undefined;
            };
            // Ids of the rows actually updated — a patch RLS filtered out (or
            // whose row does not exist) is missing. Null only from the void
            // function that predates 20261007120200.
            patch_annotations_batch: {
                Args: { p_patches: Array<{ id: string; document_id: string } & AnnotationUpdate> };
                Returns: string[] | null;
            };
            check_edge_rate_limit: {
                Args: { p_key: string; p_limit: number; p_window_ms: number };
                Returns: { ok: boolean; retryAfterSec?: number };
            };
            // Service role only (student-login's per-username limiter, see
            // supabase/functions/_shared/loginThrottle.ts); clients get no EXECUTE.
            // Its table, edge_login_attempts, is service-only like edge_rate_buckets
            // and so not listed under Tables.
            begin_login_attempt: {
                Args: {
                    p_account_key: string;
                    p_source_key: string;
                    p_free_attempts: number;
                    p_base_lock_ms: number;
                    p_max_lock_ms: number;
                    p_decay_ms: number;
                    p_account_limit: number;
                    p_account_window_ms: number;
                };
                Returns:
                    | { ok: true; attempts: number; accountAttempts: number }
                    | { ok: false; retryAfterSec: number; scope: 'source' | 'account' };
            };
            clear_login_attempts: {
                Args: { p_key: string };
                Returns: undefined;
            };
            clear_login_account: {
                Args: { p_account_key: string };
                Returns: number;
            };
            // Service role only: imslp-download closes the shared IMSLP pacing
            // key for IMSLP's Retry-After after a 429.
            edge_rate_block: {
                Args: { p_key: string; p_seconds: number };
                Returns: undefined;
            };
            // p_user is omitted by clients — the function resolves auth.uid() and
            // rejects any attempt to read another user's entitlements.
            get_entitlements: {
                Args: { p_user?: string };
                Returns: Entitlements;
            };
            /** One round-trip for library page + shell entitlements. */
            library_bootstrap: {
                Args: Record<string, never>;
                Returns: {
                    documents: DocumentRow[];
                    has_more: boolean;
                    favorite_ids: string[];
                    tags: LibraryTagRow[];
                    document_tags: Array<{ document_id: string; tag_id: string }>;
                    entitlements: Entitlements;
                };
            };
            /**
             * One keyset page of the caller's visible scores. The cursor is the
             * last row the client holds: (updated_at, id) for 'recent',
             * (title, id) for 'title' — passed back exactly as received.
             */
            library_documents: {
                Args: {
                    p_sort?: 'recent' | 'title';
                    p_after_updated_at?: string | null;
                    p_after_title?: string | null;
                    p_after_id?: string | null;
                    p_query?: string | null;
                    p_tag_id?: string | null;
                    p_favorites_only?: boolean;
                    p_limit?: number;
                };
                Returns: {
                    documents: DocumentRow[];
                    has_more: boolean;
                };
            };
            tier_limits: {
                // Answers for 'student' too, which is why this is EffectiveTier.
                Args: { p_tier: EffectiveTier };
                Returns: EntitlementLimits;
            };
            // Claims one pdf_exports unit before the on-device export is built:
            // check and increment in one statement. The client builds nothing
            // unless this answers ok:true (see features/export/exportClaim.ts).
            // A share-link guest must pass p_document: their export is drawn from
            // that score's owner's allowance. Ignored for a signed-in account.
            claim_pdf_export: {
                /**
                 * p_claim (since 20261009120100) names one export attempt: asked
                 * again by the same caller within the hour it answers ok without
                 * counting again.
                 */
                Args: { p_document?: string; p_claim?: string };
                Returns: PdfExportClaim;
            };
            // Legacy name for claim_pdf_export, kept for bundles already in the
            // field; same body, same answer.
            consume_pdf_export: {
                Args: Record<string, never>;
                Returns: PdfExportClaim;
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
