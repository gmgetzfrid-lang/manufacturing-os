# Self-host Manufacturing OS

The `Dockerfile` at the repo root builds a single image that runs the Next.js
app. Point it at your own Supabase project (and R2 bucket, if you use file
storage) and it behaves exactly like the hosted deployment.

Schedule imports accept Microsoft Project XML, Primavera P6 XML/XER, and CSV.
Binary `.mpp`/`.mpx` files are refused by design — export XML from MS Project
(File → Save As → XML) and import that.

## Quick start (any Docker host)

```bash
cp .env.example .env          # fill in your Supabase values (and R2, if used)
docker compose up --build     # builds the image and starts the app
```

Open <http://localhost:3000>.

---

## Build-time vs runtime config (important)

Next.js **inlines** any `NEXT_PUBLIC_*` variable into the browser bundle **at
build time**, so those must be your real values when the image is built:

| Variable | When it's needed |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | **build** (and runtime) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **build** (and runtime) |
| `NEXT_PUBLIC_APP_URL` | build (optional) |
| `SUPABASE_SERVICE_ROLE_KEY` | runtime |
| `R2_*` (storage) | runtime |

`docker compose` passes the `NEXT_PUBLIC_*` values from `.env` as build args
automatically (see `docker-compose.yml`). With a raw `docker build`, pass them
explicitly:

```bash
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ... \
  -t manufacturing-os .

docker run -p 3000:3000 \
  -e NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co \
  -e NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ... \
  -e SUPABASE_SERVICE_ROLE_KEY=eyJ... \
  manufacturing-os
```

---

## Hosted platforms

The container listens on `$PORT` (defaults to 3000). Any platform that builds
from a Dockerfile works:

**Render** — New → Web Service → *Docker* runtime, repo root as context. Add the
`NEXT_PUBLIC_*` vars (Render makes env vars available at build) plus the runtime
secrets. Render injects `PORT` automatically.

**Fly.io** — `fly launch` (it detects the Dockerfile). Set secrets with
`fly secrets set SUPABASE_SERVICE_ROLE_KEY=… R2_…=…`, and pass the
`NEXT_PUBLIC_*` build args via `fly deploy --build-arg NEXT_PUBLIC_SUPABASE_URL=…`.
Ensure the service `internal_port` matches `$PORT` (8080 by default on Fly — set
`PORT=8080` or adjust the fly service).

**Railway / Cloud Run / ECS** — same idea: Dockerfile build, `NEXT_PUBLIC_*` as
build args, secrets as runtime env, expose `$PORT`.
