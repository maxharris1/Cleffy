#!/usr/bin/env bash
# LANE2 holds about half of the proofs' measured wall time (most of it the
# cancel-link proofs' waits on the database clock), so the lanes end together.
set -uo pipefail

db="$1"
lanes="$2"
shift 2

declare -A SKIP_REASON=()

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
    if [ -n "${SKIP_REASON[$name]+x}" ]; then
        echo "::notice file=${proof}::skipped: ${SKIP_REASON[$name]}"
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
