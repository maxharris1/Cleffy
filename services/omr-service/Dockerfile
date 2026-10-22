# Cleffy OMR service: Audiveris 5.6.1 (headless) + Node wrapper.
#
# The Audiveris release .deb bundles its own Java runtime (jpackage), so the
# image needs no system JDK. Audiveris OCR needs Tesseract *3.04 legacy*
# language files (not Debian's LSTM-only eng.traineddata).
#
# Build:  docker build -t cleffy-omr services/omr-service
# Run:    docker run -p 8090:8080 -e OMR_SERVICE_SECRET=... \
#             -e SUPABASE_URL=... -e SUPABASE_SERVICE_ROLE_KEY=... cleffy-omr
#
# Both stages start from one base image, pinned by its multi-arch index digest
# so a re-pushed tag cannot change what is built. The tag is kept beside the
# digest for readers; Docker uses the digest. Re-pin on purpose:
#   docker buildx imagetools inspect node:<version>-bookworm-slim
# and copy its top-level `Digest:` here (both FROM lines).
# Pinned 2026-10-22: node 22.23.4 on debian bookworm-slim (index digest below).
# apt packages are NOT version-pinned: bookworm's archive keeps only the current
# point release, so an exact pin breaks the build at the next security update.
# The digest fixes the base; `apt-get install` takes bookworm's current
# security fixes for curl, ca-certificates, fontconfig and fonts-dejavu-core.

FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
WORKDIR /svc
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

ARG AUDIVERIS_VERSION=5.6.1
# SHA-256 of the exact bytes this image is built from. A download that does not
# match fails the build instead of running whatever came back. Bumping
# AUDIVERIS_VERSION or the tessdata URL means re-pinning: download the file and
# take `sha256sum`, and compare it with the asset digest GitHub shows on the
# release (`gh api repos/Audiveris/audiveris/releases/tags/<version>`).
ARG AUDIVERIS_DEB_SHA256=3f05c33fe65a5fced51718bdafde9ed989528b882cf3297d4c72b588ef04a656
# Tesseract 3.04 eng — Audiveris runs OCR in legacy mode only. The raw host
# directly (github.com/<repo>/raw/<tag>/… only redirects here); the tag pins the
# path, the hash pins the content.
ARG TESSDATA_ENG_URL=https://raw.githubusercontent.com/tesseract-ocr/tessdata/3.04.00/eng.traineddata
ARG TESSDATA_ENG_SHA256=c0515c9f1e0c79e1069fcc05c2b2f6a6841fb5e1082d695db160333c1154f06d
RUN set -eu \
    && curl -fsSL -o /tmp/audiveris.deb \
        "https://github.com/Audiveris/audiveris/releases/download/${AUDIVERIS_VERSION}/Audiveris-${AUDIVERIS_VERSION}-ubuntu22.04-x86_64.deb" \
    && echo "${AUDIVERIS_DEB_SHA256}  /tmp/audiveris.deb" | sha256sum -c - \
    && dpkg -x /tmp/audiveris.deb /opt/audiveris-root \
    && rm /tmp/audiveris.deb \
    && mkdir -p /opt/tesseract-ocr/tessdata \
    && curl -fsSL -o /tmp/eng.traineddata "${TESSDATA_ENG_URL}" \
    && echo "${TESSDATA_ENG_SHA256}  /tmp/eng.traineddata" | sha256sum -c - \
    && mv /tmp/eng.traineddata /opt/tesseract-ocr/tessdata/eng.traineddata

# TESSDATA_PREFIX must name the tessdata FOLDER ITSELF, not its parent. Pointing
# at the parent (the convention older Tesseract used) makes Audiveris log
# "Language 'eng' is not supported" as a WARN, disable OCR, and carry on — so the
# export silently contains no <words> at all: no tempo headings, no textual
# cresc./dim., no lyrics. Verified against 5.6.1 on a real score.
ENV AUDIVERIS_BIN=/opt/audiveris-root/opt/audiveris/bin/Audiveris \
    TESSDATA_PREFIX=/opt/tesseract-ocr/tessdata/ \
    JAVA_TOOL_OPTIONS="-Xmx3g --add-opens=java.base/java.nio=ALL-UNNAMED --add-opens=java.base/jdk.internal.ref=ALL-UNNAMED" \
    NODE_ENV=production \
    PORT=8080

WORKDIR /svc
COPY --from=build /svc/node_modules ./node_modules
COPY --from=build /svc/dist ./dist
COPY package.json ./

USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
