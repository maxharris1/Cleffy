# Cleffy OMR service: Audiveris 5.6.1 (headless) + Node wrapper.
#
# The Audiveris release .deb bundles its own Java runtime (jpackage), so the
# image needs no system JDK. Tesseract language data enables text/OCR steps
# (titles, directions); transcription works without it, just with a warning.
#
# Build:  docker build -t cleffy-omr services/omr-service
# Run:    docker run -p 8090:8080 -e OMR_SERVICE_SECRET=... \
#             -e SUPABASE_URL=... -e SUPABASE_SERVICE_ROLE_KEY=... cleffy-omr

FROM node:22-bookworm-slim AS build
WORKDIR /svc
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates fontconfig tesseract-ocr-eng fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

ARG AUDIVERIS_VERSION=5.6.1
RUN curl -fsSL -o /tmp/audiveris.deb \
        "https://github.com/Audiveris/audiveris/releases/download/${AUDIVERIS_VERSION}/Audiveris-${AUDIVERIS_VERSION}-ubuntu22.04-x86_64.deb" \
    && dpkg -x /tmp/audiveris.deb /opt/audiveris-root \
    && rm /tmp/audiveris.deb

ENV AUDIVERIS_BIN=/opt/audiveris-root/opt/audiveris/bin/Audiveris \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata \
    JAVA_TOOL_OPTIONS="-Xmx3g" \
    NODE_ENV=production \
    PORT=8080

WORKDIR /svc
COPY --from=build /svc/node_modules ./node_modules
COPY --from=build /svc/dist ./dist
COPY package.json ./

USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
