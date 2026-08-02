-- Harden batch annotation RPCs: revoke PUBLIC (and anon) before authenticated grant.
-- Matches check_edge_rate_limit / compact_annotation_tombstones pattern.

revoke all on function public.insert_annotations_batch (jsonb) from public;
revoke all on function public.insert_annotations_batch (jsonb) from anon;
grant execute on function public.insert_annotations_batch (jsonb) to authenticated;

revoke all on function public.patch_annotations_batch (jsonb) from public;
revoke all on function public.patch_annotations_batch (jsonb) from anon;
grant execute on function public.patch_annotations_batch (jsonb) to authenticated;
