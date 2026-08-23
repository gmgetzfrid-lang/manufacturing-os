# 04 · Billing, quotas & platform limits

**14 findings** — 5 HIGH · 9 MEDIUM.

Including whether a lapsed org loses access to its own regulated records.

> Each finding survived an adversarial verification pass: a second agent read the
> cited code and tried to refute it. Refuted findings were dropped. A severity set
> by that pass overrides the original.


### Already there — substrate and sound invariants

| Thing | Where | Why it matters |
|---|---|---|
| Stripe webhook signature verification is done correctly: the raw body is read with `req.text()` before any JSON parsing, `stripe.webhooks.constructEvent(body, sig, webhookSecret)` is used, and a verification failure returns 400. The route also refuses to run at all when STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is unset (503). | `app/api/stripe/webhook/route.ts:24-38` | This is the one part of the billing chain that is not trusting the client. Any refactor (adding a body parser, moving to a middleware, switching runtimes) must preserve the raw-body read — every other finding here assumes forged events are impossible. |
| Data portability is deliberately NOT subscription-gated: lib/serverAuth.ts:75-76 documents that export routes must never call assertOrgHasAccess, /api/data-export/run authorizes on role only, and SubscriptionGate's escape-hatch list keeps /admin/billing, /admin/data-export and /profile reachable when lapsed. | `lib/serverAuth.ts:69-77, components/subscription/SubscriptionGate.tsx:10-18 and :29` | This is the correct answer to the product question 'does a billing failure lock a plant out of its own PSM file'. If enforcement is ever switched on, this exemption is the thing that must not be lost — and /admin/storage (the full ZIP with binaries) should be added to it. |
| The R2 measurement refuses to report a floor as a total: a truncated bucket walk is never banded 'ok', in both the cron path and the dashboard path, and a failed walk surfaces as `r2Error` rather than silently falling back to the row-sum estimate. | `lib/storageUsage.ts:192-195, app/api/admin/storage-stats/route.ts:116-128` | This is the exact failure mode that makes a storage metric untrustworthy, and it was consciously closed. Any change to the walk (adding a deadline, caching, scoping to an org prefix) must keep the truncated/failed states distinguishable from a clean zero. |
| All three storage SECURITY DEFINER functions carry `set search_path = public, pg_catalog` and are revoked from public/anon/authenticated with EXECUTE granted only to service_role. | `supabase/migrations/20260805_storage_stats_fn.sql:12,31,40-43; 20260807_dedup_stats_fn.sql:16,33-34; 20261008_storage_estimate_knowledge.sql:37,48-49` | The recurring SECURITY DEFINER search_path defect does not appear in this area. These are the model to copy, not a place to look for the bug. |
| Presigned-URL routes authorize the KEY, not just the session: upload-url, multipart and delete all parse `orgs/<uuid>/` out of the path and require active membership of that org before signing or deleting. | `app/api/storage/upload-url/route.ts:28-45, app/api/storage/multipart/route.ts:39-48, app/api/storage/delete/route.ts:23-40` | Cross-tenant write/delete IDOR on the bucket is closed. Any new storage endpoint must replicate this check — the quota fixes proposed above would touch exactly these routes. |
| `alertBand` is a pure function with unit tests, and the band thresholds (70/90) live in one place. | `lib/storageAlerts.ts:12-17, lib/__tests__/storageAlerts.test.ts` | The band math is not the defect — the numerator (deployment-wide bytes) and denominator (a globally-shared or client-writable ceiling) are. Fixes should change what is fed in, not this function. |
| The maintenance cron is correctly fail-closed on CRON_SECRET and carries explicit time budgets for its long-running steps, and the codebase records that a third vercel.json cron entry breaks deployment on this plan. | `app/api/cron/maintenance/route.ts:51-57, :262, :286-291` | The signup_attempts prune fix belongs as another step inside this handler; adding a cron entry for it would fail every deployment. |


---


<a id="bill-1"></a>

