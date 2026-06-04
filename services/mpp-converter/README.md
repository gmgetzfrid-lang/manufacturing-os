# mpp-converter — full-fidelity Microsoft Project parser

A tiny stateless HTTP service that parses `.mpp` (and `.mpx`, MS Project `.xml`,
Primavera `.xer`) **completely** using [MPXJ](https://www.mpxj.org/) — the
mature, battle-tested library Microsoft Project's own format can be read with.

It returns the exact JSON the Manufacturing OS app expects, so dropping a `.mpp`
in the app gives you **dependencies, resource/contractor assignments,
user-defined custom columns, exact dates, % complete, and hierarchy** — with
**no export step for the user**.

## Why this exists

`.mpp` is a proprietary, undocumented binary. Reading it fully requires MPXJ,
which is **Java** — and the app runs on Vercel's JavaScript serverless, which
can't host a JVM. So the full parse runs here, as a small separate container.
The app is already wired to use it: set `MPP_CONVERTER_URL` and the app forwards
uploaded `.mpp` bytes here and trusts the JSON.

## Run it

```bash
# Build + run locally
docker build -t mpp-converter services/mpp-converter
docker run -p 8080:8080 mpp-converter

# Smoke test
curl -fsS http://localhost:8080/health
curl -fsS --data-binary @schedule.mpp http://localhost:8080/ | head
```

## Deploy (Google Cloud Run — scale-to-zero, fast)

```bash
gcloud run deploy mpp-converter \
  --source services/mpp-converter \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --set-env-vars MPP_CONVERTER_TOKEN=<a-long-random-string>
```

Then in the **app's** environment (Vercel):

```
MPP_CONVERTER_URL=https://mpp-converter-xxxxx-uc.a.run.app/
MPP_CONVERTER_TOKEN=<the same random string>
```

Any container host works (Fly.io, Render, Railway, ECS) — it only needs to run
the Docker image and receive the `PORT` env var.

## Contract

`POST /` with the raw file bytes (`application/octet-stream`). Optional
`Authorization: Bearer <MPP_CONVERTER_TOKEN>`. Responds:

```json
{
  "projectName": "Unit 200 Turnaround",
  "tasks": [
    {
      "uid": 1, "parentUid": null, "name": "Mobilize crew",
      "start": "2026-06-01T08:00:00", "finish": "2026-06-03T17:00:00",
      "outlineLevel": 1, "wbs": "1", "isSummary": false,
      "percentComplete": 50, "milestone": false, "workHours": 24,
      "notes": null, "resources": "Acme Mechanical",
      "predecessors": [], "fields": { "Contractor": "Acme Mechanical", "Area": "North flare" }
    }
  ]
}
```

`GET /health` → `{"ok":true}`.

## Notes

- MPXJ version is pinned in `pom.xml` (`mpxj.version`). If Maven can't resolve
  it, set it to the latest from
  <https://mvnrepository.com/artifact/net.sf.mpxj/mpxj> — the API used here is
  stable across recent releases.
- Stateless: nothing is persisted; the file is parsed in memory and discarded.
