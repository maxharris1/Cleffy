# Cleffy OMR service: Audiveris 5.11.0 (headless, one patched class) + Node wrapper.
#
# The Audiveris release .deb bundles its own Java runtime (jpackage), so the
# runtime image needs no system JDK. Audiveris OCR needs Tesseract *3.04 legacy*
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

# Unpack the official Audiveris .deb. Kept on the Debian base rather than folded
# into the JDK stage below: the .deb's bundled JRE carries hard-linked `legal/`
# files, and `dpkg -x` on the Ubuntu-noble JDK image fails them with ENOSYS when
# the amd64 build is emulated on an arm64 host (Apple Silicon dev machines).
FROM node:22-bookworm-slim AS audiveris-dist
ARG AUDIVERIS_VERSION=5.11.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/audiveris.deb \
        "https://github.com/Audiveris/audiveris/releases/download/${AUDIVERIS_VERSION}/Audiveris-${AUDIVERIS_VERSION}-ubuntu22.04-x86_64.deb" \
    && dpkg -x /tmp/audiveris.deb /opt/audiveris-root \
    && rm /tmp/audiveris.deb

# ---------------------------------------------------------------------------
# Engine stage: recompile the single patched class into the shipped
# audiveris.jar.
#
# The jar's classes are major version 69 (Java 25) and the bundled jpackage
# runtime is Zulu 25, so the patch must be compiled by a JDK 25 with
# `--release 25`; anything older emits a class the runtime would still load but
# that would silently diverge from the rest of the jar's compilation target.
#
# The .class files are written straight INTO audiveris.jar (`jar uf`) rather
# than prepended to the launcher classpath: the jpackage `Audiveris.cfg` builds
# its classpath from repeated `app.classpath=` lines and an extra entry there is
# easy to lose on a future engine bump, whereas an updated jar cannot be
# half-applied. See engine-patches/README.md for the provenance and the diff.
# ---------------------------------------------------------------------------
FROM eclipse-temurin:25-jdk AS engine
COPY --from=audiveris-dist /opt/audiveris-root /opt/audiveris-root
WORKDIR /work
COPY engine-patches ./engine-patches
RUN set -eux; \
    app=/opt/audiveris-root/opt/audiveris/lib/app; \
    javac --release 25 -nowarn -encoding UTF-8 \
        -cp "$app/audiveris.jar:$app/*" \
        -d /work/patch-classes \
        engine-patches/src/org/audiveris/omr/sheet/clef/ClefBuilder.java; \
    (cd /work/patch-classes && jar uf "$app/audiveris.jar" org); \
    javap -p -cp "$app/audiveris.jar" org.audiveris.omr.sheet.clef.ClefBuilder \
        | grep -q promoteOctaveClef

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY --from=engine /opt/audiveris-root /opt/audiveris-root

# Tesseract 3.04 eng — Audiveris runs OCR in legacy mode only.
ARG TESSDATA_ENG_URL=https://github.com/tesseract-ocr/tessdata/raw/3.04.00/eng.traineddata
RUN mkdir -p /opt/tesseract-ocr/tessdata \
    && curl -fsSL -o /opt/tesseract-ocr/tessdata/eng.traineddata "${TESSDATA_ENG_URL}"

# TESSDATA_PREFIX must name the tessdata FOLDER ITSELF, not its parent. Pointing
# at the parent (the convention older Tesseract used) makes Audiveris log
# "Language 'eng' is not supported" as a WARN, disable OCR, and carry on — so the
# export silently contains no <words> at all: no tempo headings, no textual
# cresc./dim., no lyrics. Verified against 5.6.1; 5.11.0 still honors TESSDATA_PREFIX.
# 5.11 WellKnowns.enableHiDpiScaling() JNA-loads libgtk-3 at class init. The
# UnsatisfiedLinkError is an Error (not Exception), so -batch dies before
# argument parsing. GDK_SCALE is the documented override that skips the probe.
ENV AUDIVERIS_BIN=/opt/audiveris-root/opt/audiveris/bin/Audiveris \
    TESSDATA_PREFIX=/opt/tesseract-ocr/tessdata/ \
    JAVA_TOOL_OPTIONS="-Xmx3g --add-opens=java.base/java.nio=ALL-UNNAMED --add-opens=java.base/jdk.internal.ref=ALL-UNNAMED" \
    GDK_SCALE=1 \
    NODE_ENV=production \
    PORT=8080

WORKDIR /svc
COPY --from=build /svc/node_modules ./node_modules
COPY --from=build /svc/dist ./dist
COPY package.json ./

USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
