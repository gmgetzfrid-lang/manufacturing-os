# 11 · Upload door — recommended controls

**This is not a findings list.** It is a design note: the control set for the
unauthenticated contractor upload door, written to be decided on and then
implemented.

It supports `SEC-1`, `SEC-5`, `SEC-6`, `SEC-7`, `SEC-8` and `SEC-11` in
[`01-security-access.md`](./01-security-access.md). Those findings say what is
broken; this says what "fixed" looks like.

**Status:** PROPOSED — nothing here has been implemented.

---

## The door

Two kinds of tokened link let someone with no account write into the system:

- **Document links** — `project_intake_links` with `purpose = 'document'`. The
  contractor submits drawings, which land as `document_versions` and either
  route to review or (on a trusted link) publish directly.
- **Quote links** — the same table with `purpose = 'quote'`. The contractor
  submits pricing, which lands as a `cost_documents` row.

Both are served by `app/api/intake/upload/route.ts` and
`app/api/intake/resolve/route.ts`, and both run as the **service role**, which
bypasses row-level security and every document-control trigger (`SEC-4`).

Anyone holding the URL is the principal. There is no account, no password, no
second factor, and no revocation of the *person* — only of the link.

---

## What exists today

| Control | Document links | Quote links |
|---|---|---|
| Expiry | Optional field; blank = never | **None** — no field, no default |
| Revoke | Yes, on the Intake tab | **Not where they are minted** |
| Use cap | Counter only, no ceiling | Counter only, no ceiling |
| File-type check | **None** | **None** |
| Magic-byte check | **None** | **None** |
| Malware scan | **None anywhere in the repo** | **None** |
| Size cap | 100 MB, checked *after* full buffering | Same |
| Rate limit | **None** | **None** |
| Stored `Content-Type` | Client-supplied, trusted verbatim | Same |
| Download disposition | **Inline** | **Inline** |
| Token entropy | 2 × UUID → 160 bits — **good** | Same |
| Token format validated | Yes, on both routes — **good** | Same |
| Revoked / expired handling | Correct on both routes — **good** | Correct |

The entropy and the revoked/expired handling are genuinely well done. Everything
above them is missing.

---

## Time to live

**The principle:** a link is a *credential held by someone outside your
organization*, and it should behave like one. It should be short-lived by
default, bounded by policy, and revocable from anywhere it appears.

1. **Make `expires_at` mandatory.** Default **14 days**. Never null.
2. **Enforce a ceiling in the database**, not only in the form — the form is not
   the only writer, and `SEC-11` shows what happens when a column is only
   guarded at the UI:

   ```sql
   ALTER TABLE project_intake_links
     ALTER COLUMN expires_at SET NOT NULL,
     ADD CONSTRAINT intake_link_ttl_bounded
       CHECK (expires_at > created_at
          AND expires_at <= created_at + INTERVAL '90 days');
   ```

   Backfill existing null rows to `created_at + 14 days` before adding the
   constraint, and tell the user which links that retires.
3. **Give quote links the same field.** The insert at
   `QuotesPanel.tsx:539-544` simply omits it today.
4. **Add a use cap** alongside the existing counter — default something small
   (10), since the common case is one contractor and one deliverable.
5. **Auto-expire on completion.** When a submission is approved and the work it
   was minted for is done, expire the link rather than leaving it live.
6. **Revoke everywhere.** Put the control next to every rendering of a link, not
   only on the Intake tab.
7. **Sweep expired links in the maintenance cron** so a stale row cannot be
   resurrected by clock skew, and so the expiry is enforced by data as well as
   by a query predicate.
8. **Show the contractor the expiry** on the portal, so an expired link is
   self-explaining rather than a dead end.

---

## Sanitizing

**The principle:** the file is hostile until proven otherwise, and "proven" is
not the same as "the uploader said so."

1. **Never trust the client's `Content-Type`.** Sniff the magic bytes
   server-side and store the *sniffed* type. The current code stores
   `file.type || "application/octet-stream"` — attacker-controlled — which is
   the first link in `SEC-1`.
2. **Allowlist, do not blocklist.** On an unauthenticated door, accept PDF and a
   short list of image types, and nothing else. A drawing that is not a PDF is a
   support conversation, not a security hole. Reject with a message naming what
   *is* accepted.
