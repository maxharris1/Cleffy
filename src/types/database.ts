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

export type MemberRole = 'owner' | 'editor' | 'viewer';
export type ShareRole = 'editor' | 'viewer';

export type DocumentRow = {
    id: string;
    owner_id: string;
    title: string;
    storage_path: string;
    page_count: number | null;
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
    archived_at?: string | null;
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

/** Billing tiers. Founding Teacher is a second price on the Pro product, so it resolves to 'pro'. */
export type BillingTier = 'free' | 'pro' | 'studio';

/** Metered metrics. `cloud_scores` is a stock (live count), the rest are monthly flows. */
export type UsageMetric = 'cloud_scores' | 'omr_runs' | 'vision_reads' | 'smart_imports';

/** Per-metric ceilings; -1 means unlimited. Mirrors public.tier_limits(). */
export type EntitlementLimits = Record<UsageMetric, number>;

/** How the tier was reached: own subscription, a studio seat, or nothing. */
export type EntitlementSource = 'subscription' | 'studio_member' | 'none';

export type Entitlements = {
    user_id: string;
    tier: BillingTier;
    status: string | null;
    source: EntitlementSource;
    current_period_end: string | null;
    limits: EntitlementLimits;
};

export type BillingCustomerRow = {
    user_id: string;
    stripe_customer_id: string;
    created_at: string;
};

export type SubscriptionRow = {
    stripe_subscription_id: string;
    user_id: string;
    tier: BillingTier;
    status: string;
    price_id: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
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

export type UsageCounterRow = {
    user_id: string;
    metric: UsageMetric;
    /** First day of the calendar month, ISO date. */
    month: string;
    count: number;
    updated_at: string;
};

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
                Args: { p_tier: BillingTier };
                Returns: EntitlementLimits;
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
        };
        Enums: Record<string, never>;
        CompositeTypes: Record<string, never>;
    };
};
