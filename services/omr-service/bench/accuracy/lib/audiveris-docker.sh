#!/bin/sh
# AUDIVERIS_BIN shim: runs the real Audiveris inside a cleffy-omr image so the
# benchmark can reuse dist/audiveris.js (runAudiveris) unchanged.
#
# The image tag is read from `<output-dir>/../.image`, written by the engine
# runner; the work dir is bind-mounted at the same absolute path so every path
# in argv is valid inside the container.
set -eu
OUT=""
PDF=""
prev=""
for a in "$@"; do
    if [ "$prev" = "-output" ]; then OUT="$a"; fi
    prev="$a"
    PDF="$a"
done
if [ -z "$OUT" ]; then
    echo "audiveris-docker.sh: no -output in argv" >&2
    exit 2
fi
WORK=$(dirname "$OUT")
IMAGE=$(cat "$WORK/.image")
PDF_DIR=$(dirname "$PDF")
exec docker run --rm --init --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -v "$WORK:$WORK" \
    -v "$PDF_DIR:$PDF_DIR:ro" \
    --cpus "${BENCH_AUDIVERIS_CPUS:-2}" \
    "$IMAGE" sh -c 'exec "$AUDIVERIS_BIN" "$@"' sh "$@"