## BILL-1 · A Stripe subscription whose first payment never completed is written as 'trialing' with a paid plan — mapStripeStatus's default branch grants access for `incomplete` and for any future Stripe status

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/stripe/webhook/route.ts:148-162`, `app/api/stripe/webhook/route.ts:49-66`, `app/api/stripe/checkout/route.ts:78-81`, `app/api/data-export/destinations/route.ts:83-95`, `lib/subscription.ts:45-53`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: an `incomplete` (failed-3DS/declined) subscription is persisted as trialing + subscribed_plan='growth', and the default branch also swallows any future Stripe status. One nuance the finding overstates: hasAccess() (lib/subscription.ts:51) still gates trialing on trial_ends_at, and the webhook never touches that column — but hasAccess has no live enforcement caller (see BILL-10), so the operative grant is the plan gate at destinations/route.ts:88, which the finding cites.

**Mechanism.** `mapStripeStatus` enumerates active/trialing/past_due/canceled/incomplete_expired/unpaid/paused and ends `default: return "trialing";`. Stripe's `incomplete` status — the state a subscription sits in when the first invoice's payment requires action or is declined — is not in the switch, so it falls to the default and is stored as `trialing`. The same `customer.subscription.created` handler writes `subscribed_plan` from `sub.metadata?.plan`, and checkout/route.ts:78-81 stamps that metadata (`subscription_data: { metadata: { org_id, plan } }`) at session creation, i.e. before any money moves. The handler's own comment at line 149-151 claims 'We mirror the schema's CHECK constraint exactly' — it mirrors the constraint's value set, not Stripe's status set.

**Failure scenario.** An operator clicks Subscribe → Growth, enters a card that fails 3DS or is declined, and closes the tab. Stripe creates the subscription in status `incomplete` and fires `customer.subscription.created`. The webhook writes `subscription_status='trialing'`, `subscribed_plan='growth'`, `stripe_subscription_id=sub_...`. The org now shows as a trialing workspace on a Growth plan with no payment ever taken, and app/api/data-export/destinations/route.ts:88 (`plan === "growth" || ... || status === "trialing"`) grants the Growth-only S3/R2 cloud-backup destination on both of its two disjuncts. `trial_ends_at` is untouched, so if it was already NULL or in the future the workspace has open-ended access.

**Evidence.**

```
app/api/stripe/webhook/route.ts:161 — `default: return "trialing";` inside mapStripeStatus, whose own comment at :149-150 lists `incomplete` as a real Stripe status. app/api/stripe/webhook/route.ts:56 — `const plan = (sub.metadata?.plan as string) || null;` written unconditionally alongside the mapped status.
```

**Chain reaction.** The default branch is also the forward-compatibility policy: any status Stripe adds later silently becomes 'trialing' — full access — rather than a conservative deny or an alert. Combined with the fact that nothing enforces subscription state at all today (see the SubscriptionGate finding), the immediate blast radius is the plan entitlement rather than app access; the moment enforcement is switched on, the failure direction is 'unpaid gets in', not 'paying customer locked out'.

> **Verifier correction.** Two overstatements. (a) 'grants access' is not general: lib/subscription.ts:51 makes `trialing` conditional on `!isTrialExpired(info)`, so hasAccess still returns false once trial_ends_at has passed; the concrete grant is the destinations gate at data-export/destinations/route.ts:88 (`status === "trialing"`). (b) The `incomplete` window is self-limiting — Stripe transitions an unpaid incomplete subscription to incomplete_expired, which :157 correctly maps to canceled. The durable harm is the paid `subscribed_plan` written at :56, which finding 5 shows is never cleared. HIGH, not CRITICAL.

**Done when.**

- [ ] `incomplete` maps to a non-access state and the default branch denies (or throws) rather than granting 'trialing'
- [ ] subscribed_plan is only written once the subscription reaches a paid status, and is derived from the price id rather than checkout metadata
- [ ] A test covers each Stripe status string, including one unknown value, asserting the stored status

---

<a id="bill-2"></a>

## BILL-2 · Any org Admin can rewrite their own subscription state from the browser — the orgs UPDATE policy has no column restriction, so billing is enforced against a client-writable column

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/schema.sql:1042-1045`, `supabase/schema.sql:393-394 (contrast: archive_settings IS revoked; orgs is not)`, `app/(protected)/admin/settings/page.tsx:108-112`, `components/providers/SubscriptionProvider.tsx:39-53`, `supabase/migrations/20260601_billing.sql:13-20`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by repo-wide search: no WITH CHECK clause, no column-level REVOKE on orgs, and no BEFORE UPDATE trigger on orgs anywhere in supabase/schema.sql or supabase/migrations/*.sql. SubscriptionProvider.tsx:39-53 reads those same columns straight from the client, so an org Admin can set subscription_status/subscribed_plan/trial_ends_at to anything the CHECK constraint in 20260601_billing.sql:14 permits.

**Mechanism.** `CREATE POLICY "orgs_admin_write" ON orgs FOR UPDATE USING (id IN (SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role = 'Admin'))` is the only write policy on orgs. It is FOR UPDATE with only USING, so per the RLS composition rule the USING expression is reused as the INSERT/UPDATE check — and that expression tests only `id`, which the attacker does not change. There is no column-level restriction and no RESTRICTIVE overlay: two differently-shaped searches (`grep -rn -i "on orgs|ON public.orgs" supabase/` and a scan of every `CREATE POLICY` line in supabase/migrations mentioning org) return exactly these two policies. `authenticated` retains the table grant — the app itself proves it, since admin/settings/page.tsx:108 performs a client-side `supabase.from("orgs").update({...})` through PostgREST with the user's JWT and SubscriptionProvider.tsx:40 reads the billing columns the same way. Migration 20260601_billing.sql:13-20 put `subscription_status`, `subscribed_plan`, `trial_ends_at`, `current_period_end`, `stripe_customer_id` and `stripe_subscription_id` on that same row. Every consumer of subscription state (SubscriptionProvider, lib/subscription.ts#hasAccess, lib/serverAuth.ts#assertOrgHasAccess, the SQL helper org_has_active_subscription, and the Growth plan gate in app/api/data-export/destinations/route.ts:85) reads those columns and nothing else.

**Failure scenario.** An org Admin opens devtools and issues one PostgREST call: `supabase.from('orgs').update({ subscription_status: 'active', subscribed_plan: 'growth', trial_ends_at: null }).eq('id', myOrgId)`. RLS allows it (they are Admin of that org, and `id` is unchanged so the reused USING check passes). The workspace now reads as a paying Growth customer forever: TrialBanner disappears (shouldShowTrialBanner requires status 'trialing'), hasAccess returns true, org_has_active_subscription returns true, and the Growth-only cloud-backup destination gate at data-export/destinations/route.ts:88 passes. Stripe was never involved and no invoice exists. Nothing in the codebase ever reconciles the org row against the Stripe API — the webhook is the only writer, and it is push-only.

**Evidence.**

```
supabase/schema.sql:1042 — `CREATE POLICY "orgs_admin_write" ON orgs FOR UPDATE\n  USING (id IN (\n    SELECT org_id FROM org_members WHERE uid = auth.uid() AND status = 'active' AND role = 'Admin'\n  ));`  — no WITH CHECK, no column list, and no REVOKE of orgs from `authenticated` anywhere in supabase/ (grep for `^\s*(grant|revoke)` in schema.sql returns only archive_settings/archives and two function grants).
```

**Chain reaction.** The same hole covers `stripe_customer_id` (see the portal-hijack finding) and `trial_ends_at`. Note the NULL case specifically: lib/subscription.ts:38-42 `isTrialExpired` returns false when `trialEndsAt` is falsy, and the SQL helper at 20260713_document_publish_guard.sql:100-101 treats `trial_ends_at IS NULL` as an active trial, so a NULL trial end is permanent free access AND silences the banner (trialDaysRemaining returns null → shouldShowTrialBanner false). Because the Stripe webhook is the only other writer, an operator inspecting Stripe would see nothing wrong.

> **Verifier correction.** Real mechanism, but CRITICAL overstates the blast radius. This is an org Admin escalating within their OWN org (RLS still pins `id` to orgs they administer) — no cross-tenant reach, no document-control/PSM consequence. And by finding 6 the only place subscription state is actually enforced today is the Growth gate at app/api/data-export/destinations/route.ts:88, which already passes on `status === "trialing"`, so the forged value buys one route's feature flag. Rate as revenue-integrity HIGH, not CRITICAL.

**Done when.**

- [ ] orgs has an explicit column grant (or a BEFORE UPDATE trigger) so `authenticated` cannot write subscription_status, subscribed_plan, trial_ends_at, current_period_end, stripe_customer_id or stripe_subscription_id — only the service role can
- [ ] The orgs UPDATE policy carries an explicit WITH CHECK that pins the billing columns to their OLD values for non-service-role writers
- [ ] A reconciliation path exists (scheduled or on-read) that re-derives subscription state from the Stripe API rather than trusting the row

---

<a id="bill-3"></a>

## BILL-3 · Plan entitlement is read from immutable checkout metadata and never cleared on cancellation — a Customer Portal downgrade keeps Growth features and a canceled org keeps them forever

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/stripe/webhook/route.ts:56`, `app/api/stripe/webhook/route.ts:84-87`, `app/api/stripe/checkout/route.ts:78-81`, `app/api/stripe/portal/route.ts:43-46`, `app/api/data-export/destinations/route.ts:81-95`, `app/api/data-export/run-scheduled/route.ts:63`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both halves. portal/route.ts:43-46 creates a bare billingPortal session with no metadata sync, so a portal-driven plan change leaves subscription metadata (and therefore subscribed_plan) frozen at the original value; cancellation clears the status but not the plan, and the scheduled-push cron re-checks neither.

**Mechanism.** `subscribed_plan` is written only from `sub.metadata?.plan` (webhook:56), and that metadata is stamped once, at checkout session creation (checkout:79 `subscription_data: { metadata: { org_id: orgId, plan: String(plan) } }`). The app explicitly offers the Stripe Customer Portal for plan changes — portal/route.ts's header comment says the admin can 'update their card, see invoices, cancel, or change plan' — but a portal plan change swaps the subscription's price/item and does not rewrite subscription metadata, so the subsequent `customer.subscription.updated` re-writes the SAME stale `metadata.plan`. The webhook never derives the plan from the price id (`getPriceIdForPlan` in lib/stripe.ts:32-36 is used only in the checkout direction, never inverted). On cancellation the handler at :84-87 updates only `subscription_status` and `stripe_subscription_id` — `subscribed_plan` is left untouched. Two searches confirm the webhook is the only writer of that column (`grep -rn subscribed_plan` across ts/tsx/sql, and the client-write census `grep -rn 'from(\"orgs\")'`) — every other hit is a read.

**Failure scenario.** A plant on Growth ($599) downgrades to Starter ($299) in the Stripe Customer Portal. Stripe bills them $299; `subscribed_plan` stays 'growth', so app/api/data-export/destinations/route.ts:88 keeps granting the Growth-only scheduled S3/R2 cloud backup they no longer pay for. The mirror case is worse for the customer: a Starter org that upgrades to Growth through the portal keeps `subscribed_plan='starter'` and is refused the feature it now pays for, with an error telling it to 'Upgrade in Billing'. And an org that cancels outright keeps `subscribed_plan='growth'`: the daily export cron (run-scheduled/route.ts:63 selects destinations `.eq("enabled", true)` with no plan or subscription check at all) keeps pushing the workspace's whole regulated record set to the customer's own S3 bucket indefinitely after they stop paying.

**Evidence.**

```
app/api/stripe/webhook/route.ts:56 — `const plan = (sub.metadata?.plan as string) || null;` ; :84-87 — `await supabase.from("orgs").update({\n          subscription_status: "canceled",\n          stripe_subscription_id: null,\n        }).eq("id", orgId);` (no subscribed_plan) ; app/api/data-export/destinations/route.ts:88 — `const allowed = plan === "growth" || plan === "enterprise" || status === "trialing";`
```

**Chain reaction.** The plan gate at destinations/route.ts is checked only at creation and only when `body.bucket` is truthy (:83). There is no PATCH/PUT on that route (grep for `export async function` returns only GET and POST), so the gate cannot be bypassed by editing a destination — but the run path never re-checks, so any destination that was ever legitimately created (including one created during a trial, which :88 explicitly permits) outlives the entitlement that authorized it. This is the only plan-tier gate in the codebase: the advertised 'Up to 10 users' / 'Up to 25 users' limits (app/(protected)/admin/billing/page.tsx:190,195) are enforced nowhere.

**Done when.**

- [ ] subscribed_plan is derived from the subscription's price id on every subscription.created/updated, not from metadata
- [ ] customer.subscription.deleted clears subscribed_plan (or entitlement checks require an active status as well as a plan)
- [ ] run-scheduled re-checks entitlement before executing a cloud-bucket destination, and disables (not deletes) destinations whose plan lapsed

---

<a id="bill-4"></a>

## BILL-4 · The Stripe webhook discards every write result and always returns 200, and there is no event ledger — a dropped update is invisible and out-of-order events resurrect canceled subscriptions

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/stripe/webhook/route.ts:61-66`, `app/api/stripe/webhook/route.ts:84-87`, `app/api/stripe/webhook/route.ts:97-106`, `app/api/stripe/webhook/route.ts:108-123`, `app/api/stripe/webhook/route.ts:134`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. supabase-js returns PostgREST failures as an `error` field rather than throwing, so a rejected update cannot reach the catch at :129 and the handler still answers 200. A repo-wide grep for a webhook event ledger (`stripe_events`, `stripe_webhook_events`, any store of `event.id`) returns nothing in supabase/, app/, or lib/ — there is no idempotency or ordering guard, so a late `updated` overwrites a `canceled` written by an earlier-processed `deleted`.

**Mechanism.** All four `orgs` updates are bare awaits — `await supabase.from("orgs").update({...}).eq("id", orgId);` — with no `{ error }` destructure. supabase-js resolves rather than throws, so the try/catch at :47-132 cannot see a database failure, and line 134 returns `{ received: true }` with HTTP 200 regardless. Stripe treats 200 as delivered and never retries. Separately, there is no table recording processed Stripe event ids: two searches (`grep -rn "stripe_event|event.id|processed_event|idempot"` across .ts and .sql, and a scan of supabase/migrations for any billing table beyond 20260601_billing.sql) find none. `constructEvent` at :35 enforces only Stripe's 5-minute signature-timestamp tolerance; nothing orders or dedupes the events themselves.

**Failure scenario.** Stripe does not guarantee webhook ordering. A customer cancels; Stripe queues `customer.subscription.updated` (status active, from a moments-earlier proration) and `customer.subscription.deleted`. Delivery arrives deleted-first: the handler sets `subscription_status='canceled'`, then the delayed `updated` arrives and the handler at :55-66 writes `subscription_status='active'`, `stripe_subscription_id=sub_...` back over it. The org is permanently marked active on a subscription Stripe has already ended. The mirror case: `invoice.payment_succeeded` (:102-104) unconditionally forces `subscription_status='active'` for ANY paid invoice on that customer — including a one-off invoice or a $0 proration — with no check that the invoice belongs to the current subscription or that the subscription is live.

**Evidence.**

```
app/api/stripe/webhook/route.ts:102-104 — `await supabase.from("orgs").update({\n          subscription_status: "active",\n        }).eq("id", orgId);` — no error check, no subscription/invoice correlation. Line 134: `return NextResponse.json({ received: true });` is reached on every path.
```

**Chain reaction.** Because the audit inserts also fail (previous finding), a resurrected or dropped state change leaves zero forensic trace on either side of the write. And because the handler returns 200 on a failed update, Stripe's at-least-once retry — the one mechanism that would have healed a transient DB error — is deliberately disarmed.

**Done when.**

- [ ] Every orgs update destructures `error` and a failed write returns a non-2xx so Stripe retries
- [ ] A stripe_events table records processed event ids (unique) and the handler no-ops on a duplicate
- [ ] Subscription-state writes are guarded by the event's created timestamp (or the Stripe object's version) so an older event cannot overwrite a newer state
- [ ] invoice.payment_succeeded only promotes to 'active' when the invoice's subscription matches orgs.stripe_subscription_id

---

<a id="bill-5"></a>

## BILL-5 · The platform storage ceiling is a single global row that any Admin/DocCtrl of any org can overwrite, and the storage dashboard leaks deployment-wide usage across tenants

- **Severity:** HIGH
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/storage-stats/route.ts:158-188`, `app/api/admin/storage-stats/route.ts:24-36`, `app/api/admin/storage-stats/route.ts:114-150`, `lib/storageUsage.ts:53-77`, `lib/storageUsage.ts:131-162`, `supabase/migrations/20260920_per_user_keys_real_limits.sql:23-30`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both halves. The role check only proves membership in *some* org; nothing scopes the write to a platform owner, and STORAGE_LIMITS_KEY is a single global key. The GET at :24-150 returns deployment-wide table sizes, row counts, and per-segment R2 breakdowns (with newest-object timestamps) to any Admin/Manager/DocCtrl of any tenant; loadPlatformLimits (storageUsage.ts:56-77) and runPlatformStorageAlerts then band every tenant off that one shared ceiling.

**Mechanism.** `platform_settings` is keyed by `key TEXT PRIMARY KEY` with no org column (20260920:23-28). storage-stats POST authorizes the caller as Admin/DocCtrl of the org named in the body (:164), then upserts `{ key: STORAGE_LIMITS_KEY, value: {...} }` with `onConflict: "key"` (:174-179) — a single deployment-wide row. `loadPlatformLimits` (lib/storageUsage.ts:56-77) reads that same one row for everyone. On the read side, GET returns `mfg_table_stats()` (per-table sizes and row estimates for the entire public schema, no org filter — 20260805_storage_stats_fn.sql:14-22), `mfg_storage_estimate()` (global sums over document_versions, asset_photos, knowledge_documents), `mfg_dedup_stats()`, an AI-usage count over `ai_usage_events` with no org filter (:104-107), and `measureR2Usage()` — a walk of the whole bucket returning per-segment byte totals, object counts and newest-object timestamps for every tenant (lib/storageUsage.ts:131-162, `ListObjectsV2Command` with no Prefix).

**Failure scenario.** Two plants share the deployment. A DocCtrl at plant B opens Admin → Storage and sets the storage limit; the value lands in the one global row, so plant A's dashboard silently re-bands (their 'Total footprint / limit' watermark and the 70%/90% cron thresholds in runPlatformStorageAlerts now come from a number plant A's admins never chose and cannot see the provenance of — `limitsSource` will read 'settings'). The same DocCtrl reads, from the GET, that the deployment holds N controlled document revisions totalling X GB, when the newest drawing anywhere landed, and the row counts of every table — a competitor-visible measure of plant A's engineering activity. Neither the read nor the write leaves an audit_logs row.

**Evidence.**

```
app/api/admin/storage-stats/route.ts:174-179 — `const { error } = await actor.admin.from("platform_settings").upsert({\n    key: STORAGE_LIMITS_KEY,\n    value: { r2Bytes: Math.round(r2LimitBytes), dbBytes: Math.round(dbLimitBytes) },\n    updated_by: actor.userId,\n    updated_at: new Date().toISOString(),\n  }, { onConflict: "key" });` — the org is used only for the role check at :164, never for scoping.
```

**Chain reaction.** The doc comment at lib/storageUsage.ts:43-47 frames the ceiling as 'admins edit it on the storage page' — accurate for a single-workspace deployment, which is the assumption baked in everywhere in this module, but the route is reachable by every org on a shared instance. The disclosure side compounds the accounting finding below: not only are other tenants' bytes counted against your quota, they are itemized on screen.

> **Verifier correction.** One wording overstatement on the read half: the R2 walk does NOT return per-tenant data. segmentForKey (lib/storageUsage.ts:106-127) buckets by parts[2] — the FEATURE segment of `orgs/<id>/<feature>/...` — so segments are cross-tenant aggregates by file kind ('Controlled document revisions', 'Knowledge library files'), never per-org rows. What leaks is aggregate deployment totals and public-schema row estimates, no row content, and route.ts:1-6 documents the endpoint as 'deployment-wide'. Score this on the global-ceiling write, not on the leak.

**Done when.**

- [ ] The storage ceiling is per-org (key includes the org id, or a column on the org) or the write is restricted to a platform-operator role that org admins cannot hold
- [ ] GET's aggregates are scoped to the caller's org, or the endpoint is restricted to a platform operator
- [ ] Changing a storage ceiling writes an audit_logs row naming the actor and the old/new values

---

<a id="bill-6"></a>

## BILL-6 · A Stripe customer id an org Admin can write is trusted to open a Customer Portal session and to route invoice webhooks

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `app/api/stripe/portal/route.ts:30-46`, `app/api/stripe/checkout/route.ts:53-67`, `app/api/stripe/webhook/route.ts:138-146`, `supabase/schema.sql:1042-1045`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed — no uniqueness constraint and no server-side validation that the id belongs to this org. If anything MEDIUM is understated rather than overstated: beyond the denial path, a malicious Admin at org B who copies org A's cus_… gets a Stripe Customer Portal session for org A's customer and can view A's invoices/billing address and cancel A's subscription.

**Mechanism.** portal/route.ts reads `stripe_customer_id` straight off the org row (:30-35) and creates a `billingPortal.sessions.create({ customer: customerId })` with no verification that the customer belongs to this org beyond the row itself. checkout/route.ts:53 reuses the same field. That field is writable by any org Admin through PostgREST for the reason established in the first finding (orgs UPDATE policy, no column restriction). On the webhook side, `resolveOrgIdFromCustomer` does `.eq("stripe_customer_id", customerId).maybeSingle()` (:140-144) — `maybeSingle()` errors when more than one row matches, and the result is destructured as `const { data }` with the error discarded, so `data` is null and the handler `break`s at :101/:111 without touching any org.

**Failure scenario.** Denial half (mechanism fully in-repo): a malicious Admin at org B sets `stripe_customer_id` to the value already on org A's row. Every subsequent `invoice.payment_succeeded` / `invoice.payment_failed` for org A now matches two rows, `maybeSingle()` returns an error, the discarded-error path yields null, and org A's payment events are silently dropped — org A pays and is never marked active, or fails payment and is never marked past_due. Hijack half (requires obtaining the id): if the attacker learns another tenant's `cus_...` id, the portal route mints them a Stripe-hosted session for that customer — invoices, billing address, card last-4, and a cancel button for a subscription they do not own. The customer id is not exposed by any route in this repo, so that half is unverified from the code alone.

**Evidence.**

```
app/api/stripe/portal/route.ts:43-46 — `const session = await stripe.billingPortal.sessions.create({\n    customer: customerId,\n    return_url: `${origin}/admin/billing`,\n  });` ; app/api/stripe/webhook/route.ts:140-144 — `const { data } = await supabase\n    .from("orgs")\n    .select("id")\n    .eq("stripe_customer_id", customerId)\n    .maybeSingle();` — error discarded.
```

**Chain reaction.** There is no unique index on `orgs.stripe_customer_id` (20260601_billing.sql:31 creates only a partial non-unique index), so the DB does not prevent the collision either. Fixing the orgs RLS column exposure closes both halves at once.

> **Verifier correction.** HIGH overstates it because the cross-tenant portal hijack needs a `cus_...` id the attacker cannot discover from the app: orgs SELECT is org-scoped (schema.sql:1040) and SubscriptionProvider.tsx:40 only ever reads the caller's own org row, so no path exposes another tenant's customer id. What IS reachable without any secret is self-directed — an Admin nulls or corrupts their own stripe_customer_id so invoice.payment_failed can never resolve their org and their status stays put — and that is really finding 1's consequence, not an independent one. Keep as MEDIUM/SUSPECTED.

**Done when.**

- [ ] stripe_customer_id is not writable by any client role (see the orgs RLS finding)
- [ ] A UNIQUE index exists on orgs(stripe_customer_id) WHERE NOT NULL
- [ ] resolveOrgIdFromCustomer checks the error from maybeSingle and alerts on an ambiguous match rather than silently dropping the event
- [ ] The portal route verifies the customer's metadata.org_id matches the requested org before creating a session

---

<a id="bill-7"></a>

## BILL-7 · Changing the storage quota or the plan ceiling — the numbers that drive every storage alert — writes no audit record

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/admin/archive-settings/route.ts:33-56`, `app/api/admin/storage-stats/route.ts:158-188`, `lib/storageAlerts.ts:38-51`, `lib/storageUsage.ts:56-77`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by reading both handlers end to end and by grepping supabase/schema.sql and supabase/migrations/*.sql for any trigger or audit hook on archive_settings / platform_settings — there is none. Both numbers feed the alerting math directly (lib/storageAlerts.ts:38-51 reads quota_bytes; lib/storageUsage.ts:56-77 reads the platform ceiling), so raising either silences alerts with no record of who moved it.

**Mechanism.** `archive-settings` PUT authorizes Admin/DocCtrl, builds a patch including `quota_bytes` (:46-49) and upserts — with no `audit_logs` insert anywhere in the file. `storage-stats` POST does the same for the deployment-wide `platform_settings` ceiling: it records `updated_by`/`updated_at` on the row itself (:177-178), which is last-writer-only state, not a trail. Both values are the denominator in `alertBand`, so they determine whether the 70%/90% watchdog fires at all.

**Failure scenario.** A workspace is at 95% of a 10 GB quota and its admins are being alerted weekly. An admin raises the quota to 100 GB in a two-field form. Every alert stops, the page turns green, and there is no record that the ceiling moved — `archive_settings` holds only the new value and an `updated_by` uuid, and the audit trail an operator would search shows nothing. Six months later, when the bucket has silently blown past the real Cloudflare plan, nothing in the system can say when or by whom the guard rail was moved.

**Evidence.**

```
app/api/admin/archive-settings/route.ts:51-56 — `const { error } = await actor.admin\n    .from("archive_settings")\n    .upsert(patch, { onConflict: "org_id" });\n\n  if (error) return NextResponse.json({ error: error.message }, { status: 500 });\n  return NextResponse.json({ ok: true });` — the error IS checked here (good), but no audit row is written. The file contains no reference to audit_logs.
```

**Chain reaction.** Compare the storage page's own copy at app/(protected)/admin/storage/page.tsx:863 — 'Admins are alerted at 70% / 90%.' — which presents the threshold as a property of the system rather than a setting one admin can move unrecorded. Combined with the global-row finding, on a shared deployment the person who moves the ceiling need not even be an admin of the affected org.

**Done when.**

- [ ] archive-settings PUT and storage-stats POST each write an audit_logs row with the old and new values
- [ ] Those rows survive a real insert (i.e. a valid uuid user_id — see the Stripe audit finding for the failure mode)

---

<a id="bill-8"></a>

## BILL-8 · Checkout can mint a duplicate Stripe customer and a second live subscription — nothing checks for an existing subscription before creating one

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/stripe/checkout/route.ts:53-67`, `app/api/stripe/checkout/route.ts:72-84`, `app/(protected)/admin/billing/page.tsx:184`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. The load-bearing claim — a second live subscription on the same customer, with no existing-subscription check — is confirmed. One correction to the title, not the severity: the duplicate-*customer* half only occurs under a concurrent race, since :53-67 reuses `org.stripe_customer_id` when present and only creates a customer when it is null.

**Mechanism.** The route reads `org.stripe_customer_id`; if falsy it creates a Stripe customer and writes it back with an unchecked `await auth.admin.from("orgs").update({ stripe_customer_id: customerId })` (:63-66) — read-then-write with no uniqueness constraint and no transaction. It then creates a Checkout Session with no check of `subscription_status` or `stripe_subscription_id`. The UI's only guard is client-side: the plans grid renders when `info?.status !== "active"` (billing/page.tsx:184), which is true for `past_due`, `canceled`, `unpaid`, `paused` and `trialing`.

**Failure scenario.** An org is `past_due` after one declined renewal. The billing page still shows the plans grid, so the admin — reasonably reading 'Payment Past Due' as 'pay again here' — clicks Subscribe. Stripe creates a SECOND subscription on the same customer alongside the past-due one; the org is now billed twice per month, and the webhook overwrites `stripe_subscription_id` with the new one so the app can no longer see or manage the old subscription (the portal will show both, but the app's own state points at one). Separately, two admins clicking Subscribe concurrently on a fresh org both pass the `!customerId` branch and create two Stripe customers; whichever update lands last wins the org row, and any invoice on the losing customer resolves to no org at webhook time (resolveOrgIdFromCustomer returns null → `break`).

**Evidence.**

```
app/api/stripe/checkout/route.ts:72-84 — `const session = await stripe.checkout.sessions.create({ customer: customerId, mode: "subscription", ... })` with no preceding read of subscription_status or stripe_subscription_id; :63-66 — `await auth.admin\n      .from("orgs")\n      .update({ stripe_customer_id: customerId })\n      .eq("id", orgId);` with the result discarded.
```

**Chain reaction.** The unchecked write at :63 is the same supabase-js `{error}`-not-thrown pattern: if it fails, the route proceeds to create a Checkout Session for a customer id the org row does not record, so a successful payment produces invoice events that resolve to no org and a subscription the app can never surface.

**Done when.**

- [ ] Checkout refuses (409) when the org already has a stripe_subscription_id in a live state, and the UI directs past_due/unpaid orgs to the portal instead of the plans grid
- [ ] The customer-id write is checked, and a unique index on orgs(stripe_customer_id) makes the concurrent-create race fail loudly
- [ ] Customer creation uses a Stripe idempotency key derived from the org id

---

<a id="bill-9"></a>

## BILL-9 · Every Stripe billing audit_logs insert fails silently — `user_id: "stripe"` is written into a UUID column and the error is never read, so subscription changes leave no record

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `app/api/stripe/webhook/route.ts:68-76`, `app/api/stripe/webhook/route.ts:88-93`, `app/api/stripe/webhook/route.ts:116-121`, `supabase/schema.sql:777`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed. PostgREST rejects the literal 'stripe' with `invalid input syntax for type uuid`, supabase-js surfaces that as a returned `error` (not a throw, so the catch at :129 never fires), and nothing reads it. A repo-wide grep of supabase/migrations/*.sql finds no ALTER changing audit_logs.user_id to TEXT and no cast. Worth noting the gap is slightly wider than stated: `invoice.payment_succeeded` (:97-106) attempts no audit row at all.

**Mechanism.** `audit_logs.user_id` is declared `UUID` (supabase/schema.sql:777). All three webhook audit inserts pass the literal string `"stripe"`. Postgres rejects it with 22P02 (`invalid input syntax for type uuid`). supabase-js resolves with `{error}` instead of throwing (`shouldThrowOnError = false`; established in audit-reports/drafting-flow/10-audit-evidence.md finding 1 with the same 22P02 mechanism for an empty-string userId at lib/reviewControl.ts:558), and each call here is a bare `await supabase.from("audit_logs").insert({...})` with no destructure of `error` and no `.throwOnError()`. Nothing logs, nothing retries, and the handler falls through to `return NextResponse.json({ received: true })` at line 134.

**Failure scenario.** An org's card is declined and Stripe fires `invoice.payment_failed`. The webhook flips `subscription_status` to 'past_due' and attempts to write an `STRIPE_INVOICE_PAYMENT_FAILED` audit row; the insert fails on the uuid cast and is discarded. Three months later, in a billing dispute or a PSM audit of who changed the workspace's entitlements and when, `/admin/audit` and lib/evidencePack.ts show nothing at all for the entire Stripe lifecycle — no subscription created, no cancellation, no payment failure. The subscription_status column shows the current value with no history, and the operator cannot distinguish 'no billing event ever happened' from 'every billing event failed to record'.

**Evidence.**

```
app/api/stripe/webhook/route.ts:73 — `user_id: "stripe",` ; supabase/schema.sql:777 — `  user_id UUID,` ; app/api/stripe/webhook/route.ts:68 — `await supabase.from("audit_logs").insert({` with no `const { error } =`.
```

**Chain reaction.** The only Stripe write that *is* audited from an authenticated path — `STRIPE_CHECKOUT_CREATED` at app/api/stripe/checkout/route.ts:86-95 — passes a real `auth.userId`, so it succeeds. The result is an audit trail that records intent to subscribe but never records the outcome: checkout-created rows with no matching created/deleted/failed rows, which reads as 'nobody ever completed checkout'.

> **Verifier correction.** Severity overstated at HIGH. The lost records are billing-event metadata, not the PSM/document-control audit trail (that is written elsewhere with real UUIDs). Consequence is forensic only: no operational, safety, or access-control effect. MEDIUM.

**Done when.**

- [ ] The webhook writes a NULL user_id (or a dedicated system UUID) rather than the string 'stripe'
- [ ] All three inserts destructure and log `error`, and a failed audit write is surfaced (non-200 so Stripe retries, or an alert)
- [ ] A row appears in audit_logs for a simulated subscription.created, subscription.deleted and invoice.payment_failed against a real schema

---

<a id="bill-10"></a>

## BILL-10 · Nothing enforces subscription state anywhere: SubscriptionGate is disabled by a hardcoded constant, and both server-side gates have zero callers

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `components/subscription/SubscriptionGate.tsx:3-8`, `components/subscription/SubscriptionGate.tsx:46-48`, `lib/serverAuth.ts:69-98`, `supabase/migrations/20260713_document_publish_guard.sql:90-106`, `app/(protected)/layout.tsx:52-72`, `app/api/admin/create-user/route.ts:21-72`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed by census. `grep -rn assertOrgHasAccess` across the repo (excluding audit-reports) returns exactly one hit — the definition at lib/serverAuth.ts:78; `grep -rn org_has_active_subscription` over supabase/ + app/ + lib/ returns exactly one hit — the CREATE at 20260713_document_publish_guard.sql:96. app/api/admin/create-user/route.ts:21-72 checks bearer token, role validity, and caller role only — no subscription check and no seat cap (a grep for seat/max_users/userLimit finds no enforcement anywhere).

**Mechanism.** SubscriptionGate.tsx:46 declares `const ENFORCE = false;` and line 48 short-circuits on it: `if (!ENFORCE || loading || hasAccess(info)) return <>{children}</>;`. Every line below is unreachable. The file's own header (lines 3-8) says 'SubscriptionGate — the enforcement that was missing… an expired trial showed a red banner and nothing else, so lapsed orgs kept full access' — which remains exactly the current behaviour. The two server-side gates are dead as well: `assertOrgHasAccess` (lib/serverAuth.ts:78), whose doc comment says it is the gate 'for billable mutations (e.g. adding seats)', has zero callers — confirmed by `grep -rn assertOrgHasAccess` and by a second, wider `grep -rn OrgHasAccess` across ts/tsx, both returning only the definition. The SQL helper `org_has_active_subscription` (20260713:96) likewise has zero callers — confirmed by a .sql/.ts/.tsx grep and by a second search for `rpc("org_`. The seat-adding route it names, app/api/admin/create-user/route.ts, verifies role (:62-72) and never calls it or counts members.

**Failure scenario.** A workspace's 60-day trial expires and its card is never added. TrialBanner turns red; nothing else changes. The org continues to create documents, publish revisions, add unlimited users, and consume R2 and Postgres indefinitely, at full cost to the operator, with no dunning path beyond a banner. Conversely — and this is the direction that matters for a PSM system — the moment someone flips ENFORCE to true, the enforcement they get is a client-render curtain: SubscriptionGate wraps only `{children}` inside `<main>` (layout.tsx:67), so Sidebar, TopBar, GlobalCommandPalette, NotificationListener and CornerDock keep rendering outside it, and because it is a browser component every API route and every direct PostgREST call remains fully open. The blocked screen would be a cosmetic overlay, not a boundary.

**Evidence.**

```
components/subscription/SubscriptionGate.tsx:46-48 — `  const ENFORCE = false;\n\n  if (!ENFORCE || loading || hasAccess(info)) return <>{children}</>;` ; lib/serverAuth.ts:70 — `* Server-side subscription gate for billable mutations (e.g. adding seats).` with no call site.
```

**Chain reaction.** This is the same 'comment describing behaviour that was never implemented' shape the earlier audits found (the sidebar badge doorway, the push_subscriptions cron). Three separate layers — client gate, server helper, DB helper — were each built and each left unwired, which makes the codebase read as if billing is enforced in depth when it is enforced nowhere. Note the one genuinely good decision here: the escape-hatch design at SubscriptionGate.tsx:29 keeps /admin/billing, /admin/data-export and /profile reachable, and lib/serverAuth.ts:75-76 documents that export routes must never be subscription-gated — so a lapsed plant would still get its PSM file out. But /admin/storage, which hosts the full ZIP backup including binaries, is NOT on that list, and the 'Export your data' link is shown to every role while /admin/data-export is Admin/Manager/DocCtrl-only (app/(protected)/admin/data-export/page.tsx:74).

> **Verifier correction.** The framing is cherry-picked and the severity inflated. The finding quotes the file header (lines 3-8) as if it contradicts current behaviour while omitting the adjacent comment at :40-45 that explicitly explains the off state ('Hard-blocking is OFF by default... Flip ENFORCE to true when you actually want to gate access'). Likewise migration 20260713:90-95 labels the SQL helper '── Subscription helper (NOT wired to any blocking policy yet) ──' and says wiring it 'should be validated in staging (it can lock out a workspace if mis-scoped)'. Two of the three 'dead gates' are documented, deliberate scaffolding; only assertOrgHasAccess is genuinely orphaned against its own docstring. MEDIUM.

**Done when.**

- [ ] Enforcement is a deliberate, documented decision rather than a dead constant — either the gate is removed or it is switched on with the server-side checks wired first
- [ ] assertOrgHasAccess is called by the routes that mint seats and billable resources, or deleted
- [ ] Any lockout is enforced server-side (route + RLS), with /admin/storage's full backup added to the escape hatches and the export link hidden from roles that cannot use it

---

<a id="bill-11"></a>

## BILL-11 · Quota is advisory only — nothing refuses a write at the ceiling, while the alert copy tells admins uploads are about to start failing

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/storageUsage.ts:224-227`, `app/api/storage/upload-url/route.ts:47-55`, `app/api/storage/multipart/route.ts:50-58`, `app/api/admin/archive-settings/route.ts:46-49`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed: the quota is display-and-notify only, and the dedupe at storageAlerts.ts:56-59 does suppress re-alerting for seven days. Minor imprecision in the finding, not in the conclusion: the quoted "before uploads start failing" copy at storageUsage.ts:224-227 belongs to the *platform* R2 ceiling alert, while the per-org quota's copy is the storageAlerts.ts:63 line.

**Mechanism.** Two differently-shaped searches find no enforcement point: `grep -rniE "quota|over_limit|storage_full|limitBytes"` across app/api/storage/, app/api/knowledge/, lib/storage.ts and lib/knowledge.ts returns a single unrelated comment (lib/knowledge.ts:858), and `grep -rniE "exceed|full|too large|MAX_.*BYTES|maxBytes"` across app/api/storage/ and lib/storage.ts returns nothing at all. `upload-url` and `multipart` authorize identity and key ownership and then sign the PUT unconditionally. `archive_settings.quota_bytes` and the `platform_settings` ceiling feed only `alertBand` (bands, colours, notifications).

**Failure scenario.** An org sets a 10 GB quota matching its R2 plan. It crosses 90%; admins get one notification, deduped so they will not be reminded for another seven days (storageAlerts.ts:56-59). Uploads continue at full speed. The bucket passes the real Cloudflare ceiling, and the first symptom the plant sees is a presigned PUT failing mid-upload of a controlled revision — with no in-app explanation, since the app never knew about the limit it was signing past.

**Evidence.**

```
lib/storageUsage.ts:226 — the alert body ends `"or archive old revisions from Admin → Storage before uploads start failing."` — implying the app enforces a ceiling it never checks. app/api/storage/upload-url/route.ts:47-53 signs the PutObjectCommand with no usage check between the membership check at :42 and the signature.
```

**Chain reaction.** Because the quota is never a gate, the alert's dedupe window (7 days per person per resource) is the entire feedback loop: one notification, then silence for a week while the bucket keeps growing.

**Done when.**

- [ ] upload-url and multipart consult current usage against the org's quota and refuse (413/402) with an actionable message when over, or
- [ ] The product explicitly documents the quota as advisory and the alert copy stops claiming uploads will fail

---

<a id="bill-12"></a>

## BILL-12 · Storage usage is measured deployment-wide but charged against each org's own quota — another tenant's uploads push your workspace into 'critical'

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `lib/storageAlerts.ts:25-69`, `lib/storageAlerts.ts:36`, `lib/storageAlerts.ts:45-51`, `app/(protected)/admin/storage/page.tsx:766-772`, `lib/storageUsage.ts:210-263`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed, and the path is live: app/api/cron/maintenance/route.ts:121 calls `runStorageAlerts(sb)` daily. The 'exact for the common single-workspace deployment' caveat in the doc comment at storageAlerts.ts:19-24 is an acknowledgement of the bug, not a guard — nothing scopes usedBytes to s.org_id.

**Mechanism.** `runStorageAlerts` computes ONE `usedBytes` for the whole deployment — `mfg_table_stats()` summed over every table in the public schema plus `mfg_storage_estimate()` summed over every org's document_versions and asset_photos (lines 27-36) — then loops every org that has set `archive_settings.quota_bytes` and calls `alertBand(usedBytes, quota)` with that same global number for each (line 49). The admin page does the same arithmetic client-side: `const usedBytes = (stats?.db.totalBytes ?? 0) + (stats?.r2Real?.bytes ?? stats?.r2Estimate.totalBytes ?? 0);` compared against `budgetBytes = isRealQuota ? quotaBytes : SOFT_BUDGET_BYTES` (page.tsx:768-771), rendered as 'Total footprint — X / Y limit'. The function's own docstring at storageAlerts.ts:22-23 concedes it: 'Usage is deployment-wide (DB + R2 estimate) — exact for the common single-workspace deployment.'

**Failure scenario.** Plant A sets a 10 GB quota to match its R2 plan and sits at 2 GB. Plant B, on the same deployment, uploads an 8 GB laser scan. Plant A's admins get a 'Storage critical — 100% full' notification telling them to 'Take a full backup and free up space (archive superseded revisions, purge disposable rows)' — advice that, followed, destroys plant A's own retained revisions to relieve pressure created entirely by another tenant. Plant A's storage page shows the same red watermark, itemized down to segments that are not theirs. Every org with a quota set is alerted simultaneously.

**Evidence.**

```
lib/storageAlerts.ts:36 — `const usedBytes = dbBytes + r2Bytes;` computed once, outside the per-org loop that begins at :45, and passed to `alertBand(usedBytes, quota)` at :49 for each org. app/(protected)/admin/storage/page.tsx:770-771 — `const usedBytes = (stats?.db.totalBytes ?? 0) + (stats?.r2Real?.bytes ?? stats?.r2Estimate.totalBytes ?? 0);\n  const pct = Math.min(100, Math.round((usedBytes / budgetBytes) * 100));`
```

**Chain reaction.** Two independent alert systems run off the same daily cron with overlapping semantics and different numbers: `runStorageAlerts` (step 3, maintenance/route.ts:121, kind 'storage_alert', per-org quota, RPC estimate) and `runPlatformStorageAlerts` (step 9, :280, kinds 'storage_platform_r2'/'storage_platform_db', global plan ceiling, real bucket walk). The same admin can receive both, with different percentages for the same underlying bytes, and nothing on either notification says which measurement it came from.

> **Verifier correction.** Overstated at HIGH. The error is strictly one-directional — global usage >= any single org's usage — so it over-reports and can only produce false alarms and an inflated bar, never a green dashboard hiding a real overrun. Nothing is blocked by the band (see finding 9), so the consequence is misleading numbers and spurious weekly notifications. MEDIUM.

**Done when.**

- [ ] Per-org usage is measured per-org (R2 walk scoped to `orgs/<id>/`, DB sums grouped by org_id) before being compared to that org's quota
- [ ] The two alerting paths are reconciled so an admin cannot receive two different percentages for the same storage on the same day
- [ ] The storage page labels whether the footprint shown is workspace-scoped or deployment-scoped

---

<a id="bill-13"></a>

## BILL-13 · The R2 bucket walk has no time budget and runs inside a user-facing request — up to 500 sequential list round trips with no maxDuration

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** SUSPECTED
- **Locations:** `lib/storageUsage.ts:131-162`, `app/api/admin/storage-stats/route.ts:14`, `app/api/admin/storage-stats/route.ts:120-124`, `app/api/cron/maintenance/route.ts:279-284`, `lib/storageUsage.ts:184-189`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed the absence claim: grepping `maxDuration` across app/ shows ~25 routes that set it (cron/maintenance:41 = 300, data-export/run-scheduled:18 = 300) and storage-stats is not among them, and vercel.json contains only `ignoreCommand` and `crons` — no functions.maxDuration default. So the interactive path runs an unbounded 500-round-trip walk under the platform's default timeout while the cron path that calls the same function (maintenance:279-284) gets 300s.

**Mechanism.** `measureR2Usage(maxPages = 500)` loops `ListObjectsV2Command` with `MaxKeys: 1000` sequentially, bounded only by a page count — no deadline, no budget parameter, no abort. storage-stats/route.ts declares `export const runtime = "nodejs"` (:14) but no `maxDuration`, unlike every other long-running route in the repo (cron/maintenance sets `maxDuration = 300` at :41, data-export/run sets 300 at :12). The GET calls it on every dashboard load (:121), and the cron calls it again through `runPlatformStorageAlerts` → `measurePlatformStorage` (:185).

**Failure scenario.** At ~100k objects the walk is 100 sequential round trips to Cloudflare; at the 500-page cap it is 500. The admin storage page hits the platform's default function timeout and returns a gateway error, so the one screen that tells an operator how close they are to their storage ceiling stops working precisely as the bucket gets large enough for the ceiling to matter. The truncation guard at :195 ('never band a truncated measurement below warn') protects against a *complete* walk that hit the page cap, but there is no equivalent for a walk that was killed mid-flight — that path throws and lands in `r2Error` (:126-127), which the UI renders as a measurement failure.

**Evidence.**

```
lib/storageUsage.ts:157-159 — `token = res.IsTruncated ? res.NextContinuationToken : undefined;\n    pages++;\n  } while (token && pages < maxPages);` — the only bound is `pages`. Contrast lib/knowledge ingest, which the cron budgets explicitly: `deadlineMs: Date.now() + 40_000` (app/api/cron/maintenance/route.ts:262).
```

**Chain reaction.** The module header at lib/storageUsage.ts:8-10 justifies the cost as 'measuring daily costs effectively nothing against the free tier's 1M ops/month' — but it is not daily: it runs on every admin storage page load AND in the cron, so the class-A op count scales with how often admins look at the page, not with the day.

**Done when.**

- [ ] measureR2Usage accepts a deadline and returns `truncated: true` when it stops on time rather than throwing
- [ ] storage-stats declares an explicit maxDuration consistent with the walk's worst case, or the walk is moved off the request path and served from a cached cron measurement

---

<a id="bill-14"></a>

## BILL-14 · signup_attempts grows without bound and its prune function is never called, while the trial itself is bounded only by a fail-open per-IP counter

- **Severity:** MEDIUM
- **Status:** OPEN
- **Verification:** CONFIRMED
- **Locations:** `supabase/migrations/20261010_signup_rate_limit.sql:34-40`, `app/api/auth/signup/route.ts:31-34`, `app/api/auth/signup/route.ts:19-29`, `app/api/auth/signup/route.ts:103-114`
- **Independently verified:** ✓ **SURVIVES** — second independent adversarial pass. Confirmed on both halves. A repo-wide grep for `prune_signup_attempts` returns exactly one hit — the CREATE at :37 — and app/api/cron/maintenance/route.ts contains no rpc call to it (its only prune is `intent-prune` at :134), so the rolling-window table accumulates forever behind the `(ip, created_at DESC)` index at :28-29. The limiter fails open on any query error and on a missing/unparseable client IP, and 60-day trial orgs are minted at signup/route.ts:103-114 with no other cap.

**Mechanism.** The migration defines `prune_signup_attempts()` and comments 'the maintenance cron can call this, and it's safe to run anytime' (lines 34-36). It is never called: two differently-shaped searches — `grep -rn "prune_signup_attempts|signup_attempts"` across .ts (hits only the signup route, lib/schemaExpectations.ts and lib/exportTables.ts) and a .sql/.tsx/.mjs grep (hits only the migration that defines it) — find no invocation, and app/api/cron/maintenance/route.ts contains no `rpc(` call at all. Meanwhile every well-formed signup POST inserts a row (:60, `recordSignupAttempt(ip, String(email), "attempt")`) with a fire-and-forget `.then(() => undefined, () => undefined)`. The limiter itself returns false — allow — when the IP is 'unknown' (:20) and when the count query errors (:27).

**Failure scenario.** The row that guards signups is never pruned, so a table whose entire purpose is a rolling one-hour window accumulates forever, indexed on (ip, created_at DESC), and counts against the very Supabase database ceiling the platform watchdog measures and alerts on. Separately, the trial economics: 8 signups per IP per hour, each minting a 60-day trial workspace, bounded further only by case-insensitive org-name uniqueness (:63-74) and email uniqueness against the `users` table — and, per the SubscriptionGate finding, that 60-day trial is never enforced when it expires, so a trial workspace is indistinguishable from a permanent free workspace.

**Evidence.**

```
supabase/migrations/20261010_signup_rate_limit.sql:37-40 — `CREATE OR REPLACE FUNCTION prune_signup_attempts() RETURNS void\nLANGUAGE sql AS $$\n  DELETE FROM signup_attempts WHERE created_at < NOW() - INTERVAL '2 days';\n$$;` — defined, documented as cron-callable, zero call sites.
```

**Chain reaction.** This is the 'comment describing behaviour that was never implemented' pattern again, and it lands squarely on the platform-limits lens: an unbounded append-only table inside the metered resource. Note the deployment constraint — the fix cannot be a new vercel.json cron entry, since a third entry fails every deployment on this plan (app/api/cron/maintenance/route.ts:286-291); it belongs as another step inside the existing maintenance handler.

**Done when.**

- [ ] The maintenance cron calls prune_signup_attempts() (as a step in the existing handler, not a new vercel.json cron entry)
- [ ] The signup limiter's fail-open branches are deliberate and documented, or tightened
- [ ] Trial expiry has a defined consequence

---
