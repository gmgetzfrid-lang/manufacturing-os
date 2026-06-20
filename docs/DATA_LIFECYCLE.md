# Data Lifecycle, Archival & Backup — Strategy & Execution Plan

Status: **planning / grounded in a full read-only audit (3 passes).** No runtime
behavior has changed. This document is the agreed source of truth before any
build. Defaults are marked; items gated on a compliance answer are flagged ⚖️.

---

## 0. The two machines (don't conflate them)

| | **A — Space-saver** | **B — Full backup** |
|---|---|---|
| Why | Stay under storage/cost limits | Disaster recovery / portability |
| Trigger | Usage hits **X%** → shed to **Y%** | Quarterly *recommendation* to admin |
| Scope | Least-necessary cold data only | Everything, org-wide |
| Smart? | Yes — worst-candidate first | No — full snapshot |
| Restore | Drop one zip → view a file in-memory | Re-import → rebuild the whole org |
| Built on | the binary-export engine | the **same** binary-export engine |

Both stand on one keystone: a **reliable binary export** (today's export tries
to include files but falls over at scale — see §5).

---

## 1. What the audit actually found (the corrections that matter)

1. **Dedup is half-built.** `document_versions.file_hash` already stores a
   SHA-256 of every file — it's just **never used to skip a duplicate upload**.
   Turning it on is the single biggest cost lever and it's mostly already there.
2. **The export is narrower than it looks.** It *attempts* binaries
   (`lib/dataExport.ts` + `lib/exportRunner.ts`, `includeFiles`) but builds the
   whole ZIP in one request with **24-hour signed URLs**, so it dies on real
   volume and on expiry — "binaries don't work" = unreliable at scale. It also
   only covers **~19 of 55 tables**, *missing several records*: `e_signatures`,
   `transmittals`, `document_holds`, `milestones`/`milestone_notes`,
   `assets`/`asset_photos`, `notes`, `checkout_episodes`, `ticket_comments`,
   `document_assets`, `project_documents`. Machine B must **expand coverage to
   all record tables**, not just harden binaries.
3. **There is zero restore/import code.** Export is one-way. Machine B's
   "rebuild from backup" half is greenfield.
4. **Identity matches your instinct exactly:** `orgs.id` is stable but
   `orgs.name` is **not unique**; users are keyed by **email**; the export
   carries **no auth credentials** → restore = re-invite to log in, work/history
   comes back. Your "Acme vs Acme Inc., ask which to keep" + additive-users plan
   is correct.
5. **The "caches" are already free:** baked markups, thumbnails, and transmittal
   bundles are generated on the fly and **never stored** in R2. Nothing to prune.
6. **AI is a single shared `GEMINI_API_KEY`** with no per-org/per-user limits,
   no metering, and a **silent** drop to non-AI mode on failure (~10 req/min
   free tier → exhausts in seconds with many users, with no admin warning).

### Cost hotspots, ranked (busy plant)

**Postgres (bites first):**
1. **`audit_logs`** — UNBOUNDED, ~1M–10M rows/yr, **zero cleanup today**. #1 risk.
2. **`checkout_messages`** — ~500K–5M rows/yr (collaboration threads).
3. **`download_audits`** — high (one per file view/download).
4. **`notifications` + `email_notifications`** — high, disposable.
5. **`ticket_comments`** + the **`tickets` JSONB arrays** (`history`,
   `comments`, `attachments`) — bloat to **100KB–1MB per busy ticket**; the row
   is rewritten on every action.

**R2 (cheap per-GB, egress-free — slower burn):**
1. **Ticket attachment files** (`orgs/{org}/tickets/{ticket}/…`) — fastest
   growing: every draft/revision is a new file and **nothing is deleted on
   ticket close** (orphans).
2. **`document_versions` files** — every rev is a full copy (no dedup).
3. **`asset_photos`** — superseded photos never auto-deleted.
4. **Orphans** — deleted plot-plan images, replaced org logos, closed-ticket
   files left behind.

---

## 2. Keep / Delete / Archive map