3. **Serve every download as an attachment.** Add
   `ResponseContentDisposition: 'attachment; filename="…"'` to the presigned
   URL. `app/api/transmittal/route.ts:73` already does exactly this.
   **This single parameter breaks the active half of the cross-site-scripting
   chain on its own, independently of everything else here** — it is the highest
   value-per-line change in the whole audit.
4. **Sandbox the viewer's iframe** (`SecureDocViewer.tsx:274`) with no
   `allow-scripts` and no `allow-same-origin`, and gate rendering on the sniffed
   type so an unexpected file offers a download rather than rendering as a page.
5. **Consider a separate origin** for untrusted uploads, so even a bypass cannot
   reach app-origin `localStorage`. This is the durable structural fix; the
   first four are the cheap ones.
6. **Cap before buffering.** Reject on `Content-Length` before reading the body,
   and read it **once** — the route currently buffers the whole body to check
   size and then buffers it again via `arrayBuffer()`.
7. **Normalize the filename** on the way in (it is already stripped to
   `[^\w.\-]`, which is good) and never echo the contractor's raw
   `title` / `document_number` into a controlled register field without review.
8. **Quarantine, then scan.** Land uploads in a separate prefix, scan, and only
   then make them fetchable. Without a scanner, a stored-but-never-inline PDF is
   still a live payload for whoever opens it on their own machine — the
   attachment disposition protects your web origin, not your users' desktops.

---

## Rate limiting and abuse

The door is also an **amplifier**: every upload writes notifications, queues
email, and kicks the drain (`SEC-8`).

1. **Per-token limit** — N uploads per hour, and the lifetime use cap above.
2. **Per-IP limit** — so one actor cannot fan out across many harvested links.
3. **Debounce the notification fan-out** — N uploads in a window produce one
   digest per recipient, not N emails.
4. **Reuse what exists.** The repository already has `signup_attempts` doing this
   shape of work for registration; the intake route is simply not wired to it.
5. **Return 429 with a readable message and a retry hint**, not a 500.
6. **Make the limits configurable** without a code change.

---

## Scope discipline

Related, and cheap to do at the same time — from `SEC-11`:

1. **Validate `assigned_doc_ids` on write**: every id must belong to this org, be
   visible to the writer under the document ACL, and (decide) be scoped to this
   project. It is a bare `UUID[]` with no FK, no CHECK and no trigger today.
2. **Filter by `org_id` on every read** in `app/api/intake/resolve/route.ts`. The assigned-docs
   query omits it; the redline query twenty lines below includes it.
3. **Cap the array length.**
4. **Do not return the raw token to the client** after creation (`SEC-16`) —
   show it once, store a hash, and serve "copy link" from an endpoint that logs
   who copied it.

---

## Suggested order

Ranked by risk removed per unit of work.

| Order | Change | Effort | Removes |
|---|---|---|---|
| 1 | Attachment disposition on presigned downloads | one parameter | The active half of `SEC-1` |
| 2 | Sniff magic bytes; store sniffed type; allowlist | small | `SEC-6`, the rest of `SEC-1` |
| 3 | Mandatory TTL + DB `CHECK` + quote-link field | small | `SEC-5` |
| 4 | Sandbox the viewer iframe | small | `SEC-1` defence in depth |
| 5 | Rate limit + notification debounce | medium | `SEC-8` |
| 6 | Validate `assigned_doc_ids`, org-filter the reads | medium | `SEC-11` |
| 7 | Cap before buffering; single read | small | Memory/DoS surface |
| 8 | Quarantine + malware scan | large | Stored-payload risk |
| 9 | Separate origin for untrusted uploads | large | Structural fix for `SEC-1` |

Items 1–4 can ship together and remove the great majority of the exposure.

---

## Acceptance criteria for the whole set

- A stored `text/html` object **downloads rather than renders**, in Chrome,
  Firefox and Safari.
- A renamed `.exe` is **rejected before it reaches storage**, with a message
  naming the accepted types.
- No code path can create a link with a null or out-of-range `expires_at`; the
  database refuses it.
- An expired or revoked link returns 410 on both routes, and the portal explains
  why.
- The Nth upload in a window returns 429; a burst produces at most one
  notification per recipient per window.
- Assigning a document the writer cannot read is refused.
- The resolve route returns nothing for an id outside the link's org.
- Tests cover: the disposition header, the type allowlist, the TTL constraint,
  the rate limit, and the org filter.
