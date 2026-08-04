# Manufacturing OS — self-host image.
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

# ---------- Stage 1: build the Next.js app ----------
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

# ---------- Stage 2: runtime ----------
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

# Built app + its dependencies.
COPY --from=web /app ./

EXPOSE 3000
# tini = PID 1: forwards signals cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start"]
