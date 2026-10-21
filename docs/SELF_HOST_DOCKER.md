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
| `NEXT_PUBLIC_SITE_URL` | **build** (and runtime) — **required** for QR codes, share links and transmittal portal links: your public address, e.g. `https://mfg.yourplant.com` |
| `NEXT_PUBLIC_FACILITY_TIME_ZONE` | **build** (and runtime) — the facility's IANA time zone, e.g. `America/Chicago`; decides the day a revision's effective date comes into force (unset, effective dates are decided a day late, never early) |
| `NEXT_PUBLIC_FIELD_PACK_BUDGET` | build (optional) — `on` switches on the field-pack budget: a work package's or an asset tag's pack over the sheet / page / byte budget is refused or split. Leave it unset (off) until Document Control has ratified the budget (document-control PKG-12); with a raw `docker build`, pass `--build-arg NEXT_PUBLIC_FIELD_PACK_BUDGET=on` and rebuild |
| `NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE` | build (optional) — set it to exactly `20261203` only after that migration is pasted (it makes the workspace time-zone setting Admin-only); a workspace whose Admin set a zone then has its effective dates decided in it, with `NEXT_PUBLIC_FACILITY_TIME_ZONE` as the fallback. Unset, the setting decides nothing about effective dates (public-surfaces VFY-15); with a raw `docker build`, pass `--build-arg NEXT_PUBLIC_EFFECTIVE_DATE_WORKSPACE_ZONE=20261203` and rebuild |
| `SUPABASE_SERVICE_ROLE_KEY` | runtime |
| `R2_*` (storage) | runtime |

`docker compose` passes the `NEXT_PUBLIC_*` values from `.env` as build args
automatically (see `docker-compose.yml`). With a raw `docker build`, pass them
explicitly:

```bash
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ... \
  --build-arg NEXT_PUBLIC_SITE_URL=https://mfg.yourplant.com \
  --build-arg NEXT_PUBLIC_FACILITY_TIME_ZONE=America/Chicago \
  -t manufacturing-os .

docker run -p 3000:3000 \
  -e NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co \
  -e NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ... \
  -e SUPABASE_SERVICE_ROLE_KEY=eyJ... \
  manufacturing-os
```

### Subscription enforcement (`SUBSCRIPTION_ENFORCE`, runtime, default off)

Leave it unset and nothing is ever refused for billing reasons: a workspace
whose subscription lapsed, or whose free trial ended, works exactly as an
active one, and the server only logs what it would have refused (`subscription
gate would refuse org …`, at most once per workspace per hour). Set it to
exactly `true` (server environment; no rebuild) and, for a lapsed workspace —
canceled, unpaid, paused, or a trial past its end (`past_due` is the grace
period and keeps access) — the server refuses adding members and starting new
file uploads with a sentence saying why, and a strip above every page says the
same. It is a **soft** lockout: pages still render, documents can still be
opened and downloaded, and other row writes (metadata, tickets, comments) are
**not** refused — the database cannot read this switch, and a policy keyed on
subscription state would lock an active workspace out the moment a billing
webhook was missed. The escape hatches always stay open: Admin → Billing (to
renew), Admin → Data export and Admin → Storage & Backup (the whole workspace
out), every download, and the profile page. Nothing is deleted either way.
Read a quiet week of the log lines before switching it on; unset it to switch
it off again. Note that with it on, a lapsed workspace's Admin restoring files
from a backup is refused at each file (restore uploads through the same route).

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
