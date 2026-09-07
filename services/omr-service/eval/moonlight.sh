#!/usr/bin/env bash
# Gate the Moonlight Sonata transcription against the Mutopia reference.
#
#   npm run eval:moonlight                      # ScoreData from local Postgres
#   npm run eval:moonlight -- --score out.json  # ScoreData from a file
#   npm run eval:moonlight -- --dir audiveris-out/   # build from Audiveris artifacts first
#
# Postgres mode picks the newest ready analysis whose document title mentions
# "moonlight" (override with EVAL_DOCUMENT_ID). Any further arguments are
# passed to compareToReference.ts (--gate, --json, --record-baseline).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DB_CONTAINER="${EVAL_DB_CONTAINER:-supabase_db_cleffy}"
score_args=()
passthrough=()

while [ $# -gt 0 ]; do
    case "$1" in
        --score)
            score_args=(--score "$2")
            shift 2
            ;;
        --dir)
            tmp="$(mktemp /tmp/moonlight-score.XXXXXX.json)"
            npx tsx eval/buildFromArtifacts.ts --dir "$2" --out "$tmp"
            score_args=(--score "$tmp")
            shift 2
            ;;
        *)
            passthrough+=("$1")
            shift
            ;;
    esac
done

if [ "${#score_args[@]}" -eq 0 ]; then
    if [ -n "${EVAL_DOCUMENT_ID:-}" ]; then
        where="sa.document_id = '${EVAL_DOCUMENT_ID}'"
    else
        where="d.title ilike '%moonlight%'"
    fi
    query="select sa.score::text from public.score_analyses sa
           join public.documents d on d.id = sa.document_id
           where sa.status = 'ready' and sa.score is not null and ${where}
           order by sa.updated_at desc limit 1"
    score_json="$(docker exec "$DB_CONTAINER" psql -U postgres -d postgres -Atc "$query")"
    if [ -z "$score_json" ]; then
        echo "no ready Moonlight analysis in $DB_CONTAINER (set EVAL_DOCUMENT_ID, or pass --score / --dir)" >&2
        exit 2
    fi
    printf '%s' "$score_json" | npx tsx eval/compareToReference.ts --score - "${passthrough[@]}"
else
    npx tsx eval/compareToReference.ts "${score_args[@]}" "${passthrough[@]}"
fi
