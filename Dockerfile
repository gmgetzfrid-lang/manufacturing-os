# Manufacturing OS — all-in-one image.
#
# Runs the Next.js app AND the MPXJ converter in a single container, so binary
# .mpp files import at true 1:1 fidelity (exact dates, dependencies, resources,
# hierarchy — every MS Project version incl. pre-2010) with NO separate service
# to deploy. The app talks to the converter over loopback; the existing
# MPP_CONVERTER_URL path consumes its output, so there's no bespoke glue.
#
# Build (NEXT_PUBLIC_* are inlined into the client bundle, so they must be your
# REAL values at build time):
#
#   docker build \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ... \
#     -t manufacturing-os .
#
# Run (server-only secrets are provided at runtime):
#
#   docker run -p 3000:3000 \
#     -e NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co \
#     -e NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ... \
#     -e SUPABASE_SERVICE_ROLE_KEY=eyJ... \
#     manufacturing-os
#
# Or just `docker compose up --build` (reads .env). See docs/SELF_HOST_DOCKER.md.

# ---------- Stage 1: build the MPXJ converter fat-jar ----------
FROM maven:3.9-eclipse-temurin-17 AS mpxj
WORKDIR /build
COPY docker/mpxj-converter/pom.xml .
RUN mvn -B -q dependency:go-offline
COPY docker/mpxj-converter/src ./src
RUN mvn -B -q -DskipTests package
# -> /build/target/mpxj-converter.jar

# ---------- Stage 2: build the Next.js app ----------
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Public env is inlined at build time. Pass real values as build args.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY} \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    # Placeholder only so module-load Supabase clients don't throw during the
    # build's page-data collection; the real key is supplied at runtime.
    SUPABASE_SERVICE_ROLE_KEY=build-time-placeholder \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- Stage 3: runtime (Node + headless JRE + jar) ----------
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openjdk-17-jre-headless fontconfig tini wget \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # The app reaches the in-container converter over loopback.
    MPP_CONVERTER_URL=http://127.0.0.1:8090 \
    MPXJ_INTERNAL_PORT=8090 \
    PORT=3000

# Built app + its dependencies.
COPY --from=web /app ./
# MPXJ converter jar.
COPY --from=mpxj /build/target/mpxj-converter.jar /opt/mpxj/mpxj-converter.jar
# Process launcher.
COPY docker/start.sh /opt/start.sh
RUN chmod +x /opt/start.sh

EXPOSE 3000
# tini = PID 1: forwards signals and reaps the backgrounded JVM.
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/start.sh"]
