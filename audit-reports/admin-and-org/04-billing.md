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
- **Status:** RESOLVED
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

**Resolution (2026-10-02, admin-and-org Round G).** Package P4. Reproduced on `f5073fc`: `app/api/stripe/webhook/route.ts:165` `default: return "trialing";`. An `incomplete` `customer.subscription.created` was stored `trialing` with `subscribed_plan` `growth`, and an unknown status was stored `trialing` too. The tests "incomplete (first payment never completed)…" and "an unknown future status…" failed against the base.

Fix (`DEC-98` §1):
- **One status map.** `lib/subscription.ts mapStripeStatus` (`:101`):
  - `active` / `trialing` / `past_due` / `canceled` / `unpaid` / `paused` as before, and `incomplete_expired` → `canceled` as before;
  - `incomplete` → `unpaid`;
  - any status this code does not know → `unpaid` with `known: false`, logged and recorded on the audit row (`details.status_unknown`).

  No status that means "no payment taken", and no unknown one, maps to `active` or `trialing`. Every value the map can store is one of the orgs CHECK's six (`20260601`; no later migration redefines it). Both are pinned.
- **The plan is written only on a status that pays for it.** That is `active`, `trialing` or `past_due` (`PLAN_HOLDING_STRIPE_STATUSES`, route `:267`). The plan still comes from `XEDGE-14`'s `planFromSubscription`, kept as it is: the price id first, metadata only as its fallback for an unmapped price, and a null plan never written. An incomplete subscription's plan goes on the audit row as `plan_withheld` and is not written.
- **An incomplete subscription's id is not written either** (`LIVE_STRIPE_STATUSES`, `:273`): Stripe will not bill it. So `BILL-8`'s checkout refusal does not block the admin's retry with another card, and its later `incomplete_expired` cannot take over a workspace that has since subscribed (`BILL-4`'s cross-subscription guard).
- Files: `lib/subscription.ts`, `app/api/stripe/webhook/route.ts`.
- Tests (`lib/__tests__/stripeWebhook.test.ts`):
  - "BILL-1 — the status map": each status and an unknown one, the CHECK subset, and the sets against `hasAccess`;
  - "through the webhook: Stripe %s is stored as %s": nine statuses through the real route, the stored status and plan;
  - "an incomplete first checkout…": stored `unpaid` with no id and no plan; its first invoice's `payment_failed` is ignored; a second, paid subscription takes over; the old one's `incomplete_expired` is superseded. *(Corrected at the review fix pass, below: the first step is now `superseded`, and the app's trial is kept.)*

*Review fix pass (2026-10-02, admin-and-org Round G, P4).* A declined first checkout no longer ends the app's own trial.
- **The gap.** The first version applied a non-access status to a workspace on the subscription or on none. A subscription that never started is never written as the workspace's (no id), so on a workspace in the app's trial (no subscription id) `incomplete` set `unpaid`, and Stripe's `incomplete_expired` 23 hours later set `canceled`. The trial was lost for good, contrary to `DEC-98` §6. The residual below said the workspace read `unpaid` "until it pays or Stripe expires the attempt", which suggested it recovered.
- **The fix.** A subscription that never started (`incomplete`, `incomplete_expired`: `lib/subscription.ts UNSTARTED_STRIPE_STATUSES`) or a status this code does not know now changes only a workspace already on that subscription (`app/api/stripe/webhook/route.ts:284`, guard `allowNone: false`). Otherwise the event is recorded `superseded`, and the trial goes on. The map is unchanged. On a workspace already on such a subscription (a row the old code wrote), `incomplete` and an unknown status are stored `unpaid`, and `incomplete_expired` is stored `canceled` with its plan cleared (`BILL-3`). An unknown status is now logged even when it is superseded.
- **Tests** (`lib/__tests__/stripeWebhook.test.ts`), each failing on the reviewed head `6133d8a`:
  - "a declined first checkout leaves the app's trial running…": `incomplete` superseded with the trial kept; then the retry that pays takes over; and, with no retry, `incomplete` then `incomplete_expired` leave the trial exactly as it was (`trial_ends_at` untouched, no audit row).
  - "an unknown status for a subscription the workspace is not on changes nothing, and is logged".
  - The per-status table ("through the webhook: Stripe %s is stored as %s") now runs on a workspace on the subscription, the case the map's value is stored in.

*Second review fix pass (2026-10-02, admin-and-org Round G, P4).* Two gaps remained. Each was reproduced through the real route on the reviewed head `a23d537`, and each test below fails there.
- **A workspace that had just paid read `unpaid` (blocker).**
  - *How it happened.* Checkout creates the subscription `incomplete` and makes it `active` once the card is paid, usually within the same second (`event.created` has one-second resolution). Stripe does not order deliveries, and any failed first delivery of `created` (a 503 from the lock, a timeout, a 500) is retried after the `active` update. Handled last, the `created` (incomplete) passed the ordering read, which is strictly older. It also passed the guard above, because the workspace was now on that subscription. The workspace read `unpaid` until its next invoice, about a month later.
  - *The fix.* Stripe never moves a subscription back to `incomplete`, and two rules now follow from that:
    - On a workspace already on the subscription, an `incomplete` snapshot moves only the row the old code wrote for it (`trialing`) or an earlier incomplete snapshot's `unpaid` (`INCOMPLETE_MOVES`, `app/api/stripe/webhook/route.ts:100`; the guard's `fromStatuses`, `:291`). Otherwise it is recorded `superseded`. This holds before `20261175` is pasted too.
    - With the ledger, an `incomplete` snapshot also counts a recorded subscription event of its own second as newer (`readLedger`, `:438`, `.gte`), and is recorded `stale` (`BILL-4`).
- **A declined checkout's deletion ended the trial (major).**
  - *How it happened.* `customer.subscription.deleted` applied `canceled` to a workspace on that subscription or on none, whatever the subscription's status. Suppose Stripe reports a declined checkout's expiry as a deletion (status `incomplete_expired`). Then the app's own trial was cancelled, against `DEC-98` §6. Whether Stripe sends that deletion could not be confirmed here (its documentation was not reachable), so the rule is defensive.
  - *The fix.* The deleted branch now uses the update's rule (`:331`, `allowNone: !ownOnly`): a subscription that never started, or an unknown status, ends only a workspace already on it. A real cancellation (`canceled`) ends the workspace's subscription, or a workspace on none, as before. The deletion's audit row now names Stripe's status (`stripe_status`).
  - *Correction.* This corrects the first review fix pass above. It said a declined first checkout's expiry leaves the trial untouched, but that held only when the expiry arrived as an update.
- **Tests** (`lib/__tests__/stripeWebhook.test.ts`):
  - "an incomplete snapshot never overwrites a workspace that moved on":
    - `updated` (active, T) then `created` (incomplete, T) → active, and the snapshot is `stale`;
    - the same with the paid invoice (T) between them;
    - `created`'s first delivery answered 500, then retried after the active update → active;
    - before `20261175` (no ledger), the row guard holds it: incomplete moves only `trialing` or `unpaid` on its subscription, never `active`, `past_due`, `paused` or `canceled`;
    - an incomplete snapshot strictly newer than the last one recorded still applies to the legacy row.
  - "a declined checkout's deletion leaves the app's trial as it was":
    - `deleted` (incomplete_expired) for a subscription the app-trial workspace is not on → superseded, with `trial_ends_at` and `trialing` untouched and no audit row;
    - an unknown status on a deletion is treated the same, and logged;
    - regression: the legacy row on that subscription is still ended, and a real cancellation still ends a workspace on none.
  - The per-status table's `incomplete` row now starts from the row the old code wrote (`trialing` on the subscription). That is the case in which an incomplete snapshot is stored.

**Done-when.**
- [x] `incomplete` maps to a non-access state and the default branch denies rather than granting 'trialing' ✓ (`unpaid`; `hasAccess` false). Stored on a workspace already on that subscription; on any other workspace the event changes nothing (review fix pass). On a workspace on it, it overwrites only the row the old code wrote, or an earlier `unpaid`: a workspace that has paid is never written back to `unpaid` (second review fix pass).
- [x] subscribed_plan is only written once the subscription reaches a paid status, and is derived from the price id rather than checkout metadata ✓. The price map is `XEDGE-14`'s; metadata is read only as its documented fallback for a price the deployment has not mapped.
- [x] A test covers each Stripe status string, including one unknown value, asserting the stored status ✓.

**Scope / residual.** A workspace on the app's own trial whose card is declined at checkout keeps its trial: the attempt changes nothing on the workspace, and Stripe's expiry of it changes nothing either, whether the expiry arrives as an update or as a deletion (second review fix pass). *(Corrected at the review fix pass: this read "now reads `unpaid` … until the admin pays with another card, or Stripe expires the attempt (… then `canceled`)". The expiry then left the trial lost.)* The admin sees the decline in Stripe's checkout, not on the billing page. A row the old code wrote for an incomplete subscription (`trialing`, the plan and the subscription id) is moved by that subscription's next event: `unpaid` while it is incomplete, `canceled` with no plan when it expires. An incomplete snapshot moves only that row, or the `unpaid` an earlier one set. A workspace on the subscription in any other state is newer than the snapshot and is left alone. `trial_ends_at` is never touched.

---

<a id="bill-2"></a>

## BILL-2 · Any org Admin can rewrite their own subscription state from the browser — the orgs UPDATE policy has no column restriction, so billing is enforced against a client-writable column

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-10-02, admin-and-org Round G).** Package P4.

**Reproduced.** No migration or `schema.sql` defines a trigger, a column grant or a RESTRICTIVE policy on orgs. `orgs_admin_write` (`20261046_rp_phase6_sweep_authority_by_collection.sql:136-138`, by `caller_holds_any_role`) is the only write policy. On PostgreSQL 16, with the real definitions it touches and before either paste, an Admin's member session updated `subscription_status`, `subscribed_plan` and `trial_ends_at` on its own workspace: 1 row.

**Fix.** `supabase/migrations/20261176_ao_roundG_orgs_billing_columns_guard.sql` adds `trg_orgs_billing_columns_guard`, a BEFORE UPDATE trigger on orgs (`orgs_billing_columns_guard()`, `DEC-98` §5).
- **What it refuses.** A change to any of the six billing columns, `42501`, unless the request's JWT role is `service_role` or absent (the SQL editor). That is the idiom of `20261121`'s guard.
- **Pinned by refusal.** A forged write fails as a whole and says why; it is never silently reset.
- **What passes.** A member's update that leaves the six as they are (the settings page's ticket-numbering save, the only orgs update made with a member's session) passes. So does one that names a billing column with its current value.
- **What is unchanged.** `orgs_admin_write` is not re-created: who may update an org row is unchanged.
- **Privileges.** SECURITY INVOKER, `search_path` pinned. EXECUTE is revoked from PUBLIC, anon and authenticated (the `DRLS-16` rule).
- **The paste checks itself.** After COMMIT, a self-test that is always rolled back tries one billing change as an authenticated request (must be refused) and one update that leaves the billing columns alone (must pass). The inventory counts the shapes a self-grant leaves: active with no subscription id, a trial with no end, a plan on a canceled workspace. They are reported, never rewritten.