### Delete for good (disposable byproducts — not records)
- `notifications`: keep unread + last **90 days**; delete older.
- `email_notifications`: keep ~**30–90 days** (delivery proof) then delete.
  *(If email isn't enabled, this is empty — non-issue.)*
- Orphaned R2 files: closed-ticket attachments, deleted-plot-plan images,
  replaced logos, abandoned/partial uploads.
- `document_shares` past expiry + grace; dead `push_subscriptions` (410).
- Pure UX state regenerable at will: `document_favorites`, stale `table_views`.
- **Never stored, so nothing to do:** baked markups, thumbnails, transmittal
  bundles, expired signed URLs, presence.

### Box up & restore (records — archived, never deleted)
- **Superseded `document_versions`** beyond the recent few (⚖️ default: keep
  last 3–5 revs or 24 mo hot; archive the rest). Metadata + `file_hash` stay.
- **Closed-ticket files** (source assets + intermediate drafts). ⚖️ Your call:
  intermediates are records archived after close, with **revision count + reason
  per revision kept hot and visible to everyone** in their place.
- **`download_audits`** — wholesale noise; archive to R2 NDJSON after **90
  days** (keep a thin index). **`audit_logs`** — split by action: keep the
  **life-story events** (`CHECK_OUT`, rev, approval, hold — few, cheap) **hot
  forever** for the per-document History view; archive the **`VIEW`/`DOWNLOAD`
  noise** after **90 days**.
- **Closed `checkout_episodes` / `checkout_messages`** — archive after closed +
  1 yr.
- `asset_photos` status=`superseded`; resolved `markup_requests`; released
  `document_holds` (after ~12 mo); completed-project `milestones`/activity.

### Keep hot forever (light, or it's the index)
- **All metadata rows**: `documents`, `document_versions` (rows, not files),
  `tickets`, `transmittals`, `e_signatures`, `milestones`, the life-story audit.
- Reference/config: `orgs`, `org_members`, `users`, `libraries`, `collections`,
  `assets`, `units`, `systems`, policies, templates, views.

**Rule:** if you'd ever search it or pull it in an audit, it's archived, not
deleted. The card (metadata) always stays; only the heavy file leaves.

---

## 3. Machine A — the space-saver (threshold + smart eviction)

Need-driven, **not** scheduled. When usage crosses **X%** (default 70), get back
toward **Y%** (default 50) in two passes:

1. **Free cleanup first** (no admin action): purge the disposables in §2 +
   orphaned R2 files + archivable audit noise. If that reaches Y%, stop.
2. **Ranked archive** if still over Y%: score cold *records* by a **necessity
   ranking** (oldest + least-recently-opened + superseded/closed first), propose
   an export batch **sized exactly to hit Y%**, worst-candidate first. Admin
   exports that zip and saves it on-site. The live UI never changes.

**Restore-on-demand (user-held cold tier):**
- Server keeps a permanent **archive index** (which zip holds which file +
  checksum) + the admin's saved-location label.
- Opening an out-of-range file → prompt names the **exact zip**; user
  **drag-drops** it; the app verifies name + fingerprint, shows the file, holds
  it **in memory for the session**, writes nothing back.
- *Constraint:* a browser can't auto-read a path — the admin's location is a
  signpost shown to the user; they still drop the file. Optional later upgrade:
  connect a storage location for auto-retrieval.

---

## 4. Machine B — full backup + restore (the hard, greenfield half)

**Backup:** the existing export, made **reliable AND complete**: background job,
**chunked** (per date-range / drawing-family, ≤ a few GB each), streamed from
R2, **checksum per file + manifest hash** (tamper-evident), resilient to missing
files, and **expanded to every record table** (today's export covers only
~19/55 — see §1.2). Same engine powers Machine A's ranked subset and Machine B's
full org snapshot.
Quarterly **recommendation** nudge to the admin ("take a full backup").

**Restore = a merge, never a blind overwrite** (gated to a **paid plan**):
- **Org:** match on `id` if the same workspace resumes; if names differ
  (normalize "Inc./LLC/case") → **ask the admin which name to keep**.
- **Users (additive, by email):** exists → re-link; doesn't exist → create
  **inactive "restored"** record (keeps authorship/history, **no paid seat**
  until reactivated); near-miss email → ask.
- **ID remapping:** build old-ID→new-ID table, rewrite all FKs in dependency
  order (`orgs → org_members → libraries → documents → document_versions →
  files → tickets → comments → history`).
- **Preview/dry-run + approve** screen before any write; nothing destructive.
- **Auth:** credentials aren't in the backup → restored users get re-invited.
- Mark the import itself in `audit_logs` (`DATA_IMPORT`) for compliance.
- *This is the highest-risk piece in the whole plan; build it isolated, last,
  and prove it with export→wipe→import round-trip tests before it touches a
  paying customer.*

---

## 5. Dedup (content-addressed storage) — biggest structural win

Use the SHA-256 already in `document_versions.file_hash`:
- On upload, if a file's hash already exists for the org, **store the bytes once
  and point to them** (ref-count) instead of writing a new R2 object.
- Apply across the duplication paths the audit found: ticket source asset ↔
  library revision ↔ (any re-upload of an identical file).
- Revert already reuses the file (good); extend that to all identical content.
- Likely removes a large fraction of R2 growth and reduces how often Machine A
  ever needs to run.

---

## 6. AI usage limits & safeguards (parallel track)

Today: one shared key, no limits, no metering, silent fallback. Plan:
- **Per-org daily quota + per-user throttle**, enforced in `/api/ai` before the
  provider call.
- **Honest failure:** on 429/timeout, retry w/ backoff, then show "AI's busy —
  try again." Stop silently pretending the real AI ran (or clearly label
  "basic mode").
