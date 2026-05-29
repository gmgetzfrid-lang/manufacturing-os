# MPXJ MPP converter sidecar

A tiny HTTP service that wraps [MPXJ](https://www.mpxj.org) — the
canonical open-source library for reading Microsoft Project files
— so the Manufacturing OS app can parse real `.mpp` binaries.

## Why this exists

`.mpp` is Microsoft Project's proprietary binary format. There is
no maintained pure-JavaScript reader. MPXJ (Java, GPL/commercial)
has been reverse-engineering it since 2002 and handles every
Project version reliably. This service is the smallest possible
bridge between the Node app and MPXJ: POST `.mpp` bytes → JSON tasks.

## Endpoints

- `GET  /` — liveness probe. Returns `{"ok": true}`.
- `POST /` — accepts the raw `.mpp` file body. Returns:
  ```json
  {
    "projectName": "LRU Pit Stop Jan 2026",
    "tasks": [
      {
        "uid": 12,
        "name": "Inspect E-204 tube bundle",
        "start":  "2026-01-15T08:00:00Z",
        "finish": "2026-01-18T17:00:00Z",
        "percentComplete": 25,
        "milestone": false
      },
      ...
    ]
  }
  ```

## Run locally with Docker Compose

From the repository root:

```bash
docker compose up -d mpxj-converter
```

The converter listens on `http://localhost:8765`.

## Wire into the Manufacturing OS app

Add to your `.env` (or your hosting provider's env settings):

```
MPP_CONVERTER_URL=http://localhost:8765/
```

For production:
- **Vercel / Netlify / serverless Next.js:** the converter must
  live somewhere reachable from your function runtime. Deploy
  this Dockerfile to Railway, Fly.io, Render, or your own VPS
  and set `MPP_CONVERTER_URL` to the public URL.
- **Self-hosted (Docker Compose, Kubernetes):** add the service
  to the same network and use the internal hostname.

## Optional bearer-token auth

If the converter is reachable from the public internet, you
probably want to require a token.

In the converter env (`docker-compose.yml`):

```yaml
environment:
  - MPXJ_TOKEN=your-long-random-secret
```

In the Manufacturing OS env:

```
MPP_CONVERTER_URL=https://your-converter.example.com/
MPP_CONVERTER_TOKEN=your-long-random-secret
```

The Node side adds `Authorization: Bearer <token>` to every
request; the Java service rejects anything else with 401.

## Build the image yourself

```bash
cd docker/mpxj-converter
docker build -t mpxj-converter:local .
docker run --rm -p 8765:8080 mpxj-converter:local
```

## What MPXJ supports

The `UniversalProjectReader` this service uses handles:

- Microsoft Project: `.mpp` (98, 2000, 2002, 2003, 2007, 2010,
  2013, 2016, 2019, 365), `.mpx`, `.mpt`, `.xml`
- Primavera P6: `.xer`, `.xml`, P6 PMDB connections
- GanttProject, Phoenix, ConceptDraw, Asta Powerproject,
  Synchro, Turbo Project, FastTrack, and several others

The Node side currently only sends `.mpp` here — the other formats
are parsed in-process. If you want to route everything to MPXJ for
consistency, set `MPP_CONVERTER_URL` and update the dispatch in
`components/projects/ScheduleImportModal.tsx`.

## License note

MPXJ is dual-licensed: GPL v3 for open-source use, commercial
license for closed-source distribution. Running it as a separate
sidecar service (this setup) and consuming its output over HTTP
is the standard pattern for keeping the rest of your application
license-clean.
