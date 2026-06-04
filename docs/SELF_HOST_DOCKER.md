# Self-host Manufacturing OS (with true 1:1 `.mpp` import)

The `Dockerfile` at the repo root builds **one image** that runs the Next.js app
**and** the MPXJ converter together. That's what makes binary Microsoft Project
`.mpp` files import at true 1:1 fidelity — exact start/finish dates, dependency
links, resource assignments, and the full WBS hierarchy, for **every** MS Project
version (including pre-2010 files) — with **no separate service to deploy**.

Under the hood: MPXJ (the reference Java library for Project files) runs inside
the container on loopback, and the app's existing `MPP_CONVERTER_URL` path
consumes its output. `.xml`, `.xer`, `.mpx`, and `.csv` are parsed in pure JS as
before; the converter is only used for binary `.mpp`.

> Why not Vercel? Vercel's runtime can't execute Java, and MPXJ needs a JVM.
> This image must run on a platform that runs containers (your own box, Render,
> Fly.io, Railway, Cloud Run, ECS, etc.).

---

## Quick start (any Docker host)

```bash
cp .env.example .env          # fill in your Supabase values (and R2, if used)
docker compose up --build     # builds the image and starts the app
```

Open <http://localhost:3000>. Drop a `.mpp` into a project schedule import — the
dialog will report **“Parsed via your MPXJ converter — full fidelity.”**

To verify the converter is healthy inside the container:

```bash
docker exec manufacturing-os wget -qO- http://127.0.0.1:8090/
# {"ok":true,"service":"mpxj-converter"}
```

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

The container listens on `$PORT` (defaults to 3000); the converter uses an
internal loopback port (`MPXJ_INTERNAL_PORT`, default 8090) that is never
exposed. Any platform that builds from a Dockerfile works:

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

---

## Notes

- **Image size:** ~1–1.5 GB (Node runtime + a headless JRE + the 27 MB MPXJ jar).
  That's the cost of bundling a real Project-file parser; it's a one-time pull.
- **Graceful degradation:** if the converter ever fails to start, the app still
  runs — `.mpp` imports fall back to the in-process reader and the import dialog
  says exactly why, instead of erroring.
- **Token (optional):** the converter is loopback-only and unauthenticated by
  default. To require a bearer token anyway, set `MPXJ_TOKEN` and a matching
  `MPP_CONVERTER_TOKEN` on the app.