**Census.** Every orgs write in `app/`, `lib/`, `components/` and `hooks/` is pinned: the settings page (member session, ticket columns only), restore/begin (service role, `name`), signup (service role: an insert and a delete), checkout (service role, `stripe_customer_id`) and the webhook (service role).

**Files and tests.**
- Files: `supabase/migrations/20261176_ao_roundG_orgs_billing_columns_guard.sql`.
- `lib/__tests__/aoRoundGStripeBillingMigrations.test.ts`: the one-paste shape, the six columns equal to `20260601`'s, `orgs_admin_write`'s only definer is still `20261046`, the first trigger on orgs, `DRLS-16`, and the self-test.
- `lib/__tests__/stripeWebhook.test.ts`: "every orgs write in the app — after 20261176 a member's own write still succeeds".
- PostgreSQL 16, a scratch cluster with `schema.sql`'s orgs, `20260601`, `20261045`'s `caller_holds_any_role` and `20261046`'s policy:
  - the paste: every probe true, the self-test refused and passed;
  - a re-run is idempotent;
  - an Admin's numbering save, and one naming unchanged billing columns, update 1 row each;
  - a change to each of the six columns is refused `42501`;
  - a Viewer still gets 0 rows (RLS, as before);
  - the service role's billing write and the SQL editor's both update 1 row;
  - on an empty orgs table the self-test reports n/a.

**Done-when.**
- [x] orgs has a BEFORE UPDATE trigger so `authenticated` cannot write subscription_status, subscribed_plan, trial_ends_at, current_period_end, stripe_customer_id or stripe_subscription_id; only the service role can ✓ — **pending the paste of 20261176**.
- [x] The billing columns are pinned to their OLD values for non-service-role writers ✓, by the trigger rather than the policy's WITH CHECK. A WITH CHECK expression cannot read the old row in Postgres RLS. The plan chose the trigger and keeps `orgs_admin_write` as it is.
- [ ] A reconciliation path that re-derives subscription state from the Stripe API — **not done: WONTFIX for now** (`DEC-98` §2; owner: the user). With the columns server-only (this migration), the webhook's checked, ledgered writes (`BILL-4`) and enforcement off (`DEC-18`), the row can drift from Stripe only through a lost delivery. Stripe retries a lost delivery for three days and its dashboard shows the failure. The one decision that bills, a second checkout, already asks Stripe (`BILL-8`).

**Scope / residual.** **Pending migration:** `supabase/migrations/20261176_ao_roundG_orgs_billing_columns_guard.sql` (`DEC-30`; either order with the deploy and with `20261175`). Until it is pasted, an Admin can still write the billing columns. A SECURITY DEFINER function a member calls still carries their `authenticated` JWT role, so it is refused too: no such function writes orgs today (grep of the sequence). Reconciliation stays open as the user's decision.

---

<a id="bill-3"></a>

## BILL-3 · Plan entitlement is read from immutable checkout metadata and never cleared on cancellation — a Customer Portal downgrade keeps Growth features and a canceled org keeps them forever

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Partial (2026-10-01, admin-and-org Round G).** Package P3, Done-when 3 only. Done-when 1 and 2 (the Stripe webhook) are admin-and-org P4's, and the status stays OPEN for them. Reproduced on base `bf6a552`:
- the runner's re-check existed. Document-control `XEDGE-7` / `XEDGE-8` added `lib/exportEntitlement.ts scheduledRunGate`, whose plan limb skips a bucket destination under `SUBSCRIPTION_ENFORCE` (`DEC-18`);
- but the skip (`app/api/data-export/run-scheduled/route.ts:114-140`) left the destination `enabled`, so a lapsed bucket destination was refused again every night. Re-enabling one later passed no plan gate unless the request also set the bucket (`destinations/[id]/route.ts`).

