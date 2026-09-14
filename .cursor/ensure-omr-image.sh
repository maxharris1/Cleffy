#!/usr/bin/env bash
# Install-phase helper: build `cleffy-omr` only when the tag is absent.
# Never rebuilds an existing image (the cloud snapshot may bake RSI svc-15
# even when this checkout's Dockerfile is main's 5.6.1).
# Never fails install: missing Docker or a build error is logged and ignored.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
BOOT_COMMON_REPO_ROOT="$REPO_ROOT"
# shellcheck source=lib/boot-common.sh
source "$REPO_ROOT/.cursor/lib/boot-common.sh"

log() { echo "[cursor-omr-image] $*"; }

IMAGE="${CLEFFY_OMR_IMAGE:-cleffy-omr}"

if ! command -v docker >/dev/null 2>&1; then
    log "docker not on PATH — skipping image ensure"
    exit 0
fi

if ! docker info >/dev/null 2>&1; then
    if ! ensure_docker_access; then
        log "docker daemon not reachable — skipping image ensure"
        exit 0
    fi
fi

if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    log "OK: ${IMAGE} already present — not rebuilding"
    exit 0
fi

if [ ! -f services/omr-service/Dockerfile ]; then
    log "WARN: services/omr-service/Dockerfile missing — skipping"
    exit 0
fi

log "Building ${IMAGE} from services/omr-service (image missing)"
if docker build -t "$IMAGE" services/omr-service; then
    log "OK: built ${IMAGE}"
else
    log "WARN: docker build failed — continuing without OMR image"
fi
exit 0
