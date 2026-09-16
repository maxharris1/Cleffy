#!/usr/bin/env bash
# One-off deploy of the seed-only OMR worker pool (plan Phase 2c).
#
# cleffy-omr-seed is a SECOND Cloud Run service on the SAME image as cleffy-omr
# (not a second revision: revisions share traffic, and the user /poke from
# score-analyze / omr_sweep must never land on a seed instance). It only claims
# omr_jobs rows with priority <= -1 (the corpus seed inserts at -10), so it
# never takes a user's job, and it scales to zero when the seed ledger drains.
#
# Run this once to create the service and set its env; afterwards the
# `deploy-seed` job in .github/workflows/deploy-omr.yml keeps its image in step
# with cleffy-omr on every main deploy without touching env or IAM.
#
# Required env (same values cleffy-omr runs with):
#   OMR_SERVICE_SECRET          shared x-omr-secret (pg_cron + seed script poke with it)
#   SUPABASE_URL                project URL
#   SUPABASE_SERVICE_ROLE_KEY   service-role key
# Optional:
#   GCP_PROJECT_ID              default cleffy-504715
#   GCP_REGION                  default us-central1
#   GCP_OMR_SERVICE             user service to copy the image from (default cleffy-omr)
#   GCP_OMR_SEED_SERVICE        default cleffy-omr-seed
#   CORPUS_OWNER_SECRET         Secret Manager secret holding the corpus owner's
#                               auth.users id (default cleffy-corpus-owner-user-id).
#                               Create it first:
#                                 printf '%s' "<uuid>" | gcloud secrets create cleffy-corpus-owner-user-id --data-file=-
#                               and grant roles/secretmanager.secretAccessor to the
#                               Cloud Run runtime service account.
#   SEED_MAX_INSTANCES          default 5 (the plan's N; raise here, never on cleffy-omr)
#   SEED_MEMORY / SEED_CPU      default 4Gi / 2 (matches -Xmx3g in the Dockerfile)
#   GCP_RUNTIME_SA              optional runtime service account (--service-account)
#   SEED_IMAGE                  override the image instead of copying cleffy-omr's
set -euo pipefail

: "${OMR_SERVICE_SECRET:?OMR_SERVICE_SECRET is required}"
: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY is required}"

PROJECT="${GCP_PROJECT_ID:-cleffy-504715}"
REGION="${GCP_REGION:-us-central1}"
USER_SERVICE="${GCP_OMR_SERVICE:-cleffy-omr}"
SEED_SERVICE="${GCP_OMR_SEED_SERVICE:-cleffy-omr-seed}"
OWNER_SECRET="${CORPUS_OWNER_SECRET:-cleffy-corpus-owner-user-id}"
MAX_INSTANCES="${SEED_MAX_INSTANCES:-5}"
MEMORY="${SEED_MEMORY:-4Gi}"
CPU="${SEED_CPU:-2}"

# Same bytes as the user worker: copy the image the live cleffy-omr revision runs.
IMAGE="${SEED_IMAGE:-}"
if [[ -z "$IMAGE" ]]; then
    IMAGE="$(gcloud run services describe "$USER_SERVICE" \
        --project="$PROJECT" --region="$REGION" \
        --format='value(spec.template.spec.containers[0].image)')"
fi
if [[ -z "$IMAGE" ]]; then
    echo "could not resolve the image of $USER_SERVICE; set SEED_IMAGE" >&2
    exit 1
fi
echo "deploying $SEED_SERVICE from image $IMAGE"

SA_FLAG=()
if [[ -n "${GCP_RUNTIME_SA:-}" ]]; then
    SA_FLAG=(--service-account="$GCP_RUNTIME_SA")
fi

# --allow-unauthenticated: /poke is protected by x-omr-secret, and both pg_net
# (omr_seed_sweep) and the seed script call it without IAM, exactly like cleffy-omr.
gcloud run deploy "$SEED_SERVICE" \
    --project="$PROJECT" --region="$REGION" \
    --image="$IMAGE" \
    --memory="$MEMORY" --cpu="$CPU" --timeout=3600 \
    --concurrency=1 --min-instances=0 --max-instances="$MAX_INSTANCES" \
    --no-cpu-throttling --cpu-boost \
    --allow-unauthenticated \
    "${SA_FLAG[@]}" \
    --set-env-vars="^@^CLEFFY_CLAIM_MAX_PRIORITY=-1@CLEFFY_CORPUS_LOOKUP=1@CLEFFY_SYMBOLIC_FIRST=1@OMR_SERVICE_SECRET=${OMR_SERVICE_SECRET}@SUPABASE_URL=${SUPABASE_URL}@SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}" \
    --set-secrets="CLEFFY_CORPUS_OWNER_USER_ID=${OWNER_SECRET}:latest" \
    --quiet

# SELF_URL is only known after the first deploy: the drain chain (pokeSelf) needs
# it so one wake fans out to --max-instances.
URL="$(gcloud run services describe "$SEED_SERVICE" \
    --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
gcloud run services update "$SEED_SERVICE" \
    --project="$PROJECT" --region="$REGION" \
    --update-env-vars="SELF_URL=${URL}" --quiet

RESP="$(curl -fsS "${URL}/healthz")"
echo "$RESP"
echo "$RESP" | grep -q '"ok":true'

cat <<EOF

$SEED_SERVICE is live at $URL

Next (see services/omr-service/SEED_POOL.md):
  1. Store the URL in Vault so pg_cron wakes the pool while seed rows are queued:
       select vault.create_secret('$URL', 'omr_seed_service_url');
     (omr_service_secret is already there for omr_sweep.)
  2. Optional: export OMR_SEED_SERVICE_URL=$URL for the seed script's post-batch poke.
EOF