Fix:
- **Disable on a lapsed plan.** Under `SUBSCRIPTION_ENFORCE`, a skipped destination that pushes to a bucket (s3 / r2 with a bucket) whose workspace plan no longer includes cloud backups (`planNoLongerIncludesBuckets`, the same `cloudBucketAllowed` rule) is updated `enabled: false`, never deleted. *(Corrected at A&O P3 fix pass 8: this read "a skipped destination with a bucket". The test was the bucket's name alone, `!!dest.bucket`, so a webhook still carrying the name it had as an s3 row was disabled for a feature it does not use. It is now `pushesToBucket`.)* The reason is on the cancelled run ("… the destination was disabled; an Admin re-enables it once the plan includes cloud backups") and on the card's `last_run_error`.
- **When it does not disable.** An unreadable workspace row does not disable: the skip already happened, and a disable needs a definite answer. A skip for any other reason (a departed configurer, a lapsed subscription on a plan that still includes buckets) does not disable either. With the flag off, nothing changes (`DEC-18`): the would-be skip is a notice and the push runs. *Corrected at the review fix pass:* the first version decided "lapsed" from the plan alone, whatever limb the gate refused on. A skip for a departed configurer in a workspace whose plan had also lapsed therefore disabled the destination, contrary to the sentence above. The sweep now disables only when the gate refused on a billing limb, the plan or the subscription (`refusedOnBillingLimb`: the reason carries `lib/exportEntitlement.ts`'s `CLOUD_BUCKET_REFUSAL` or `SUBSCRIPTION_INACTIVE_REFUSAL`), and the plan, read again, excludes buckets. Tests: "…even when the workspace's plan ALSO lapsed — the skip was for the configurer, so nothing is disabled" (fails against the first P3 commit) and "a lapsed SUBSCRIPTION on a plan without buckets is a billing skip too: disabled".
- **Re-enabling.** Enabling a bucket destination again (PATCH turning `enabled` on) passes `assertCloudBucketEntitlement` (402), as creating one does.
- Files: `app/api/data-export/run-scheduled/route.ts`, `app/api/data-export/destinations/[id]/route.ts`.
- Tests in `lib/__tests__/dataExportRoutes.test.ts`, "BILL-3 Done-when 3 — a bucket destination whose plan lapsed is disabled (never deleted), and enabling re-checks":
  - under the flag: skipped, recorded and disabled, with the row kept;
  - flag off: it runs and nothing is disabled;
  - a departed configurer skips without disabling;
  - enabling on a lapsed plan is 402, and 200 once the plan allows.

  The disable and re-enable tests fail against base.

*Second review fix pass (admin-and-org Round G, P3).* "Run Now" skipped the plan.
- **The gap.** `POST /api/data-export/run` with a `destinationId` checked credentials only. A bucket destination the sweep had disabled for a lapsed plan could still be pushed by hand, so the Growth feature kept working.
- **The fix.** Run Now now passes `assertCloudBucketEntitlement` (402, nothing sent, no run row) for a bucket destination: s3 / r2 with a bucket. It does so under `SUBSCRIPTION_ENFORCE`, the rule the sweep follows (`DEC-18`). With the flag off, it runs as before, and a webhook is never plan-gated. *(Corrected at A&O P3 fix pass 8: this read "type s3 / r2, or a bucket set". "Or a bucket set" did gate a webhook, one still carrying its old bucket name, so "a webhook is never plan-gated" was not so. A bucket destination is now `pushesToBucket`, the sweep's rule too.)*
- **Tests.** `lib/__tests__/dataExportRoutes.test.ts`, in the BILL-3 block:
  - "under SUBSCRIPTION_ENFORCE, Run Now of a bucket destination on a plan without buckets is 402", then 200 once the plan allows. It fails against the first review fix pass.
  - "…flag off (DEC-18): Run Now of that destination runs as before; a webhook is never plan-gated".

*A&O P3 fix pass 7 (2026-10-02, cross-note).* "Enabling a bucket destination" now means a row that pushes to a bucket after the save: s3 / r2 with a bucket (`app/api/data-export/destinations/[id]/route.ts:172`, `BUCKET_TYPES.has(nextType) && nextBucket`). Off plan, a disabled s3 row converted to a webhook and enabled in one save was refused 402 on the old bucket name the form still sends; it is now 200. Enabling an s3 / r2 row is gated as before. Test: `lib/__tests__/dataExportRoutes.test.ts`, "A&O P3 fix pass 7 — enabling is the Growth act only for a row that pushes to a bucket after the save". Left open at this pass, P3's own: under `SUBSCRIPTION_ENFORCE`, the sweep's plan limb (`scheduledRunGate`, fed `dest.bucket`), its disable-on-lapse and Run Now still treated a webhook row with a leftover bucket name as a bucket destination, so the sweep disabled the converted webhook that night and Run Now refused it 402; the form cannot clear the stored bucket. With the flag off (`DEC-18`) both ran it, with a would-be-skip notice. See `BKP-13`'s fix pass 7 block. *(Corrected at fix pass 8: this read "Residual, pre-existing", and named neither the disable nor an owner. Run Now's gate and the sweep's disable were P3's, written on this branch. Closed at fix pass 8, below.)*

*A&O P3 fix pass 8 (2026-10-02, cross-note).* One test of a bucket destination, `lib/exportRunner.ts pushesToBucket` (s3 / r2 with a bucket), for Run Now's plan gate, the sweep's plan limb (the gate is handed the row's bucket only for such a row; `lib/exportEntitlement.ts` is not edited) and its disable-on-lapse, and PATCH's gates. Off plan under `SUBSCRIPTION_ENFORCE`, the converted webhook is pushed that night and not disabled, and Run Now is 200; with the flag off its runs carry no would-be-skip notice; a real s3 / r2 row off plan is skipped, disabled and 402, as before. Tests: `lib/__tests__/dataExportRoutes.test.ts`, "A&O P3 fix pass 8 — a webhook that still carries a bucket name is not a bucket destination". Details in `BKP-13`'s fix pass 8 block.

**Done-when.**
- [ ] subscribed_plan is derived from the subscription's price id — **not done here**: admin-and-org P4 (the Stripe webhook).
- [ ] customer.subscription.deleted clears subscribed_plan (or entitlement checks require an active status as well as a plan) — **not done here**: P4.
- [x] run-scheduled re-checks entitlement before executing a cloud-bucket destination, and disables (not deletes) destinations whose plan lapsed ✓. The re-check is `XEDGE-8`'s; the disable is new. Both ride `SUBSCRIPTION_ENFORCE` (`DEC-18`).

**Scope / residual.** OPEN for Done-when 1 and 2 (P4). Until P4 derives the plan from the price id, the plan column the disable reads can be stale (`XEDGE-14`). That is why the refusal, and now the disable, wait for the flag. *(A&O P3 fix pass 8.)* No leftover-bucket residual remains in the gates a stored destination meets. One wart of the create gate (`XEDGE-8`, on master, not behind the flag) is P4's, as this finding's owner: the data-export page's create form sends a bucket typed before its type was switched to webhook, and `POST /api/data-export/destinations` gates any bucket, so that webhook is 402 off plan until the field is cleared. The refusal direction only. The page's save could drop the bucket for a webhook, or the create gate could use `pushesToBucket` (`XEDGE-8`'s create test uses an s3 row; its PATCH test pins the type-blind rule, a bucket PATCHed onto a webhook-typed row being 402).

**Resolution (2026-10-02, admin-and-org Round G).** Package P4: Done-when 1 and 2 (the webhook), and the create-form wart from the Scope / residual above. Done-when 3 is P3's (above).
- **Done-when 1.** Reproduced as resolved: `XEDGE-14` (document-control Round F) already derives the plan from the price id (`lib/stripe.ts planFromSubscription`, `PRICE_ID_ENV_TO_PLAN`), and its tests stay green unchanged (`lib/__tests__/dcRoundFExportContract.test.ts`). P4 builds on it and does not undo it. The resolved plan is now written only on a status that pays for it (`BILL-1`), so an incomplete or unknown-status subscription writes no plan.
- **Done-when 2.** Reproduced on `f5073fc`: `customer.subscription.deleted` set only `subscription_status` and `stripe_subscription_id` (`app/api/stripe/webhook/route.ts:88-91`). The test "subscription.deleted clears subscribed_plan" failed against the base. Now the deleted event writes `subscribed_plan: null` beside `canceled` and the cleared id (route `:337`), for the workspace's current subscription (or none). An old subscription's deletion leaves a workspace on its new one untouched (`BILL-4`). The audit row says `plan_cleared`.
- **The create-form wart.** Reproduced on `f5073fc`: off plan, `POST /api/data-export/destinations` answered 402 to a webhook created with a bucket name typed before the type was switched (test "off plan, a webhook created with a leftover bucket name is 200…" failed with 402).
  - The server gates only a row that pushes to a bucket: `pushesToBucket` (`lib/exportRunner.ts`), the rule PATCH, Run Now and the sweep already share (`app/api/data-export/destinations/route.ts:100-104`).
  - A webhook's bucket is neither gated nor stored.
  - The page's create form sends no bucket for a webhook (`app/(protected)/admin/data-export/page.tsx:600`). The edit form is unchanged; PATCH judges the row after the save.
  - An s3 / r2 create with a bucket is 402 off plan as before (`XEDGE-8`'s create test unchanged).
- Files: `app/api/stripe/webhook/route.ts`, `app/api/data-export/destinations/route.ts`, `app/(protected)/admin/data-export/page.tsx`.
- Tests:
  - `lib/__tests__/stripeWebhook.test.ts`: "BILL-3 — cancellation clears the plan", "cross-subscription…", and the portal-plan-change regression.
  - `lib/__tests__/dataExportRoutes.test.ts`: "A&O P4 (BILL-3 Scope / residual…)" — a webhook with a leftover bucket is 200 off plan and stores none; s3 / r2 stay 402 and write nothing; an s3 create on Growth keeps its bucket; the form's line is pinned. Every earlier test in that file passes unchanged.

*Review fix pass (2026-10-02, admin-and-org Round G, P4).* Three corrections.
- **Done-when 1 was undone in one delivery order (the review's blocker).** The first ordering guard counted an applied invoice event as a barrier for every older event of its subscription. A portal plan change whose `customer.subscription.updated` was handled after the same change's `invoice.payment_succeeded` (Stripe does not order deliveries; or its first delivery answered 500 and was retried) was recorded `stale`, and the price-derived plan and period end were never written. Now a newer applied invoice event holds back only the older event's status; its plan, period end and subscription id are written (`BILL-4`'s review block). Test: "portal upgrade: invoice.payment_succeeded (T+2) applied first, then subscription.updated (T, Growth price) → growth…".
- **Any event that ends a subscription clears the plan.** A `canceled` (or `incomplete_expired`) status that arrives through `customer.subscription.updated` withheld the plan but did not clear it. It now writes `subscribed_plan: null`, as the deleted event does (`app/api/stripe/webhook/route.ts:275`, `:298`; audit `plan_cleared`). Tests: "customer.subscription.updated with status canceled clears subscribed_plan"; "a legacy incomplete row (stored trialing + growth by the old code) that expires is canceled with no plan".
- **The rows the old code left.** The residual said a workspace canceled before this deploy "clears on its next subscription event". A canceled workspace normally gets no further subscription event, so its plan, and with it the Growth bucket gate (`lib/exportEntitlement.ts cloudBucketAllowed(plan, status)` reads the plan alone), would have stayed indefinitely. `20261176` now clears the plan on every canceled workspace in its transaction, before the guard is created: `UPDATE orgs SET subscribed_plan = NULL WHERE subscription_status = 'canceled' AND subscribed_plan IS NOT NULL`. Its inventory counts the rows before, and a probe says none is left. A canceled workspace has no access and no subscription paying for a plan, so the value is unambiguous. On PostgreSQL 16 (scratch cluster, not production) the paste cleared two such workspaces, one with a subscription id and one without. The re-paste counted 0. Shape test: `lib/__tests__/aoRoundGStripeBillingMigrations.test.ts`, "BILL-3: inside the transaction, before the trigger…".

**Done-when.**
- [x] subscribed_plan is derived from the subscription's price id on every subscription.created/updated, not from metadata ✓ (`XEDGE-14`, kept; metadata only as its fallback for an unmapped price). This includes a subscription event handled after a newer invoice event for its subscription (review fix pass).
- [x] customer.subscription.deleted clears subscribed_plan ✓, and so does a `customer.subscription.updated` whose status ends the subscription (review fix pass).
- [x] run-scheduled re-checks entitlement before executing a cloud-bucket destination, and disables (not deletes) destinations whose plan lapsed ✓ (P3, above).

**Scope / residual.** **Pending migration:** `20261176` clears the plan the old code left on canceled workspaces. Until it is pasted, those workspaces keep it, and with it the Growth bucket create gate. If it is pasted before the deploy, a workspace the old webhook cancels in between keeps its plan, so paste it again after the deploy (it is idempotent). *(Corrected at the review fix pass: this read "reported and never rewritten. Each clears on its next subscription event". A canceled workspace normally receives none.)* The leftover-bucket class is closed at every gate: create, PATCH, Run Now and the sweep.

---

<a id="bill-4"></a>

## BILL-4 · The Stripe webhook discards every write result and always returns 200, and there is no event ledger — a dropped update is invisible and out-of-order events resurrect canceled subscriptions

- **Severity:** HIGH
- **Status:** RESOLVED
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

**Resolution (2026-10-02, admin-and-org Round G).** Package P4. Reproduced on `f5073fc`: every `orgs` update was a bare await (`app/api/stripe/webhook/route.ts:65-70, :88-91, :106-108, :117-119`), `:138` answered 200 always, and nothing recorded an event id. The tests showed it: a refused update answered 200; the same event delivered twice wrote two audit rows; an older `updated` (active) after a `deleted` set the workspace back to active; and `invoice.payment_succeeded` for another subscription, or a one-off invoice, promoted `past_due` to `active`.

Fix (`DEC-98` §3):
- **Checked writes.** `writeOrg` (`:502`) destructures `{ error }`, and a refusal is a 500 so Stripe retries. So is a refused ledger read or write, or a failed workspace lookup.
- **The ledger.** `stripe_events` (`20261175`) is keyed on Stripe's event id.
  - `readLedger` (`:438`) answers a redelivered event `duplicate`, with no write of any kind.
  - It refuses to apply an event older than the last one APPLIED for the same subscription (`event.created`, strictly older). Such an event is recorded `stale` and not applied. An event in the same second is applied. *(Corrected at the review fix pass, below: an applied invoice event now holds back only an older subscription event's status, and a superseded subscription event orders the subscription's older events too.)*
  - Every handled event is recorded with its outcome: `applied`, `stale`, `unresolved`, `superseded` or `ignored` (`settle`, `:208`). It is recorded last, so a 500 earlier in the run is retried in full.
- **Invoices move only the current subscription.** An invoice event changes the status only when the invoice's subscription is the workspace's `stripe_subscription_id` (`:354`). The write is guarded by the same equality. Done-when 4 names `payment_succeeded`; the same rule is applied to `payment_failed`. Otherwise the first invoice of an `incomplete` subscription (`BILL-1`) failing would hand out `past_due`, an access status. The subscription is read in both payload shapes (`invoiceSubscriptionId`, `:167`): `invoice.subscription`, and from Stripe's 2025-03 API on, `invoice.parent.subscription_details.subscription`. A workspace's renewals move exactly as before.
- **A subscription the workspace is not on cannot take its access away.** A status that grants no access (canceled, unpaid, paused, including `subscription.deleted`) applies only while the workspace is on that subscription or on none (`:292`, `.or(stripe_subscription_id.is.null, …eq…)`). Otherwise it is recorded `superseded`. This is the cross-subscription case the ordering key cannot see. *(Review fix pass: a subscription that never started, or an unknown status, applies only while the workspace is on that subscription, never on none; see `BILL-1`.)*
- **Before 20261175 is pasted.** With the table absent (PGRST205 / 42P01), every event is applied as before, without the duplicate and ordering guards (and, from the review fix pass, without the per-customer lock). That is logged, and the audit row's `details.ledger` is `absent`.
- Files: `app/api/stripe/webhook/route.ts`, `supabase/migrations/20261175_ao_roundG_stripe_events_ledger.sql`.
- Tests:
  - `lib/__tests__/stripeWebhook.test.ts`: "BILL-4 — checked writes, a ledger and an ordering guard"; "the ledger in both worlds" (the recorded row, a duplicate with no write, stale with no write, the same second applied, the absent-table world in both spellings, other ledger failures 500, unresolved); "an invoice is correlated in either Stripe API shape"; "cross-subscription"; and the regression block (each event for the workspace's own subscription writes as before).
  - `lib/__tests__/aoRoundGStripeBillingMigrations.test.ts`: `20261175`'s shape.
  - PostgreSQL 16 (scratch cluster, not production): the paste, a re-run, a duplicate id `23505`, a bad outcome `23514`, members refused `42501`, and the webhook's ordering read.

*Review fix pass (2026-10-02, admin-and-org Round G, P4).* The review found the ordering guard both too strong and too weak. Each case below was reproduced through the real route on the reviewed head `6133d8a`, and its test fails there.
- **An invoice event no longer drops an older subscription snapshot (blocker).** `readLedger` (`app/api/stripe/webhook/route.ts:438`) counted any applied event as a barrier. An invoice event moves only the status, so a portal plan change or a renewal's period end, carried by a `customer.subscription.updated` handled after a newer `invoice.*` event of its subscription, was recorded `stale` and lost until the next subscription event, about a month later. That undid `XEDGE-14`'s price-derived plan in that delivery order (`BILL-3`). The read is now two queries:
  - a newer `customer.subscription.*` event recorded for the subscription, applied or superseded, makes the event stale;
  - a newer applied `invoice.*` event makes an invoice event stale, but makes a subscription event only hold back its status. Its plan, period end and subscription id are written, and its audit row says `status_held` (`:227`, `:279`).
  An ended subscription's status is final, so `customer.subscription.deleted`, or an update to `canceled` / `incomplete_expired`, still applies in full behind an invoice event.
  Tests: "portal upgrade: invoice.payment_succeeded (T+2) applied first, then subscription.updated (T, Growth price)…"; "renewal retried after a 500…"; "a newer SUBSCRIPTION event still makes an older one stale; an invoice event older than an applied subscription event is stale"; "an ended subscription's status is final…".
- **A failed payment only demotes (major).** Stripe's last dunning step sends `invoice.payment_failed` beside the `customer.subscription.updated` that sets `unpaid`, usually in the same second. The guard is strictly older, and `unpaid` keeps its subscription id, so a same-second `payment_failed` handled second wrote `past_due` (an access status) over `unpaid`. The invoice write now names the statuses it may move from (`writeOrg`'s `fromStatuses`, `:362`). `payment_failed` moves only `active`, `trialing` or `past_due`. `payment_succeeded` moves anything but `canceled`, so a paid invoice never revives a canceled row that kept its subscription id. Otherwise the event is recorded `superseded`. Tests: the same-second pair in both orders; "payment_failed still demotes active and trialing; payment_succeeded still lifts unpaid, but never a canceled row".
- **A superseded subscription event orders the subscription (minor).** Only applied rows were barriers. So after sub_A's deletion was superseded (the workspace on sub_B), an even older sub_A `updated` (active) re-pointed the workspace at sub_A, and sub_B's later `unpaid` was then superseded. Superseded `customer.subscription.*` rows now count (`ORDERING_OUTCOMES`, `:72`). The ordering index is now `stripe_events_subscription_order_idx … WHERE outcome IN ('applied', 'superseded')` in `20261175`. A superseded invoice event orders nothing. Tests: "on sub_B: sub_A deleted (T+20) superseded; a late sub_A updated (active, T+5) is stale…"; "a superseded INVOICE event orders nothing…".
- **One event per Stripe customer at a time (minor).** The guard was check-then-act. Two deliveries Stripe makes at once, which is normal on serverless, both passed the ordering read before either was recorded. BILL-4's own scenario (deleted and a late `updated` active, delivered together) could still resurrect the workspace. `20261175` adds `stripe_event_locks` (`lock_for`, the customer the lock is for; `event_id`, the delivery holding it; `locked_at`). The column is not named `*_key`, so the storage-key census (`lib/__tests__/storageKeyRegistry.test.ts`) does not read it as a storage key. It is service role only, with RLS on and no policy.
  - Each delivery first inserts its customer's row (`acquireLock`, `:395`; the subscription id if the event names no customer). A second delivery is refused `23505`. It waits 25 ms to 800 ms between tries, about 1.6 s in all, then answers 503 and Stripe retries it. *(Second review fix pass: up to 8 s, below.)*
  - Each delivery deletes its own row when done (`releaseLock`, `:417`). A refused release is logged, and the lock lapses after 60 s.
  - A row older than 60 s belongs to a run that died, and the next delivery deletes it.
  - Before the paste the table is absent, and events run unserialised, as before.
  Tests: "BILL-4's scenario delivered concurrently…" (both start orders end `canceled`; with only the lock removed it fails); "the lock is the customer's…"; "a lock another delivery holds is waited on, then 503…; a lapsed lock … is broken"; "a lock write refused for another reason answers 500…".
- **PostgreSQL 16** (scratch cluster, not production). `20261175`: every probe true on a first paste and a re-run (the unique-index probe false only in the duplicates world, as before). Lock: a second insert `23505`; the lapsed delete removes a two-minute-old row and keeps a fresh one; a release names its own event; members are refused `42501`. The two ordering reads return what the route expects, and the planner uses the new index.

*Second review fix pass (2026-10-02, admin-and-org Round G, P4).* Each case was reproduced through the real route on the reviewed head `a23d537`, and each test below fails there.
- **Same-second snapshots (blocker, with `BILL-1`; and a minor).** Stripe's `event.created` has one-second resolution, and the barrier is strictly older. So two snapshots of the same second were applied in the order they were handled, and two such pairs broke Done-when 3:
  - *Checkout.* A `created` (incomplete) handled after the same-second `updated` (active) wrote `unpaid` over a workspace that had paid. Stripe never moves a subscription back to incomplete. So an incomplete snapshot now counts a recorded subscription event of its own second as newer (`readLedger`, `app/api/stripe/webhook/route.ts:438`, `.gte`), and is recorded `stale`. The row guard in `BILL-1`'s block holds it without the ledger too.
  - *Deletion.* A `deleted` (T) handled before a same-second `updated` (active, T) let the update re-point the workspace at the ended subscription, as `active`. That is this finding's own resurrection. Stripe never revives an ended subscription. So a `customer.subscription.deleted` recorded for the subscription (applied or superseded), at any time, now makes every snapshot of it that is not ended `stale` (`subscriptionDeleted`, `:232`). An ended snapshot still applies.
  - *Reads.* Both new reads use the ordering index, unchanged (`stripe_events_subscription_order_idx`). On PostgreSQL 16 (scratch cluster, 20 000 rows) the planner uses it for both. The four ledger reads now run together (`Promise.all`), which is one round trip while the customer's lock is held.
- **The lock wait (minor).**
  - *The problem.* A delivery waited about 1.6 s, then answered 503. One event is about eight sequential round trips, up to about 1.5 s with the database a region away. So the third delivery in a checkout's burst could get a 503 and wait for Stripe's retry, and meanwhile the billing page showed the plans grid.
  - *The fix.* The wait is now up to 8 s in all (`LOCK_WAIT_MS`, `:81`). It backs off from 50 ms to 800 ms, each pause jittered (`acquireLock`, `:395`). The route declares `maxDuration = 30` (`:87`). A third-party source puts Stripe's delivery timeout at about 20 s; Stripe's own documentation could not be reached from here.
  - *Not done.* Moving the serialisation into one database transaction (an advisory-lock RPC) would add a new function to `20261175`. That is a larger change than this finding needs.
- **An update that writes no row (minor).**
  - *The problem.* With no guard, `writeOrg` reported success even when it matched 0 rows. So a subscription event whose `metadata.org_id` names a workspace that does not exist was recorded `applied`, with an audit row.
  - *The fix.* Every orgs update now returns the rows it wrote (`writeOrg`, `:502`). With no guard, no row means no such workspace. The event is then recorded `unresolved` with no workspace, logged, and no audit row is written (`:303`).
- **Tests** (`lib/__tests__/stripeWebhook.test.ts`):
  - "Stripe never revives a subscription it deleted, whatever the second":
    - deleted, then a same-second updated → stale, and the workspace stays canceled;
    - the other order → canceled;
    - a superseded deletion orders a same-second update of that subscription too;
    - an ended snapshot after the deletion still applies, and another subscription's events are untouched.
  - "an update that writes no row is never recorded applied".
  - The lock wait:
    - "a lock held for 3 s … is waited out and the delivery applies";
    - the 503 test now shows the delivery still waiting at 7 s and answered by 9 s (fake timers);
    - a source pin for `LOCK_WAIT_MS`, `maxDuration` and the single ledger round trip.
  - `BILL-1`'s same-second incomplete tests.
  - `lib/__tests__/aoRoundGStripeBillingMigrations.test.ts` pins the two new reads.
  - `lib/__tests__/dcRoundFExportContract.test.ts` (`XEDGE-14`'s webhook block): its mock orgs update now returns the row it wrote. Its assertions are unchanged.
- **20261175** changed only in its header comment (the two new reads, and the 8 s wait). It has not been pasted.

**Done-when.**
- [x] Every orgs update destructures `error` and a failed write returns a non-2xx so Stripe retries ✓.
- [x] A stripe_events table records processed event ids (unique) and the handler no-ops on a duplicate ✓ — **pending the paste of 20261175**: until then the handler applies every event as before.
- [x] Subscription-state writes are guarded by the event's created timestamp ✓, per subscription — pending the same paste. A newer subscription event recorded for it (applied or superseded) makes an older one stale. A newer applied invoice event makes an older invoice event stale and holds back only the status of an older subscription event. Deliveries for one customer are applied one at a time, so a concurrent pair is ordered too. *(Corrected at the review fix pass: this read "against the last applied event". That dropped the plan and period of a subscription event behind an invoice event, missed a superseded deletion, and was check-then-act under concurrent delivery.)* Within one second (Stripe's resolution), two snapshots apply in the order they are handled, with two exceptions. An incomplete snapshot is stale beside a recorded snapshot of its own second. Once a deletion is recorded, no snapshot of that subscription but an ended one applies, at any time. *(Corrected at the second review fix pass: the box was ticked while a same-second incomplete snapshot could overwrite a paid workspace, and a same-second update could undo a deletion.)*
- [x] invoice.payment_succeeded only promotes to 'active' when the invoice's subscription matches orgs.stripe_subscription_id ✓ (and `payment_failed` likewise). A failed payment only demotes a workspace that has access, and a paid one never revives a canceled row (review fix pass).

**Scope / residual.** **Pending migration:** `supabase/migrations/20261175_ao_roundG_stripe_events_ledger.sql` (`DEC-30`; either order with the deploy). Until it is pasted, there is no dedupe, no ordering guard and no lock, as before.
- **Same second.** Stripe's `event.created` has one-second resolution. Two events about one subscription in the same second are applied in the order they are handled, one at a time, with two exceptions: a late incomplete snapshot never overwrites a later state, and a deletion is final. The dunning pair is safe in either order, because a failed payment only demotes. Any other same-second pair, such as two different live statuses in one second, applies in handling order. *(Corrected at the second review fix pass: this did not say that a same-second incomplete snapshot could overwrite a paid workspace, or that a same-second update could undo a deletion.)*
- **Lock contention.** A delivery that finds its customer's lock held for 8 s answers 503. It is applied on Stripe's retry, and until then it shows as a failed delivery in Stripe's dashboard. *(Second review fix pass: the wait was about 1.6 s.)*
- **Checkout before the webhook lands.** Until a checkout's activating event is applied (normally within seconds; after a 503, on Stripe's retry), the row still reads trial with no subscription id. The billing page shows the plans grid, and checkout makes no Stripe call, so a second Subscribe click could open a second subscription (`BILL-8`). The longer wait narrows that window. The review's optional step, listing the customer's Stripe subscriptions at checkout, was not added: it would add a Stripe call to every trial checkout and change `DEC-98` §7.
- **Across subscriptions.** The ledger orders events per subscription. Suppose a workspace moved from an old subscription to a new one, and nothing newer is recorded for the old one. A late access-granting event for the old subscription still re-points the workspace at it, as before P4. BILL-8's checkout refusal makes a second live subscription rare.
- A one-off invoice (no subscription) no longer moves the workspace's status in either direction.
- Stripe reconciliation (`BILL-2` Done-when 3) is not built.

---

<a id="bill-5"></a>

## BILL-5 · The platform storage ceiling is a single global row that any Admin/DocCtrl of any org can overwrite, and the storage dashboard leaks deployment-wide usage across tenants

- **Severity:** HIGH
- **Status:** RESOLVED
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


**Resolution (2026-10-02, admin-and-org Round G).** Package P6, under the provisional `DEC-99` (`audit-reports/DECISIONS.md`; DEC-44 to DEC-87 are taken on the integration branch, so the integrator renumbers it). Reproduced at base `f5073fc`: `app/api/admin/storage-stats/route.ts:164` admitted an Admin or DocCtrl of the org named in the body and `:174-179` upserted the one `platform_settings` row `storage_limits`; `:26` let any Admin / Manager / DocCtrl of any org read `mfg_table_stats()`, the whole-bucket walk (`:121`) and an unfiltered `ai_usage_events` count (`:105-106`). The tests named "REPRODUCED" below fail against that code.
- **The write is a platform operator's (Done-when 1).** The ceiling is the hosting plan's, one bucket and one database for the whole server, so a per-org ceiling would be a second quota, not the plan; the record's other branch is taken. A platform operator is a uid listed in `platform_settings` under `platform_operators` (`{"uids": [...]}`). That table is service-role only (20260920 revokes it from every client role), and no app route writes the row, so no org role, Admin included, can make anyone an operator: the deployment's owner adds one in the SQL editor. `POST /api/admin/storage-stats` is first held to the storage surface's writes set through `lib/adminGate.ts` (SURF-19; who reaches it is unchanged), then refuses anyone not on the list: 403 with `operatorRequired: true` and a sentence naming the paste. An unreadable list is a 503, nothing saved (fail closed). The org count does not matter: an Admin of the only workspace is refused too, as the integrator's brief asked ("no member of any org can upsert the global row"). `lib/storageUsage.ts`: `PLATFORM_OPERATORS_KEY`, `readPlatformOperators`, `platformOperatorSql` (the idempotent line the page shows a refused Admin / DocCtrl, tested against PG16).
- **The deployment's figures are scoped (Done-when 2).** `GET` returns `scope`. It is `"deployment"` for a platform operator, or for a member of the ONE workspace on a single-workspace server (those figures are its own; `isSoleTenant`, fail-closed on an unreadable `orgs`). Otherwise it is `"workspace"`: only this workspace's files, measured under `orgs/<id>/` (`measureR2Usage({ prefix })`), and the AI count for this org, with `db`, `r2Real`, `r2Estimate`, `freeTier` and `dedup` null and no deployment RPC called (`storageScopeFor`). In deployment scope the workspace's own total comes from the same walk (`orgTotalFor`), never riding on the deployment figure.
- **The change is audited (Done-when 3, with `BILL-7`).** `PLATFORM_STORAGE_LIMITS_CHANGED`, `resource_type` `platform_settings`, the actor's uid, email and admitted role, `details { scope: "deployment", before { r2Bytes, dbBytes, source }, after }`. Checked: a refused row is said on the answer (`warning`), since the change has landed.
- **The platform watchdog follows the same rule.** `runPlatformStorageAlerts` used to bell every Admin / DocCtrl of every org with the deployment's totals (base `lib/storageUsage.ts:245-265`). It now tells the sole workspace's Admin / DocCtrl (unchanged for a single-workspace server), or, on a shared server, the platform operators in each workspace they are an active member of. With no operator registered it used to tell nobody, log that, and return `route: "none"` (`platformAlertRecipients`). *(Corrected at the second review fix pass. A shared server with no operator is the default state, after deploy and after the paste, so the only record of a hot ceiling was a log line nobody reads; the first sign would have been Cloudflare refusing a write mid-upload. Now, with no operator to give the figures to — none registered, an unreadable list, or none an active member of any workspace — every workspace's Admins (by the full collection, `roleFilter` + `memberHoldsAny`) get a notice that carries NO figures: "This server's file storage is running hot" / "This server's database is running hot", what the provider does past the ceiling, and "let whoever runs the server know; if that is you, register as its platform operator from Admin → Storage". The deployment's totals stay the operator's. `route` is `"no-operator"`, `operatorsError` carries a failed read, and the maintenance cron's step 9 pushes `platformAlertUnroutedError`'s line into `result.errors`: "platform-storage: file storage at N% of the plan ceiling, but no platform operator is registered, or none is an active member of a workspace — register one (20261177_…); each workspace's Admins were told without figures". An operator who is a member of several workspaces is belled ONCE, in the first by id, not once per membership. Tests: `aoRoundGStorageQuota.test.ts`, "fix pass, REPRODUCED: a shared server with no operator is never silent …" (fails against the code before this pass), the unreadable list, the operator in no workspace, the operator in three workspaces, the database case, the cron's step-9 statement, and the sole workspace unchanged.)*
- **The page** (`app/(protected)/admin/storage/page.tsx`) shows the ceilings' editor only to an operator. Anyone else reads that the ceilings are one setting for the whole server, and an Admin / DocCtrl also sees the registration line with their own uid. In workspace scope the server's sections are not rendered, with a note saying why.
- Migration `supabase/migrations/20261177_ao_roundG_platform_operators.sql` (DEC-30 one paste): re-asserts RLS and the revoke on `platform_settings`, seeds `platform_operators` as `{"uids": []}` without ever clearing a list, and adds a table comment. No function, policy, trigger or grant. Run on PG16 in three worlds: a first apply, a re-paste with an operator registered, and a hand-granted `authenticated` (the revoke takes it back, and the inventory counts it).
- Tests: `lib/__tests__/aoRoundGStorageQuota.test.ts` ("BILL-5 — …", "BILL-5 Done-when 2 / BILL-12 — …", and the platform watchdog cases); `lib/__tests__/aoRoundGPlatformOperatorsMigration.test.ts` (20261177's shape); `lib/__tests__/aoRoundGStoragePage.test.ts` (rendered).

**Pending migration:** `20261177_ao_roundG_platform_operators.sql`. The code does not wait on it: with no row, nobody is an operator, so the write stays refused, and the registration line inserts the row itself. Until a uid is registered, nobody can change the ceilings from the app. The env override (`STORAGE_LIMIT_*_BYTES`) still applies when no `storage_limits` row exists.

**Done-when.**
- ✓ The write is restricted to a platform-operator role that org admins cannot hold.
- ✓ GET's aggregates are scoped to the caller's org unless the caller is a platform operator or the server's only workspace.
- ✓ Changing the ceiling writes an audit row naming the actor and the old and new values.

**Scope / residual.**
- **Who registers an operator.** The deployment's owner does, by SQL, once (the paste's header and the page give the line). There is no in-app console for operators, by design: an app route that could write the list would be an org role's way in.
- **A single-workspace server's Admin loses the in-app ceiling editor until they register.** This is the conservative side the brief asked for. `DEC-99` records the alternative it did not take: letting the sole workspace's controllers write while the server has one workspace.
- **A shared server with no operator gets a platform alert WITHOUT figures** (second review fix pass): each workspace's Admins are told the server runs hot and to tell whoever runs it, and the cron's result names the percentage and the reason in `errors`. Registering an operator routes the alert, with figures, to the operator only.
- The per-org quota (`archive_settings.quota_bytes`) is `BILL-12`'s.

---

<a id="bill-6"></a>

## BILL-6 · A Stripe customer id an org Admin can write is trusted to open a Customer Portal session and to route invoice webhooks

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-02, admin-and-org Round G).** Package P4.

**Reproduced on `f5073fc`.**
- `resolveOrgIdFromCustomer` read `{ data }` from `.maybeSingle()` and discarded the error (`app/api/stripe/webhook/route.ts:142-150`): two workspaces on one customer → PGRST116 → null → `break` → 200. The test "two workspaces claiming one customer…" failed.
- The portal created a session for whatever customer the row named (`app/api/stripe/portal/route.ts:43-46`). The test "the portal refuses a customer whose metadata names another workspace" failed.
- Only the non-unique `orgs_stripe_customer_idx` existed (`20260601_billing.sql:31`). On PostgreSQL 16, before the paste, a second workspace could take `cus_A`.

**Fix.**
- **The webhook's lookup.** `resolveOrgFromCustomer` (route `:478`) reads with `.limit(2)` and its error checked. More than one workspace answers **409**, naming the customer and the remedy, and nothing is written. Stripe retries, and its dashboard shows the failing delivery. A read error is a 500.
- **The portal.** `lib/stripe.ts customerOwnershipRefusal` (`:111`) retrieves the customer first, called from `app/api/stripe/portal/route.ts:47`.
  - A customer whose `metadata.org_id` names another workspace, a deleted customer, or one Stripe does not know: **409**, no session.
  - A Stripe outage: 502.
  - A customer with no org metadata (made before checkout stamped it, or by hand) opens as before.
  - The org read is checked.
- **Uniqueness.** `20261175` builds `orgs_stripe_customer_unique`, UNIQUE (stripe_customer_id) WHERE NOT NULL, in the world where no customer id is shared at paste time. Otherwise it builds nothing, rewrites nothing, and counts the duplicates.
- **The column itself.** `20261176` makes `stripe_customer_id` service-role-only (`BILL-2`).
- Files: `app/api/stripe/webhook/route.ts`, `app/api/stripe/portal/route.ts`, `lib/stripe.ts`, and both migrations.
- Tests:
  - `lib/__tests__/stripeWebhook.test.ts`: "BILL-6 — an ambiguous customer is surfaced…", and "the portal's ownership check, and its regressions" (no metadata opens; deleted or unknown 409; outage 502; no customer 400 with no Stripe call).
  - `lib/__tests__/aoRoundGStripeBillingMigrations.test.ts`: the two-worlds index.
  - PostgreSQL 16: index built (clean); not built, duplicate count 1 and 2 workspaces (duplicates world); built after the stray id was cleared and the file pasted again; a second workspace claiming a customer refused `23505`.

**Done-when.**
- [x] stripe_customer_id is not writable by any client role ✓ — pending `20261176` (`BILL-2`).
- [x] A UNIQUE index exists on orgs(stripe_customer_id) WHERE NOT NULL ✓ — **pending the paste of 20261175**. It is built only where no duplicates exist; its final rows count them otherwise.
- [x] resolveOrgIdFromCustomer checks the error and alerts on an ambiguous match rather than silently dropping the event ✓ (a 409, and a failing delivery in Stripe's dashboard).
- [x] The portal verifies the customer's metadata.org_id matches the requested org before creating a session ✓. A customer with no org metadata is let through, as before.

**Scope / residual.** **Pending migrations:** `20261175` and `20261176` (`DEC-30`; either order). A customer created outside checkout carries no org metadata, so the portal check cannot tell whose it is. After `20261176` only the server can point a workspace at it.

---

<a id="bill-7"></a>

## BILL-7 · Changing the storage quota or the plan ceiling — the numbers that drive every storage alert — writes no audit record

- **Severity:** MEDIUM
- **Status:** RESOLVED
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


**Resolution (2026-10-02, admin-and-org Round G).** Package P6. Reproduced at base `f5073fc`: `app/api/admin/archive-settings/route.ts:51-56` and `app/api/admin/storage-stats/route.ts:174-188` wrote no `audit_logs` row.
- **`PUT /api/admin/archive-settings`** reads the current row first (checked: an unreadable row refuses the change, 500, nothing written). After the upsert it writes one row naming the fields that changed, each with `{ before, after }`. The action is `STORAGE_QUOTA_CHANGED` when the quota is among them, `ARCHIVE_SETTINGS_CHANGED` otherwise. The row carries `resource_type` `archive_settings`, the actor's uid and email, and `user_role` = the role the storage surface's writes set admitted them by (`lib/adminGate.ts` `admittedRole`). A save that changed nothing writes no row. A refused row is said on the answer (`warning`), and the page shows it for every save: the quota, the plan ceiling, and the archive location / naming. *(Corrected at the review fix pass. `saveArchiveLoc` read only `res.ok`, so a location change whose row was refused landed unrecorded with nothing said. It now reads the body and shows the warning.)*
- **`POST /api/admin/storage-stats`**: `PLATFORM_STORAGE_LIMITS_CHANGED` with the ceilings before and after (`BILL-5`). *(Corrected at the second review fix pass. The old values came from `loadPlatformLimits`, which swallows a failed read and falls back to the env override or the free tier, so a read error would have recorded "from 10 GB / 500 MB" for a move that started at 100 GB / 8 GB. The POST now reads the `storage_limits` row itself and checks the error, as archive-settings does: a failed read is 503 with nothing saved ("Couldn't read the current ceilings, so the change could not be recorded against them — nothing was saved"), a missing table is the 424 the upsert would give. No row is not a failure: the old value is then what applied, the env override or the free tier, resolved by the new pure `resolvePlatformLimits(value)` with `source` saying which. `loadPlatformLimits` keeps its fallback for display and banding and now reads the error it used to ignore. Tests: `aoRoundGStorageQuota.test.ts`, "fix pass, REPRODUCED: an unreadable ceilings row is a 503 with nothing saved …" (fails against the code before this pass), the 424, and the no-row case.)*
- The storage page's quota line no longer presents the 70% / 90% thresholds as a property of the system. It reads: "Advisory: Admin and Document Control are notified at 70% / 90%; uploads are never blocked at this limit. A change is recorded in the audit log."
- Tests: `lib/__tests__/aoRoundGStorageQuota.test.ts`, "BILL-7 — archive-settings PUT records old and new values" (fails against base) and the BILL-5 audit case; `lib/__tests__/aoRoundGStoragePage.test.ts` (the copy, and "BILL-7 — a saved archive location whose audit row was refused says so", which drives the location editor's save against a `{ ok: true, warning }` answer and fails against the code before the fix pass).

**Done-when.**
- ✓ archive-settings PUT and storage-stats POST each write an audit row with the old and new values. Both read the old values from the row, checked; neither records a fallback as the old value (second review fix pass for storage-stats).
- ✓ The rows carry the actor's real uid (`authorizeOrgRole`'s verified user, never a string), written with the service client, and the write is checked and surfaced.

**Scope / residual.** The new actions (`STORAGE_QUOTA_CHANGED`, `ARCHIVE_SETTINGS_CHANGED`, `PLATFORM_STORAGE_LIMITS_CHANGED`, and `ORG-5`'s `BRANDING_LOGO_UPLOAD`) are for A&O P7's audit-action registry (`ALOG-11`) to name. They are listed in `99-fix-sequencing.md`'s Integrator notes.

---

<a id="bill-8"></a>

## BILL-8 · Checkout can mint a duplicate Stripe customer and a second live subscription — nothing checks for an existing subscription before creating one

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-02, admin-and-org Round G).** Package P4. Reproduced on `f5073fc`: checkout created a session with no read of `stripe_subscription_id` or `subscription_status` (`app/api/stripe/checkout/route.ts:72-84`). The customer-id write was unchecked (`:63-66`), and the customer was created with no idempotency key (`:57-61`). The billing page showed the plans grid for every status but `active` (`app/(protected)/admin/billing/page.tsx:185`). Three tests ("checkout refuses 409…", "a refused customer-id write…", "customer creation carries an idempotency key…") and three rendered tests (past due, unpaid / paused, a Stripe trial: plans shown) failed against the base.

Fix (`DEC-98` §7):
- **The server refusal.** `lib/stripe.ts liveSubscriptionRefusal` (`:137`), called at checkout `:64`:
  - A row with no subscription id, or a canceled one, makes no Stripe call: the trial path is exactly as before (pinned).
  - A row naming a subscription in any other status is confirmed with Stripe. A subscription Stripe still bills (active, trialing, past_due, unpaid — `BILLED_STRIPE_STATUSES`) is refused **409**, with the portal pointer, and nothing is minted. *(Corrected at the review fix pass: paused was refused too, below.)*
  - A subscription Stripe has ended, or no longer knows, does not block, so a stale row cannot lock out a legitimate subscribe.
  - A Stripe outage is 502.
  - The org read is checked: a 500, never "not found".
- **The page.** A workspace that holds a billed subscription (`lib/subscription.ts holdsLiveSubscription`: an id, and any status but canceled or paused) sees "Manage subscription / payment" and no plans grid. That covers past due, unpaid from the red card (`app/(protected)/admin/billing/page.tsx:194-208`), and a Stripe trial (`:147`). The app's own trial, a canceled workspace, a paused one and an incomplete first checkout (no id written, `BILL-1`) still see the plans.
- **The customer.** It is created under `customerIdempotencyKey(orgId)` (`org-customer:<org>`, `lib/stripe.ts:98`), so two clicks, or a retry, get one customer for 24 hours. A Stripe refusal is 502.
- **The write is checked.** A refused write is a 500, and no session is minted, so a payment never lands on a customer the workspace does not record. The unique index (`20261175`) refuses a second workspace on one customer.
- Files: `app/api/stripe/checkout/route.ts`, `lib/stripe.ts`, `lib/subscription.ts`, `app/(protected)/admin/billing/page.tsx`.
- Tests:
  - `lib/__tests__/stripeWebhook.test.ts`: "BILL-8 — one live subscription per workspace…" and "…the checkout refusal is confirmed with Stripe…" (each live status 409; ended, incomplete or gone allowed; outage 502; the trial path makes no extra call; the key; checked reads; checkout's audit row said in the answer); the checkout regressions (a trial workspace's customer created, recorded and the session minted with the org's metadata; a canceled workspace reuses its customer).
  - `lib/__tests__/billingPageRender.test.ts` (rendered): portal and no plans for past due, unpaid, paused, a Stripe trial and active; plans for the app's trial, canceled and an incomplete first checkout; a Viewer sees neither.

*Review fix pass (2026-10-02, admin-and-org Round G, P4).* A paused workspace may subscribe again.
- **The gap.** `paused` was in the refusal set, with the copy "subscribing again would bill the workspace twice". A paused subscription raises no invoice, and the Customer Portal cannot resume one. So a paused workspace was refused 409, sent to a portal that cannot help it, and shown no plans: it lost its only self-serve path. Before P4 it could subscribe again. (This app's checkout sets no trial, so `paused` is rare.)
- **The fix.** Checkout refuses only the statuses under which Stripe keeps billing the subscription or raising its invoices: `lib/subscription.ts BILLED_STRIPE_STATUSES` (active, trialing, past_due, unpaid; `lib/stripe.ts:150`). `holdsLiveSubscription` excludes paused, so a row on a paused subscription makes no Stripe call. The billing page shows a paused workspace the plans, with the line "Stripe raises no invoice on a paused subscription, and the billing portal cannot resume it. Pick a plan below to subscribe again, or ask support to resume it." The webhook still records a paused subscription's id (`LIVE_STRIPE_STATUSES` is unchanged). `unpaid` stays refused, as this record asks, with its own copy (`:151`). Stripe keeps an unpaid subscription and keeps raising its invoices without charging them, so the answer says to pay the open invoice or cancel in the portal, and does not say "bill twice".
- **Tests.** `lib/__tests__/stripeWebhook.test.ts`: "a row on a paused subscription: checkout makes no subscription call and mints the session"; "every billed Stripe status is refused 409…" (unpaid's copy, without "bill twice"); "…or paused does not block". `lib/__tests__/billingPageRender.test.ts`: "paused on a Stripe subscription (review fix pass): the plans…"; unpaid keeps the portal. Each fails on the reviewed head.

**Done-when.**
- [x] Checkout refuses (409) when the org already has a stripe_subscription_id in a live state, and the UI directs past_due/unpaid orgs to the portal instead of the plans grid ✓ (a Stripe trial too). A paused subscription is not refused, because Stripe does not bill it and the portal cannot resume it. *(Corrected at the review fix pass: this read "paused and a Stripe trial too".)*
- [x] The customer-id write is checked, and a unique index on orgs(stripe_customer_id) makes the concurrent-create race fail loudly ✓. The index is pending `20261175`; the idempotency key below also returns one customer to concurrent clicks.
- [x] Customer creation uses a Stripe idempotency key derived from the org id ✓.

**Scope / residual.**
- **Pending migration:** `20261175` (the unique index).
- **Within the key's 24 hours.** A second admin whose click carries other customer details (another email) is refused by Stripe and answered 502 ("try again in a moment"). After 24 hours a new key applies.
- **Doubled subscriptions from before this fix.** A workspace already billed twice (the failure scenario) is not unwound here; its second subscription is cancelled in the Stripe portal or dashboard.
- **SURF-19.** `ADMIN_ROLES` in checkout and the portal is unchanged. Its stripe limb is A&O P5's.

---

<a id="bill-9"></a>

## BILL-9 · Every Stripe billing audit_logs insert fails silently — `user_id: "stripe"` is written into a UUID column and the error is never read, so subscription changes leave no record

- **Severity:** MEDIUM
- **Status:** RESOLVED
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

**Resolution (2026-10-02, admin-and-org Round G).** Package P4. Reproduced on `f5073fc`: the three webhook audit inserts passed `user_id: "stripe"` into the uuid column with no `{ error }` read (`app/api/stripe/webhook/route.ts:72-80, :92-97, :120-125`), `invoice.payment_succeeded` wrote none, and the route answered 200 on every path (`:138`). On PostgreSQL 16 against `schema.sql`'s `audit_logs`, that row shape is refused `22P02`. The tests "subscription.created writes user_id NULL…" and "a refused audit row answers non-2xx…" failed against the base.

Fix — `DEC-87` §2, taken as it stands (no new convention):
- **One machine row.** `auditRow` (route `:519`) writes `user_id` NULL, `user_email` `system:stripe-webhook`, `user_role` `system` (`STRIPE_WEBHOOK_ACTOR`, `:63`) and `details.channel` `stripe-webhook`, with the event id. It is the route's only `audit_logs` insert (pinned).
- **Every handled write has a row.** That covers `invoice.payment_succeeded`, which had none: `STRIPE_INVOICE_PAYMENT_SUCCEEDED`, written when it promotes.
- **Checked.** A refused row answers 500 (`auditRefused`), so Stripe retries. The ledger row (`BILL-4`) is written last, so the retry applies the event again (an idempotent orgs write) and writes the row.
- **Checkout's row checked too.** `STRIPE_CHECKOUT_CREATED` (`app/api/stripe/checkout/route.ts:108-123`) is checked: the session stands, and a refused row is said in the answer (`warning`) and the log.
- Files: `app/api/stripe/webhook/route.ts`, `app/api/stripe/checkout/route.ts`.
- Tests (`lib/__tests__/stripeWebhook.test.ts`):
  - "BILL-9 — the webhook's audit rows are checked machine rows";
  - "BILL-9 — every handled event writes its machine row": deleted, succeeded and failed rows; the retry after a refused row; the source pin.

**Done-when.**
- [x] The webhook writes a NULL user_id rather than the string 'stripe' ✓.
- [x] All inserts destructure `error`, and a failed audit write is surfaced as a non-200 so Stripe retries ✓. Checkout's row is surfaced in its answer, because its session already stands.
- [x] A row appears in audit_logs for a simulated subscription.created, subscription.deleted and invoice.payment_failed against a real schema ✓. This ran on PostgreSQL 16 with `schema.sql`'s `audit_logs` and `20260813`'s insert policy, writing as the service role: all three machine rows inserted, and the old `user_id 'stripe'` shape was refused `22P02`. It was a scratch cluster, not production (`DEC-30`).

**Scope / residual.** None for this finding. `ALOG-7`'s planned trigger (P7) must leave a service-role insert's `user_id` NULL (`DEC-87` §3 already asks this for the export ledger).

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
- **Status:** RESOLVED
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


**Resolution (2026-10-02, admin-and-org Round G).** Package P6, Done-when 2 (the plan's recommendation; `DEC-99` §2). Reproduced at base `f5073fc`: `lib/storageUsage.ts:229` ended the platform alert "… before uploads start failing.", while `app/api/storage/upload-url/route.ts` and `multipart/route.ts` never consult usage. Nothing refuses an upload at the quota or the plan ceiling, and P6 adds no refusal. Enforcing at upload would refuse a controlled revision mid-workflow on a figure that is up to a day old or a partial walk, which is the failure the finding warns of.
- **Platform alert** (`runPlatformStorageAlerts`): "This app does not stop uploads at the ceiling: past it, Cloudflare bills the overage, or refuses writes on an account without billing." It names "the whole deployment", and says "at least" for a partial walk.
- **Quota alert** (`lib/storageAlerts.ts runStorageAlerts`): "… of the storage limit an admin set (… measured under this workspace only). The limit is advisory: uploads are not blocked when it is reached."
- **The storage page** says the same at the quota line ("uploads are never blocked at this limit", true of the advisory quota). *(Corrected at the second review fix pass. The plan-ceilings paragraph said "Advisory: uploads are never blocked at a ceiling", which is false of the hosting plans it sits under and contradicts the app's own platform alert: past the Supabase free plan's database size the project goes read-only, so every write fails; past the R2 plan, Cloudflare refuses writes on an account without billing. It now reads: "This app never refuses an upload at a ceiling. Past the R2 plan, Cloudflare bills the overage or refuses writes on an account without billing; past the Supabase plan's database size, the database can go read-only." The recipients sentence beside it is chosen by the alert's route, not by who is looking: the stats route returns `soleTenant`, and the page says "This workspace's Admin / DocCtrl" on a single-workspace server, "Platform operators" on a shared one, for an operator viewing either. Tests: `aoRoundGStoragePage.test.ts`, "fix pass 2 — the plan ceilings' copy …" (two REPRODUCED cases fail against the code before this pass).)*
- The module headers (`lib/storageAlerts.ts`, `lib/storageUsage.ts`) document the quota as advisory.
- Tests: `lib/__tests__/aoRoundGStorageQuota.test.ts` (both alert bodies), `lib/__tests__/notificationKindStorageProducers.test.ts` (the quota alert's full row), `lib/__tests__/aoRoundGStoragePage.test.ts` (the page copy).

**Done-when.**
- Not done, by decision (`DEC-99` §2): upload-url and multipart refusing over quota. The other branch is taken.
- ✓ The product documents the quota as advisory (alerts, page, module headers), and no copy claims uploads will fail. The page's plan-ceilings copy no longer claims the opposite either: it says what the app does (never refuses) and what the providers do past their plan (second review fix pass).

**Scope / residual.** If enforcement is ever wanted, it belongs at upload-url / multipart against a fresh per-org figure (`BILL-12`'s prefix walk), with a refusal the uploader can act on. That is a product decision, not this finding.

---

<a id="bill-12"></a>

## BILL-12 · Storage usage is measured deployment-wide but charged against each org's own quota — another tenant's uploads push your workspace into 'critical'

- **Severity:** MEDIUM
- **Status:** RESOLVED
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


**Resolution (2026-10-02, admin-and-org Round G).** Package P6. Reproduced at base `f5073fc`: `lib/storageAlerts.ts:53` computed one `usedBytes` (every table of the public schema plus every org's revisions and photos) and `:66` banded each org's quota against it. The page did the same (`page.tsx:781`). The test "another tenant's 8 GB upload no longer pushes this workspace into critical" fails against base.
- **Each workspace is measured under its own key prefix.** `runStorageAlerts` walks `orgs/<id>/` for each org with a quota (`measureR2Usage({ prefix, deadlineMs })`, one 45 s budget for all of them, `QUOTA_WALK_BUDGET_MS`) and bands that org's own bytes against that org's own quota. A workspace measured only partly is alerted only when its floor already crosses a band ("at least N%"). One not measured in time is counted `unmeasured`, never reported fine.
- **No workspace can take the whole budget, and the count reaches an operator** (review fix pass). The review found that the walks ran in the database's order against one shared deadline. So one large workspace early in the order could use the 45 s every night and leave every later one unmeasured, and the cron kept only `{ alerts }`, so "counted" reached nobody.
  - Each walk's deadline is now an equal share of the time left among the walks still to run (`fairShareDeadline`); time a small workspace does not use rolls forward.
  - The order is by org id, rotated one place a day (`quotaWalkOrder`), so each workspace is walked first once every n days.
  - `runStorageAlerts` logs the unmeasured count (`[storage-alerts] …`). The maintenance cron's step 3 adds it to `result.errors` (`app/api/cron/maintenance/route.ts`, outside P6's plan, one statement).
  - Tests (`aoRoundGStorageQuota.test.ts`): "one workspace whose walk never answers no longer leaves every other workspace unmeasured" (the stuck workspace first in the database's order; fails against the code before the fix pass); the order and share arithmetic; the log line; the cron's statement.
- **The page never calls a partial walk "Healthy"** (review fix pass). A walk stopped early whose floor is under 70% is drawn "Partial — refresh", amber, with "at least N% … the real figure is higher, possibly close to it", never "Healthy" or "Plenty of headroom". That is the rule the deployment figure and the cron already keep. "Not measured" is neutral, not green, with an empty bar. Tests (`aoRoundGStoragePage.test.ts`): a 30% floor (fails against the code before the fix pass), a 95% floor, not measured, and a complete walk under 70% still "Healthy".
- **The page's watermark** ("This workspace's files") is the same figure, `stats.workspace.files` from the stats route (the prefix walk, or the workspace's total from the deployment walk), against the same quota. A partial walk reads "at least"; a failed one reads "Not measured" with the reason, never a zero.
- **The two alerting paths now agree on the bytes.** Both are bucket walks; the per-org path used to use a row-sum estimate. Each alert names what it measured and against which limit: "this workspace's files … of the storage limit an admin set", against "… plan ceiling (… the whole deployment)". On a shared server only platform operators receive the deployment's alert (`BILL-5`), so a tenant's admin gets one percentage, their workspace's. On a single-workspace server the admin may get both, for different limits (the quota they set, and the hosting plan), each labelled.
- **The page labels its scope.** The watermark says it is measured from this workspace's own files, not the whole server. The server's sections sit under "The whole server — every workspace on it", saying "this is its only workspace" or "you are a platform operator". The segment list says whether it is the whole bucket or this workspace. The AI card says "every workspace on this server" or "this workspace". On a shared server the server's sections are not shown, with a note.
- **The reclaim advice counts only what lowers the files figure** (second review fix pass). The watermark's hint still added the purge preview, which estimates DATABASE rows (`purge/route.ts`, `avgBytes × rows`), and dedup's reclaimable bytes, which no action on the page performs and which in the server's view cover every workspace. So an Admin at 92% by files read "You can reclaim ≈600 MB now (purge + dedup)", purged, and the figure did not move. The hint now reads "You can free ≈N of this workspace's files now (archive superseded revisions, archive closed tickets, delete orphaned files)" from the shed, ticket-shed and orphan previews once loaded, each source named, and the purge estimate is said apart: "Purging disposable rows would free ≈N of database space, which this figure does not count." The quota alert's body (`lib/storageAlerts.ts`) no longer says "purge disposable rows"; it says "free up space from Admin → Storage (archive superseded revisions or closed tickets, delete orphaned files)". Tests: `aoRoundGStoragePage.test.ts`, "fix pass 2 — the watermark's reclaim hint …" (the 590 MB case fails against the code before this pass); `notificationKindStorageProducers.test.ts` (the alert's full row).
- Tests: `lib/__tests__/aoRoundGStorageQuota.test.ts` (prefix walk, other tenant not counted, partial and unmeasured, the platform route); `lib/__tests__/notificationKindStorageProducers.test.ts` (the quota alert now measured from the bucket); `lib/__tests__/aoRoundGStoragePage.test.ts` (rendered watermark and labels).

**Done-when.**
- ✓ Per-org usage is measured per-org before it is compared to that org's quota: the R2 walk is scoped to `orgs/<id>/`. *The database half is not grouped by org_id; it is excluded.* The database is one shared Postgres. Its bytes cannot be attributed to an org without scanning every org-scoped table (relation sizes are physical, not per-row). Counting all of it against each org was the main cross-tenant term. The quota now covers the workspace's files, and the database is watched against its plan ceiling by the platform watchdog. `DEC-99` §3 records the definition.
- **Partial.** The two alerting paths are reconciled on a shared server, not on a single-workspace one. *(Corrected at the review fix pass. This was ticked ✓.)* Both use the same measurement method, and each alert names its scope and its limit. On a shared server a tenant's admin no longer receives the deployment's percentage, so they get one percentage, their workspace's. On a single-workspace server, though, an Admin / DocCtrl can still receive both on the same day: `storage_alert` (the workspace's files against `archive_settings.quota_bytes`) and `storage_platform_r2` (the whole bucket, nearly the same bytes, against the plan ceiling). Each carries a different percentage, against a different limit, each labelled. That is what the done-when rules out. Not suppressed or merged here: the two limits mean different things (an admin's advisory budget, and the hosting plan Cloudflare bills against), and dropping either loses a warning someone asked for. The remainder is opened as `BILL-15` (`DEC-31`, second review fix pass), with the two product options and its own Done-when; this finding closes for the shared-server piece.
- ✓ The storage page labels workspace-scoped and deployment-scoped figures.

**Scope / residual.**
- **Two percentages on a single-workspace server** (Done-when 2, partial) are tracked as `BILL-15` (opened at the second review fix pass under `DEC-31`, owner the integrator), not only as a sentence here or in `DEC-99`'s fix-pass line.
- **The quota walks still list objects the platform walk lists again** (step 3, then step 9 of the same cron), up to 45 s. Folding them into one whole-bucket walk grouped by `orgs/<id>/` would need the two steps to share one walk across the cron route. The fair share bounds step 3 at its budget.
- **The quota's meaning narrowed** from "database + files" to "this workspace's files". A single-workspace server's watermark drops by its database size; the page says what it measures.
- **Keys outside `orgs/<id>/`** (`diagnostics/`, anything an older writer put at the bucket root) count against no workspace. They still appear in the deployment's segment list.

---

<a id="bill-13"></a>

## BILL-13 · The R2 bucket walk has no time budget and runs inside a user-facing request — up to 500 sequential list round trips with no maxDuration

- **Severity:** MEDIUM
- **Status:** RESOLVED
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


**Resolution (2026-10-02, admin-and-org Round G).** Package P6, the record's first remedy (`DEC-99` §4: a deadline plus an explicit `maxDuration`, not a cached cron figure). Reproduced at base `f5073fc`: `lib/storageUsage.ts:160` bounded the walk by its page count alone, and `app/api/admin/storage-stats/route.ts` declared no `maxDuration`.
- **The walk takes a deadline.** `measureR2Usage(opts)` takes `deadlineMs`. Before each page it stops if time is up, and each request carries an abort signal for the time left, so one slow page cannot overrun either. A walk stopped either way returns what it measured with `truncated: true` and `stoppedBy: "deadline"`, never a throw. The page cap reads `stoppedBy: "pages"`. A walk that ran to the end reads `stoppedBy: null`. The substrate rule holds: a partial walk is never banded "ok" on the deployment figure, and a failure still lands in `r2Error`. The numeric signature (`measureR2Usage(500)`) still works.
- **storage-stats** declares `export const maxDuration = 60`, with the walk's budget at 40 s (`WALK_BUDGET_MS`). The aggregates before it are sub-second RPCs. On a shared server a non-operator's walk is their prefix only. In deployment scope one walk gives both the deployment's and the workspace's figures.
- **The cron** gives the platform walk 60 s (`PLATFORM_WALK_BUDGET_MS`, inside the maintenance cron's 300 s, ahead of the meaning-index drain's 100 s) and the per-org quota walks 45 s between them (`QUOTA_WALK_BUDGET_MS`). *(Review fix pass:)* each quota walk gets an equal share of the time left, in an order that rotates daily, and the unmeasured count is logged and added to the cron's errors (`BILL-12`).
- **The page's partial-walk banner** says which bound stopped it, the time budget or the 500,000-object cap. *(Review fix pass:)* the workspace watermark draws a partial floor under 70% as "Partial", never "Healthy" (`BILL-12`).
- The module header no longer calls the walk "daily": it runs on every storage page load and in the cron.
- Tests: `lib/__tests__/aoRoundGStorageQuota.test.ts`, "BILL-13 — measureR2Usage stops in time …": a finished walk; a deadline already past (no request); a request outliving its deadline aborted with the pages before it kept; the page cap; the prefix and org total; the route's `maxDuration`; the cron walk carries a signal.

**Done-when.**
- ✓ measureR2Usage accepts a deadline and returns `truncated: true` when it stops on time rather than throwing.
- ✓ storage-stats declares an explicit `maxDuration` (60 s) consistent with the walk's worst case (its 40 s budget).

**Scope / residual.** A page load on a very large bucket still costs one list op per 1,000 objects up to the budget. A cached cron figure would remove that and is the next step if it matters. The page shows a partial walk as a floor.

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

<a id="bill-15"></a>

## BILL-15 · On a single-workspace server the quota alert and the platform R2 alert can both fire on the same day, with two different percentages for nearly the same bytes

- **Severity:** LOW
- **Severity rationale:** The author's estimate. Both numbers are right, each labelled with what it measured and against which limit, and nothing is blocked by either band (`BILL-11`). The cost is a second bell with a different percentage, which is what `BILL-12`'s Done-when 2 rules out.
- **Status:** OPEN
- **Assigned:** admin-and-org P10 STORAGE FOLLOW-UPS — by the integrator, 2026-10-13 (A&O P6 merge, DEC-31; fleet plan `audit-reports/fleet-plans/admin-and-org.json`). The product call is ruled there under the user's delegation (DEC-90 practice): one bell stating both figures on a single-workspace server.
- **Verification:** CONFIRMED (by construction: `BILL-12`'s resolution describes both paths)
- **Locations:**
  - `lib/storageAlerts.ts`, `runStorageAlerts`: kind `storage_alert`, this workspace's files under `orgs/<id>/` against `archive_settings.quota_bytes`, to the workspace's Admin / DocCtrl, deduped per person per week.
  - `lib/storageUsage.ts`, `runPlatformStorageAlerts` / `platformAlertRecipients`: kind `storage_platform_r2`, the whole bucket against the plan ceiling, to the sole workspace's Admin / DocCtrl on a single-workspace server, deduped per person per resource per week.
  - `app/api/cron/maintenance/route.ts`, steps 3 and 9: both run in the same daily cron.
- **Related:** `BILL-12` (its Done-when 2 remainder, opened under `DEC-31` at the second review fix pass), `BILL-5` (who receives the platform alert), `BILL-11` (nothing is blocked), `DEC-99` §3.
- **Independently verified:** — (`author`: opened 2026-10-02 at the admin-and-org Round G P6 second review fix pass, from the reviewer's finding; not yet challenged)

**Mechanism.** `BILL-12` reconciled the two alerting paths on a shared server: a tenant's Admin gets one percentage, their workspace's, because the deployment's alert goes only to platform operators (`BILL-5`). On a single-workspace server the workspace's files ARE nearly the whole bucket, and its Admin / DocCtrl are exactly who the platform alert goes to. So when the quota and the plan ceiling differ (an Admin set a 2 GB advisory quota; the R2 plan is 10 GB), the same person can get "Storage critical — 95% full" (2 GB quota, workspace files) and "File storage high — 72% of plan" (10 GB plan, whole bucket) on the same day, for the same bytes.

**Failure scenario.** A single-plant server. The Admin set a 5 GB quota as a reminder; the deployment's R2 plan is 10 GB. The bucket reaches 4.6 GB, of which 4.5 GB is the workspace's. The daily cron bells the Admin "Storage critical — 90% full … of the storage limit an admin set" (step 3) and nothing from step 9 (46%). Two months later at 7.2 GB: step 3 is deduped (sent within the week), step 9 bells "File storage high — 72% of plan". The Admin reads two percentages across a fortnight and asks which one is the storage. Each notification does say what it measured and against what, so the answer is on the notification; the done-when asks that the question not arise.

**Remediation.** One of two product calls, to be decided, not coded by default:
- **Suppress** the quota alert on a sole-workspace server on any day the platform R2 alert for the same files fires (the plan's figure is the one that bills), or suppress the platform alert when the quota is the lower limit; or
- **Merge** the two into one bell on a sole-workspace server that names both limits: "This workspace's files are at 90% of the limit an admin set (5 GB) and 46% of the server's R2 plan (10 GB)."

**Done when.**
- An Admin / DocCtrl of a single-workspace server cannot receive two different storage percentages for the same files on the same day: one bell names both limits, or one of the two is suppressed by a stated rule.
- The rule is recorded under `DEC-99` (or its renumbered successor) and the surviving copy names what it measured and against which limit.
- A test drives a sole-workspace server with the quota under the plan ceiling through both cron steps and asserts one bell (or two bells with the same percentage).

---
