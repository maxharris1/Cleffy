#!/usr/bin/env bash
# Run SQL proofs with scripts/ci/sql-proof.sh in 1 or 2 lanes. Every proof
# runs even after one fails, and the run fails at the end. No retries.
#
#   bash scripts/ci/sql-proofs.sh "$DB_URL" 2 tests/sql/*.sql supabase/sql-tests/sharing_access_control.sql
#
# Two lanes split the list on a fixed partition: the proofs named in LANE2
# (about half of the measured wall time), and every other proof, new ones
# included, in lane 1.
set -uo pipefail

db="$1"
lanes="$2"
shift 2

declare -A SKIP=()

declare -A LANE2=(
    [cancel_link_save_after_insert]=1 [cancel_link_tombstone_race]=1
    [storage_quota_lock_concurrency]=1 [storage_thumbnail_concurrency]=1
    [clear_stale_code_reset_markers_race]=1 [share_v2_join_race]=1
    [realtime_revocation_race]=1 [thumbnail_publish_lock_order]=1
    [district_seat_cap]=1 [cancel_link_lifetime]=1 [migrations_ordered_replay]=1
)

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

proofs=()
for proof in "$@"; do
    name="$(basename "$proof" .sql)"
    if [ -n "${SKIP[$name]+x}" ]; then
        echo "::notice file=${proof}::skipped: ${SKIP[$name]}"
        continue
    fi
    proofs+=("$proof")
    lane=1
    if [ "$lanes" = 2 ] && [ -n "${LANE2[$name]+x}" ]; then
        lane=2
    fi
    echo "$proof" >>"$work/lane$lane"
done

run_lane() {
    local lane="$1" proof name start rc
    while read -r proof; do
        name="$(basename "$proof" .sql)"
        echo "lane ${lane}: ${name}"
        start="$(date +%s.%N)"
        rc=0
        bash "$here/sql-proof.sh" "$db" "$proof" >"$work/$name.log" 2>&1 || rc=$?
        echo "$rc $(echo "$(date +%s.%N) - $start" | bc)" >"$work/$name.result"
    done <"$work/lane$lane"
}

started="$(date +%s.%N)"
for lane in 1 2; do
    [ -s "$work/lane$lane" ] && run_lane "$lane" &
done
wait
elapsed="$(echo "$(date +%s.%N) - $started" | bc)"

failed=""
for proof in "${proofs[@]}"; do
    name="$(basename "$proof" .sql)"
    echo "::group::${proof}"
    cat "$work/$name.log"
    echo "::endgroup::"
done
for proof in "${proofs[@]}"; do
    name="$(basename "$proof" .sql)"
    read -r rc seconds <"$work/$name.result"
    if [ "$rc" = 0 ]; then
        printf 'PASS %s %.2fs\n' "$name" "$seconds"
    else
        printf 'FAIL %s %.2fs\n' "$name" "$seconds"
        failed="${failed} ${name}"
    fi
done
printf '%s proofs in %s lane(s): %.2fs\n' "${#proofs[@]}" "$lanes" "$elapsed"

if [ -n "$failed" ]; then
    echo "::error::SQL proofs failed:${failed}"
    exit 1
fi
