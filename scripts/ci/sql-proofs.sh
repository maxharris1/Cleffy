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
    lane=1
    if [ "$lanes" = 2 ] && [ -n "${LANE2[$name]+x}" ]; then
        lane=2
    fi
    echo "${#proofs[@]} $proof" >>"$work/lane$lane"
    proofs+=("$proof")
done

run_lane() {
    local lane="$1" i proof start rc
    while read -r i proof; do
        echo "lane ${lane}: $(basename "$proof" .sql)"
        start="$(date +%s.%N)"
        rc=0
        bash "$here/sql-proof.sh" "$db" "$proof" >"$work/$i.log" 2>&1 || rc=$?
        echo "$rc $(echo "$(date +%s.%N) - $start" | bc)" >"$work/$i.result"
    done <"$work/lane$lane"
}

failed=""
started="$(date +%s.%N)"
workers=()
for lane in 1 2; do
    if [ -s "$work/lane$lane" ]; then
        run_lane "$lane" &
        workers+=("$lane:$!")
    fi
done
for worker in "${workers[@]}"; do
    status=0
    wait "${worker#*:}" || status=$?
    if [ "$status" != 0 ]; then
        echo "::error::lane ${worker%%:*} worker exited ${status}"
        failed="${failed} lane${worker%%:*}"
    fi
done
elapsed="$(echo "$(date +%s.%N) - $started" | bc)"

for i in "${!proofs[@]}"; do
    echo "::group::${proofs[$i]}"
    cat "$work/$i.log" 2>/dev/null || echo "(no output: the proof never ran)"
    echo "::endgroup::"
done
for i in "${!proofs[@]}"; do
    name="$(basename "${proofs[$i]}" .sql)"
    result="$(cat "$work/$i.result" 2>/dev/null || true)"
    if [[ "$result" =~ ^0\ ([0-9.]+)$ ]]; then
        printf 'PASS %s %.2fs\n' "$name" "${BASH_REMATCH[1]}"
    elif [[ "$result" =~ ^[0-9]+\ ([0-9.]+)$ ]]; then
        printf 'FAIL %s %.2fs\n' "$name" "${BASH_REMATCH[1]}"
        failed="${failed} ${name}"
    else
        printf 'FAIL %s (no result)\n' "$name"
        failed="${failed} ${name}"
    fi
done
printf '%s proofs in %s lane(s): %.2fs\n' "${#proofs[@]}" "$lanes" "$elapsed"

if [ -n "$failed" ]; then
    echo "::error::SQL proofs failed:${failed}"
    exit 1
fi
