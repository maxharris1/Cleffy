#!/usr/bin/env bash
# ac-3: with one outside-service setting unset, doctor.sh exits non-zero and names it.
set -euo pipefail

DOCTOR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/doctor.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf '```qa-lane-settings\nQA_TEST_ALPHA\nQA_TEST_BETA\n```\n' >"$tmp/doc.md"

status=0
out="$(env -u QA_TEST_BETA QA_TEST_ALPHA=placeholder CLEFFY_QA_SETTINGS_DOC="$tmp/doc.md" CLEFFY_QA_LANE_DIR="$tmp/lane" bash "$DOCTOR")" || status=$?
echo "$out"

fail() { echo "FAIL doctor.test.sh: $1"; exit 1; }
[ "$status" -ne 0 ] || fail "doctor.sh exited 0 with QA_TEST_BETA unset"
grep -qx 'FAIL setting QA_TEST_BETA: unset' <<<"$out" || fail "no FAIL line naming QA_TEST_BETA"
grep -qx 'OK setting QA_TEST_ALPHA' <<<"$out" || fail "no OK line for QA_TEST_ALPHA"
grep -q placeholder <<<"$out" && fail "doctor.sh printed a setting's value"
echo "PASS doctor.test.sh"