- **Metering:** log every call (`org_id, user_id, op, model, est_tokens`) to a
  `ai_usage_events` table; **admin dashboard** of burn vs cap.
- **Bring-your-own-key per org** — the real fix at scale (each org owns its
  quota/cost). Tie quotas to billing tier.
- Cache/debounce identical requests.

Call sites to cover: `NoteInsights`, `ScratchpadPanel`, scratchpad page,
`ScheduleGeneratorModal`, `AiDraftButton`, `CopilotRail` (all via `/api/ai`).

---

## 7. Monitoring & instrumentation (build FIRST — "measure first")

A read-only admin **Storage & Usage** panel: GB by class (revisions / ticket
files / photos), **row counts + table sizes** (pg), bandwidth + AI usage vs cap,
**projected days-to-limit** (the slope), archive status/history, per-org quota.
Non-destructive; it's what makes every other decision data-driven and answers
"is this even worth doing yet."

---

## 8. Rollout order (value early, risk cornered)

0. **Instrument + this audit** — measure the real curve. *(non-destructive)*
1. **Safe prune wins** — notifications/email/orphans; move `tickets` JSONB
   arrays out of the row (`ticket_comments` already exists for comments).
2. **Dedup** — turn on the existing `file_hash`. Biggest structural saving.
3. **Harden + widen the export** — background + chunked + checksummed +
   manifest, covering **all record tables** (today ~19/55).
4. **Machine A** — threshold eviction + user-held restore-on-demand.
5. **Audit/notification archival** to R2 NDJSON (keep life-story events hot).
6. **Machine B restore/import** — the merge engine + round-trip tests.
7. **AI safeguards** — runs alongside throughout.

---

## 9. Open decisions (gate the build)

1. **Intermediate drafting files** — records (archive after close, keep
   count+reasons) vs disposable? *(You leaned: archive after close.)* ⚖️
2. **Retention/compliance** — how long must revisions & audit be kept, and
   "retrievable within"? Sets how aggressive cold-tiering can be. ⚖️
3. **Hot window** — keep last N revisions or last X months? (default 3–5 / 24mo)
4. **Archive location** — org's own storage destination vs user-held + drop-in.
5. **AI** — appetite for bring-your-own-key per org; tie AI/quotas to billing?
6. **Quotas** — hard per-org storage quotas vs soft admin warnings.

---

## 10. Risks / honesty

- **Restore-with-merge (§4) is the sharp end** — touches every table, must be
  bulletproof; built isolated, last, behind preview+approve, proven by
  round-trips.
- Numbers here are **engineering estimates**; the instrumentation (§7) replaces
  them with your real curve.
- Nothing in this plan deletes a record. Deletion is only ever disposables +
  orphans; everything else is archive-with-a-breadcrumb.
