# Cleffy OMR service: Audiveris 5.6.1 (headless) + Node wrapper.
#
# The Audiveris release .deb bundles its own Java runtime (jpackage), so the
# image needs no system JDK. Audiveris OCR needs Tesseract *3.04 legacy*
# language files (not Debian's LSTM-only eng.traineddata).
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
    && apt-get install -y --no-install-recommends curl ca-certificates fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

ARG AUDIVERIS_VERSION=5.6.1
# Tesseract 3.04 eng — Audiveris runs OCR in legacy mode only.
ARG TESSDATA_ENG_URL=https://github.com/tesseract-ocr/tessdata/raw/3.04.00/eng.traineddata
RUN curl -fsSL -o /tmp/audiveris.deb \
        "https://github.com/Audiveris/audiveris/releases/download/${AUDIVERIS_VERSION}/Audiveris-${AUDIVERIS_VERSION}-ubuntu22.04-x86_64.deb" \
    && dpkg -x /tmp/audiveris.deb /opt/audiveris-root \
    && rm /tmp/audiveris.deb \
    && mkdir -p /opt/tesseract-ocr/tessdata \
    && curl -fsSL -o /opt/tesseract-ocr/tessdata/eng.traineddata "${TESSDATA_ENG_URL}"

ENV AUDIVERIS_BIN=/opt/audiveris-root/opt/audiveris/bin/Audiveris \
    TESSDATA_PREFIX=/opt/tesseract-ocr/ \
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
