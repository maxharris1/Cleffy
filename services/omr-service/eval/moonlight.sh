#!/usr/bin/env bash
# Moonlight diagnostic — per-bar pitch recall against the Mutopia reference.
# This is not the corpus eval CLI (that lives in src/eval/ on the
# omr-accuracy-eval branch). Exit 0 when every *gated* movement in
# fixtures/moonlight/boundaries.json meets the pitch-recall bar. II and III
# are report-only on the committed baseline.
#
#   npm run eval:moonlight -- --score out.json
#   npm run eval:moonlight -- --dir audiveris-out/
#   EVAL_DOCUMENT_ID=<uuid> npm run eval:moonlight   # local Postgres, UUID required
#
# Further arguments are passed to compareToReference.ts (--gate, --json, --record-baseline).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DB_CONTAINER="${EVAL_DB_CONTAINER:-supabase_db_cleffy}"
UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
score_args=()
passthrough=()

while [ $# -gt 0 ]; do
    case "$1" in
        --score)
            score_args=(--score "$2")
            shift 2
            ;;
        --dir)
            if [ -z "${2:-}" ] || [ ! -d "$2" ]; then
                echo "--dir must be an existing directory" >&2
                exit 2
            fi
            dir="$(cd "$2" && pwd)"
            tmp="$(mktemp /tmp/moonlight-score.XXXXXX.json)"
            npx tsx eval/buildFromArtifacts.ts --dir "$dir" --out "$tmp"
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
    if [ -z "${EVAL_DOCUMENT_ID:-}" ]; then
        echo "postgres mode requires EVAL_DOCUMENT_ID (a UUID). Title search is not used." >&2
        echo "pass --score or --dir instead." >&2
        exit 2
    fi
    if [[ ! "$EVAL_DOCUMENT_ID" =~ $UUID_RE ]]; then
        echo "EVAL_DOCUMENT_ID is not a UUID" >&2
        exit 2
    fi
    query="select sa.score::text from public.score_analyses sa
           where sa.status = 'ready' and sa.score is not null and sa.document_id = :'doc_id'::uuid
           order by sa.updated_at desc limit 1"
    score_json="$(docker exec "$DB_CONTAINER" psql -U postgres -d postgres -At -v doc_id="$EVAL_DOCUMENT_ID" -c "$query")"
    if [ -z "$score_json" ]; then
        echo "no ready analysis for $EVAL_DOCUMENT_ID in $DB_CONTAINER (or pass --score / --dir)" >&2
        exit 2
    fi
    printf '%s' "$score_json" | npx tsx eval/compareToReference.ts --score - "${passthrough[@]}"
else
    npx tsx eval/compareToReference.ts "${score_args[@]}" "${passthrough[@]}"
fi
