// POST /api/stripe/webhook
//
// Stripe POSTs event payloads here. We verify the signature against
// STRIPE_WEBHOOK_SECRET, then update the org row based on the event:
//
//   customer.subscription.created    -> set status, plan, current_period_end
//   customer.subscription.updated    -> refresh status, plan, current_period_end
//   customer.subscription.deleted    -> status='canceled', plan cleared
//   invoice.payment_succeeded        -> status='active' (the current subscription's invoice)
//   invoice.payment_failed           -> status='past_due' (the current subscription's invoice)
//
// The webhook MUST receive the raw request body for signature
// verification — Next.js App Router gives us req.text() for that.
//
// admin-and-org P4 (BILL-9, BILL-4, BILL-1, BILL-3, BILL-6):
//   - every write is CHECKED: a refused orgs update, audit row or ledger
//     row answers non-2xx, so Stripe retries (it treats 2xx as delivered);
//   - the audit rows are machine rows (DEC-87 §2): user_id NULL,
//     user_email system:stripe-webhook, user_role system;
//   - the stripe_events ledger (20261175) keys on Stripe's event id: a
//     redelivered event is a no-op. Ordering is per subscription, by
//     event.created: a subscription event older than a newer subscription
//     event recorded for it (applied, or superseded) is recorded 'stale' and
//     not applied; one older only than an applied invoice event still writes
//     its plan, period end and subscription id, but not the status the invoice
//     set; an invoice event older than either is stale. Stripe never moves a
//     subscription back to incomplete, and never revives one it ended: an
//     incomplete snapshot is stale beside a snapshot of the same second too,
//     and once a customer.subscription.deleted is recorded for a subscription
//     no snapshot of it but an ended one applies. Before 20261175 is pasted
//     the ledger is absent and every event is applied, as before (said in the
//     log and on the audit row);
//   - one event per Stripe customer is applied at a time (stripe_event_locks,
//     20261175, a 60-second lease): two deliveries Stripe makes at once are
//     applied one after the other, so the ordering read above sees the first.
//     A delivery waits up to 8 s for its turn, then answers 503;
//   - a Stripe status that means no payment was taken, or one this code does
//     not know, never maps to access (lib/billing.ts mapStripeStatus),
//     the plan is written only on a status that pays for it, and an ended
//     subscription clears it;
//   - a subscription the workspace is not on cannot take its access away; a
//     subscription that never started, or an unknown status, changes only a
//     workspace already on it (an incomplete one only the row the old code
//     wrote for it, or its own unpaid), as an update or a deletion; an invoice
//     changes the status only for the workspace's current subscription, a
//     failed one only demotes a workspace that has access, and a paid one
//     never revives a canceled workspace;
//   - an orgs update that writes no row is never recorded applied;
//   - two workspaces claiming one Stripe customer is answered 409 (Stripe
//     retries; the operator sees it), never silently dropped.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getStripe, isStripeConfigured, planFromSubscription } from "@/lib/stripe";
import { ACCESS_STATUSES, LIVE_STRIPE_STATUSES, PLAN_HOLDING_STRIPE_STATUSES, UNSTARTED_STRIPE_STATUSES, mapStripeStatus } from "@/lib/billing";
import type Stripe from "stripe";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";

/** DEC-87 §2: the webhook writes its audit rows as a machine, never as a person. */
const STRIPE_WEBHOOK_ACTOR = { email: "system:stripe-webhook", role: "system" } as const;
const CHANNEL = "stripe-webhook";
const LEDGER_MIGRATION = "20261175_ao_roundG_stripe_events_ledger.sql";

/** BILL-4: the recorded outcomes of a subscription event that order the
 *  subscription's later-handled, older events. A superseded event is a newer
 *  snapshot of the subscription too (it ended, or never started, while the
 *  workspace was on another): an older snapshot must not re-point the
 *  workspace at it (review fix pass). */
const ORDERING_OUTCOMES = ["applied", "superseded"] as const;
/** BILL-4: one event per Stripe customer at a time. A lock older than the
 *  lease belongs to a run that died, and the next delivery breaks it. */
const LOCK_LEASE_MS = 60_000;
/** BILL-4: how long, in all, a delivery waits for the events of the same
 *  customer ahead of it, then answers 503 and Stripe retries it. One event is
 *  about eight database round trips, up to about 1.5 s with the database a
 *  region away, so a checkout's burst (created, updated, the paid invoice)
 *  fits several times over (second review fix pass; it was about 1.6 s). */
const LOCK_WAIT_MS = 8_000;
/** The pause between tries doubles from the first to the cap, each with
 *  jitter (half to all of it), so waiting deliveries do not retry in step. */
const LOCK_BACKOFF_FIRST_MS = 50;
const LOCK_BACKOFF_CAP_MS = 800;
/** The longest wait plus one event's work, with room to spare. */
export const maxDuration = 30;
/** The statuses an invoice event may move. A failed payment only demotes a
 *  workspace that has access: Stripe sends the last dunning step's
 *  payment_failed beside the subscription.updated that makes it unpaid, often
 *  in the same second, and past_due is an access status. A paid invoice never
 *  revives a canceled workspace. */
const PAYMENT_FAILED_MOVES: readonly string[] = [...ACCESS_STATUSES];
const PAYMENT_SUCCEEDED_MOVES: readonly string[] = ["trialing", "active", "past_due", "unpaid", "paused"];
/** The statuses an incomplete snapshot may move, on a workspace already on
 *  that subscription. Stripe never moves a subscription back to incomplete,
 *  so a workspace on it in any other state is newer than the snapshot: only
 *  the row the old code wrote for an incomplete subscription (trialing) and an
 *  earlier incomplete snapshot's unpaid are moved (second review fix pass). */
const INCOMPLETE_MOVES: readonly string[] = ["trialing", "unpaid"];

const HANDLED = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;
type DbError = { code?: string; message: string } | null;
/** What happened to an event, as the ledger records it ("duplicate" is not recorded). */
type Outcome = "applied" | "duplicate" | "stale" | "unresolved" | "superseded" | "ignored";
type Handled = { ok: true; outcome: Outcome } | { ok: false; status: number; error: string };
/** The row guard on an orgs write: the subscription the row must be on (or
 *  none, when allowNone), and the statuses it must be in, when given. */
type OrgGuard = { subscription: string; allowNone: boolean; fromStatuses?: readonly string[] };

export async function POST(req: NextRequest) {
  if (!isStripeConfigured() || !webhookSecret) {
    return NextResponse.json({ error: "Stripe webhook not configured" }, { status: 503 });
  }

  const sig = req.headers.get("stripe-signature") || "";
  const body = await req.text();
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (e) {
    return NextResponse.json({ error: `Signature verification failed: ${(e as Error).message}` }, { status: 400 });
  }

  // ignored events still return 200 so Stripe doesn't retry
  if (!HANDLED.has(event.type)) return NextResponse.json({ received: true });

  // Use 'any' for the supabase client type — the inferred type from
  // createClient<unknown> doesn't match the parameter type expected
  // elsewhere in the @supabase/supabase-js v2 generics tree, and we
  // don't need DB type-safety here (this is a webhook handler).
  const supabase: Db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  try {
    const result = await handleEvent(supabase, event);
    if (!result.ok) {
      console.error(`[stripe/webhook] ${event.type} ${event.id ?? ""}: ${result.error}`);
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ received: true, outcome: result.outcome });
  } catch (e) {
    console.error("Stripe webhook handler error:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** A Stripe reference (an id, or an expanded object) as its id. */
function idOf(ref: unknown): string | null {
  if (typeof ref === "string") return ref || null;
  const id = (ref as { id?: unknown } | null)?.id;
  return typeof id === "string" && id ? id : null;
}

/** The subscription an invoice bills. Webhook payloads are rendered in the
 *  API version of the Stripe account / endpoint, not this SDK's: up to
 *  2025-02 it is `invoice.subscription`; from 2025-03 ("basil") it moved to
 *  `invoice.parent.subscription_details.subscription`. Both are read, so an
 *  account on either version correlates its invoices. */
function invoiceSubscriptionId(inv: Record<string, unknown>): string | null {
  const parent = inv.parent as { subscription_details?: { subscription?: unknown } | null } | null | undefined;
  return idOf(inv.subscription) ?? idOf(parent?.subscription_details?.subscription);
}

/** Minimal structural view of a subscription's period end — what the webhook
 *  reads, in either payload shape (as lib/stripe.ts SubscriptionPlanSource). */
interface SubscriptionPeriodSource {
  current_period_end?: number | null;
  items?: { data?: Array<{ current_period_end?: number | null } | null> | null } | null;
}

/** The end of the subscription's current period, as an ISO string. Webhook
 *  payloads are rendered in the endpoint's API version, not this SDK's: up to
 *  2025-02 it is `subscription.current_period_end`; from 2025-03 ("basil") it
 *  moved to each item, `items.data[].current_period_end`. Both are read; null
 *  when neither carries one, and null means "leave the stored value
 *  untouched", never "write NULL" (third review fix pass). */
function subscriptionPeriodEnd(sub: SubscriptionPeriodSource): string | null {
  const unix = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return typeof unix === "number" && unix > 0 ? new Date(unix * 1000).toISOString() : null;
}

async function handleEvent(sb: Db, event: Stripe.Event): Promise<Handled> {
  const obj = event.data.object as unknown as Record<string, unknown>;
  const isInvoice = event.type.startsWith("invoice.");
  const subscriptionId = isInvoice ? invoiceSubscriptionId(obj) : idOf(obj.id);
  const customerId = idOf(obj.customer);
  const eventId = typeof event.id === "string" && event.id ? event.id : null;

  // ── BILL-4: one event per Stripe customer at a time. Stripe delivers
  // concurrently; without this, two deliveries both pass the ordering read
  // below before either is recorded, and the older one may write last.
  const lockKey = customerId ?? subscriptionId;
  const lock = await acquireLock(sb, lockKey, eventId);
  if (!lock.ok) return lock;
  try {
    return await applyEvent(sb, event, { obj, isInvoice, subscriptionId, customerId, eventId });
  } finally {
    if (lock.held) await releaseLock(sb, lockKey!, eventId!);
  }
}

async function applyEvent(
  sb: Db,
  event: Stripe.Event,
  ids: { obj: Record<string, unknown>; isInvoice: boolean; subscriptionId: string | null; customerId: string | null; eventId: string | null },
): Promise<Handled> {
  const { obj, isInvoice, subscriptionId, customerId, eventId } = ids;
  const createdIso = typeof event.created === "number" ? new Date(event.created * 1000).toISOString() : null;
  // The subscription snapshot's own status (a subscription event's object).
  const stripeStatus = isInvoice ? null : (typeof obj.status === "string" ? obj.status : null);
  const incompleteSnapshot = stripeStatus === "incomplete";
  const endedSnapshot = event.type === "customer.subscription.deleted" || (!isInvoice && mapStripeStatus(stripeStatus).status === "canceled");

  // ── BILL-4: the ledger — dedupe on Stripe's event id, then the ordering guard.
  const ledger = await readLedger(sb, eventId, subscriptionId, createdIso, { isInvoice, incompleteSnapshot });
  if (!ledger.ok) return ledger;
  if (ledger.duplicate) return { ok: true, outcome: "duplicate" };
  const settle = async (outcome: Outcome, orgId: string | null): Promise<Handled> => {
    if (!ledger.present || !eventId) return { ok: true, outcome };
    const { error } = await sb.from("stripe_events").insert({
      id: eventId, type: event.type, event_created: createdIso,
      subscription_id: subscriptionId, customer_id: customerId, org_id: orgId, outcome,
    });
    if (!error || error.code === "23505" || isMissingTable(error, "stripe_events")) return { ok: true, outcome };
    return { ok: false, status: 500, error: `The event was handled (${outcome}) but not recorded in the Stripe event ledger (${error.message}); Stripe will retry, and the retry is applied the same way.` };
  };
  const ledgerNote = ledger.present ? {} : { ledger: "absent" as const };
  // A subscription event is a full snapshot of the subscription: a newer
  // snapshot recorded for it makes this one stale. An invoice event moves only
  // the status: a newer event of either kind makes it stale. A subscription
  // event older only than an applied invoice event is NOT stale: no invoice
  // event carries its plan, period end or id, so those still apply; only the
  // status it would write is older (statusHeld, below). An incomplete
  // snapshot is older than any other snapshot of the same second (Stripe never
  // moves a subscription back to incomplete: readLedger), and a subscription
  // Stripe deleted is never revived: only an ended snapshot of it applies.
  const stale = ledger.newerSubscriptionEvent || (isInvoice && ledger.newerInvoiceEvent);
  if (stale) {
    console.warn(`[stripe/webhook] ${event.type} ${eventId}: older than the last event recorded for ${subscriptionId}; recorded, not applied.`);
    return settle("stale", null);
  }
  if (ledger.subscriptionDeleted && !endedSnapshot) {
    console.warn(`[stripe/webhook] ${event.type} ${eventId}: Stripe has deleted ${subscriptionId} (recorded), and never revives an ended subscription; this ${stripeStatus ?? "unknown"} snapshot is recorded, not applied.`);
    return settle("stale", null);
  }

  // ── The workspace.
  let orgId: string | null = null;
  let orgSubscriptionId: string | null = null;
  const metaOrg = isInvoice ? null : ((obj.metadata as Record<string, string> | null | undefined)?.org_id || null);
  if (metaOrg) {
    orgId = metaOrg;
  } else {
    const found = await resolveOrgFromCustomer(sb, customerId);
    if (!found.ok) return found;
    orgId = found.org?.id ?? null;
    orgSubscriptionId = found.org?.stripe_subscription_id ?? null;
  }
  if (!orgId) {
    console.warn(`[stripe/webhook] ${event.type} ${eventId ?? ""}: no workspace for Stripe customer ${customerId ?? "(none)"}; nothing written.`);
    return settle("unresolved", null);
  }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const { status, known } = mapStripeStatus(sub.status);
      if (!known) console.warn(`[stripe/webhook] ${eventId ?? ""}: unknown Stripe status "${sub.status}" mapped to "${status}" (no access).`);
      // XEDGE-14: the plan comes from the PRICE the customer is billed on
      // (a Customer Portal plan change never rewrites checkout metadata),
      // falling back to metadata; a null / unmapped plan leaves the stored
      // value untouched instead of writing NULL over a paying workspace.
      const resolved = planFromSubscription(sub);
      // BILL-1 Done-when 2: and it is written only on a status that pays for
      // it — an incomplete subscription (no payment taken) writes no plan.
      const plan = PLAN_HOLDING_STRIPE_STATUSES.has(sub.status) ? resolved.plan : null;
      // The period end in either payload shape; absent in both (null), the
      // stored one is kept, as a null plan keeps the stored plan.
      const periodEnd = subscriptionPeriodEnd(sub as SubscriptionPeriodSource);
      // The subscription id is the workspace's current subscription only
      // while Stripe keeps the subscription (BILL-8's checkout refusal reads it).
      const live = LIVE_STRIPE_STATUSES.has(sub.status);
      // BILL-3: an ended subscription keeps no plan, whichever event says so.
      const ended = status === "canceled";
      // BILL-4: a newer invoice event for this subscription already set its
      // status, so this snapshot's status is the older one and is not written.
      // An ended subscription's status is final: no invoice revives it.
      const statusHeld = ledger.newerInvoiceEvent && !ended;
      const removesAccess = !ACCESS_STATUSES.has(status);
      // DEC-98 §6: a subscription that never started, or a status
      // this code does not know, changes only a workspace already on that
      // subscription — never the app's own trial, never a workspace on none.
      const ownOnly = !known || UNSTARTED_STRIPE_STATUSES.has(sub.status);
      // Stripe never moves a subscription back to incomplete: on a workspace
      // already on it, an incomplete snapshot moves only the row the old code
      // wrote for it, or an earlier incomplete snapshot's unpaid. A workspace
      // on it in any other state (active, say, from the update that followed
      // the checkout's payment) is newer than this snapshot (second review
      // fix pass).
      const fromStatuses = incompleteSnapshot ? INCOMPLETE_MOVES : undefined;
      const guard = ownOnly ? { subscription: sub.id, allowNone: false, fromStatuses }
        : removesAccess ? { subscription: sub.id, allowNone: true } : null;

      const write = await writeOrg(sb, orgId, {
        ...(statusHeld ? {} : { subscription_status: status }),
        ...(plan ? { subscribed_plan: plan } : {}),
        ...(ended ? { subscribed_plan: null } : {}),
        ...(live ? { stripe_subscription_id: sub.id } : {}),
        ...(periodEnd ? { current_period_end: periodEnd } : {}),
      }, guard);
      if (!write.ok) return write;
      if (!write.applied && !guard) {
        // No guard, no row: the workspace the metadata names does not exist.
        console.warn(`[stripe/webhook] ${event.type} ${eventId ?? ""}: no workspace ${orgId} (named by the subscription's metadata); nothing written.`);
        return settle("unresolved", null);
      }
      if (!write.applied) return settle("superseded", orgId);

      const auditErr = await auditRow(sb, `STRIPE_${event.type.toUpperCase().replace(/\./g, "_")}`, orgId, {
        event_id: eventId, subscription_id: sub.id,
        stripe_status: sub.status, mapped_status: status, ...(known ? {} : { status_unknown: true }),
        ...(statusHeld ? { status_held: "a newer invoice event set the status" } : {}),
        plan, plan_source: plan ? resolved.source : null, ...(resolved.plan && !plan ? { plan_withheld: resolved.plan } : {}),
        ...(ended ? { plan_cleared: true } : {}),
        period_end: periodEnd, ...(periodEnd ? {} : { period_end_kept: "no period end in the payload" }), ...ledgerNote,
      });
      if (auditErr) return auditRefused(auditErr);
      return settle("applied", orgId);
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      // DEC-98 §6, as for an update: a subscription that never
      // started (an expired declined checkout), or a status this code does not
      // know, ends only a workspace already on it — never the app's own trial,
      // never a workspace on none (second review fix pass). A real cancellation ends
      // the workspace's subscription, or a workspace on none, as before.
      const { known } = mapStripeStatus(sub.status);
      if (!known) console.warn(`[stripe/webhook] ${eventId ?? ""}: unknown Stripe status "${sub.status}" on a deleted subscription.`);
      const ownOnly = !known || UNSTARTED_STRIPE_STATUSES.has(sub.status);
      // BILL-3 Done-when 2: a canceled subscription keeps no plan. Ended is
      // final, so a newer invoice event does not hold this status back.
      const write = await writeOrg(sb, orgId, {
        subscription_status: "canceled",
        stripe_subscription_id: null,
        subscribed_plan: null,
      }, { subscription: sub.id, allowNone: !ownOnly });
      if (!write.ok) return write;
      if (!write.applied) return settle("superseded", orgId);
      const auditErr = await auditRow(sb, "STRIPE_CUSTOMER_SUBSCRIPTION_DELETED", orgId, {
        event_id: eventId, subscription_id: sub.id, stripe_status: sub.status, plan_cleared: true, ...ledgerNote,
      });
      if (auditErr) return auditRefused(auditErr);
      return settle("applied", orgId);
    }

    case "invoice.payment_succeeded":
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      // BILL-4 Done-when 4: an invoice moves the status only for the
      // workspace's current subscription — not a one-off invoice, not an old
      // subscription's, not a first invoice before its subscription is live.
      if (!subscriptionId || orgSubscriptionId !== subscriptionId) {
        console.info(`[stripe/webhook] ${event.type} ${eventId ?? ""}: invoice ${inv.id} is not for workspace ${orgId}'s current subscription; status unchanged.`);
        return settle("ignored", orgId);
      }
      const succeeded = event.type === "invoice.payment_succeeded";
      // A failed payment only demotes a workspace that has access; a paid one
      // never revives a canceled workspace. Otherwise: recorded superseded.
      const write = await writeOrg(sb, orgId, { subscription_status: succeeded ? "active" : "past_due" },
        { subscription: subscriptionId, allowNone: false, fromStatuses: succeeded ? PAYMENT_SUCCEEDED_MOVES : PAYMENT_FAILED_MOVES });
      if (!write.ok) return write;
      if (!write.applied) {
        console.info(`[stripe/webhook] ${event.type} ${eventId ?? ""}: workspace ${orgId}'s status is not one this invoice moves; unchanged.`);
        return settle("superseded", orgId);
      }
      const auditErr = await auditRow(sb, succeeded ? "STRIPE_INVOICE_PAYMENT_SUCCEEDED" : "STRIPE_INVOICE_PAYMENT_FAILED", orgId, {
        event_id: eventId, invoice_id: inv.id, subscription_id: subscriptionId,
        ...(succeeded ? {} : { attempt: inv.attempt_count }), ...ledgerNote,
      });
      if (auditErr) return auditRefused(auditErr);
      return settle("applied", orgId);
    }
  }
  return { ok: true, outcome: "ignored" };
}

/** A table of 20261175 is absent: the migration is not pasted yet (PostgREST
 *  PGRST205, or Postgres 42P01 undefined_table, on a query of that table). */
function isMissingTable(error: DbError, table: "stripe_events" | "stripe_event_locks"): boolean {
  if (!error) return false;
  if (error.code === "PGRST205" || error.code === "42P01") return true;
  return error.message.includes(table) && /does not exist|schema cache/i.test(error.message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** BILL-4: take the customer's lock — a row keyed on the customer id, so a
 *  second insert is refused 23505 while the first delivery runs. A lock past
 *  its lease (a run that died) is broken; a live one is waited on, for up to
 *  LOCK_WAIT_MS in all, then the delivery answers 503 and Stripe retries it.
 *  Before 20261175 is pasted the table is absent and the event runs
 *  unserialised, as before. */
async function acquireLock(sb: Db, key: string | null, eventId: string | null):
  Promise<{ ok: true; held: boolean } | { ok: false; status: number; error: string }> {
  if (!key || !eventId) return { ok: true, held: false };
  const giveUpAt = Date.now() + LOCK_WAIT_MS;
  for (let step = LOCK_BACKOFF_FIRST_MS; ; step = Math.min(step * 2, LOCK_BACKOFF_CAP_MS)) {
    const { error } = await sb.from("stripe_event_locks").insert({ lock_for: key, event_id: eventId });
    if (!error) return { ok: true, held: true };
    if (isMissingTable(error, "stripe_event_locks")) return { ok: true, held: false };
    if (error.code !== "23505") return { ok: false, status: 500, error: `Could not take the Stripe event lock (${error.message}); Stripe will retry.` };
    const lapsed = new Date(Date.now() - LOCK_LEASE_MS).toISOString();
    const { error: breakErr } = await sb.from("stripe_event_locks").delete().eq("lock_for", key).lt("locked_at", lapsed);
    if (breakErr) return { ok: false, status: 500, error: `Could not read the Stripe event lock (${breakErr.message}); Stripe will retry.` };
    const pause = step / 2 + Math.random() * (step / 2);
    if (Date.now() + pause > giveUpAt) {
      return { ok: false, status: 503, error: `Another event for this Stripe customer is being applied; this one was not applied. Stripe will retry it.` };
    }
    await sleep(pause);
  }
}

/** Release only our own lock. A refused release is logged: the lock lapses
 *  after LOCK_LEASE_MS, and the event itself was handled and recorded. */
async function releaseLock(sb: Db, key: string, eventId: string): Promise<void> {
  const { error } = await sb.from("stripe_event_locks").delete().eq("lock_for", key).eq("event_id", eventId);
  if (error) console.error(`[stripe/webhook] the Stripe event lock for ${key} was not released (${error.message}); it lapses after ${LOCK_LEASE_MS / 1000} s.`);
}

type LedgerRead =
  | { ok: true; present: boolean; duplicate: boolean; newerSubscriptionEvent: boolean; newerInvoiceEvent: boolean; subscriptionDeleted: boolean }
  | { ok: false; status: number; error: string };

/** BILL-4: has this event been handled already, and what is recorded for its
 *  subscription? (1) a newer customer.subscription.* event, applied or
 *  superseded — a newer snapshot of the subscription; for an incomplete
 *  snapshot, one of the same second counts too, since Stripe never moves a
 *  subscription back to incomplete (`event.created` has one-second
 *  resolution, and Checkout's incomplete → active pair often shares it);
 *  (2) a newer invoice.* event, applied — a newer status only; (3) for a
 *  subscription event, a customer.subscription.deleted applied or superseded
 *  at any time — Stripe never revives an ended subscription. The reads run
 *  together, one round trip while the customer's lock is held. A read that
 *  fails (other than the table being absent) is a non-2xx, so Stripe retries
 *  rather than the event being applied unguarded. */
async function readLedger(
  sb: Db, eventId: string | null, subscriptionId: string | null, createdIso: string | null,
  snapshot: { isInvoice: boolean; incompleteSnapshot: boolean },
): Promise<LedgerRead> {
  const none = { duplicate: false, newerSubscriptionEvent: false, newerInvoiceEvent: false, subscriptionDeleted: false };
  if (!eventId) return { ok: true, present: false, ...none };
  const noRows = Promise.resolve({ data: [], error: null });
  const ordered = !!subscriptionId && !!createdIso;
  const [seenRead, newerSubRead, newerInvRead, deletedRead] = await Promise.all([
    sb.from("stripe_events").select("id").eq("id", eventId).maybeSingle(),
    !ordered ? noRows : snapshot.incompleteSnapshot
      ? sb.from("stripe_events").select("id")
        .eq("subscription_id", subscriptionId).in("outcome", ORDERING_OUTCOMES).like("type", "customer.subscription.%").gte("event_created", createdIso).limit(1)
      : sb.from("stripe_events").select("id")
        .eq("subscription_id", subscriptionId).in("outcome", ORDERING_OUTCOMES).like("type", "customer.subscription.%").gt("event_created", createdIso).limit(1),
    !ordered ? noRows : sb.from("stripe_events").select("id")
      .eq("subscription_id", subscriptionId).eq("outcome", "applied").like("type", "invoice.%").gt("event_created", createdIso).limit(1),
    !subscriptionId || snapshot.isInvoice ? noRows : sb.from("stripe_events").select("id")
      .eq("subscription_id", subscriptionId).in("outcome", ORDERING_OUTCOMES).eq("type", "customer.subscription.deleted").limit(1),
  ]);
  const { data: seen, error } = seenRead;
  if (error) {
    if (isMissingTable(error, "stripe_events")) {
      console.warn(`[stripe/webhook] the stripe_events ledger is absent (${LEDGER_MIGRATION} not pasted): event ${eventId} is applied without the duplicate and ordering guards.`);
      return { ok: true, present: false, ...none };
    }
    return { ok: false, status: 500, error: `Could not read the Stripe event ledger (${error.message}); Stripe will retry.` };
  }
  if (seen) return { ok: true, present: true, ...none, duplicate: true };
  const found: boolean[] = [];
  for (const read of [newerSubRead, newerInvRead, deletedRead]) {
    if (read.error) return { ok: false, status: 500, error: `Could not read the Stripe event ledger (${read.error.message}); Stripe will retry.` };
    found.push(Array.isArray(read.data) && read.data.length > 0);
  }
  return { ok: true, present: true, duplicate: false, newerSubscriptionEvent: found[0], newerInvoiceEvent: found[1], subscriptionDeleted: found[2] };
}

/** BILL-6 Done-when 3: the workspace that holds this Stripe customer. More
 *  than one is a conflict answered 409 — Stripe retries, and the delivery
 *  shows as failing in its dashboard — never a silent drop. */
async function resolveOrgFromCustomer(sb: Db, customerId: string | null):
  Promise<{ ok: true; org: { id: string; stripe_subscription_id: string | null } | null } | { ok: false; status: number; error: string }> {
  if (!customerId) return { ok: true, org: null };
  const { data, error } = await sb
    .from("orgs")
    .select("id, stripe_subscription_id")
    .eq("stripe_customer_id", customerId)
    .limit(2);
  if (error) return { ok: false, status: 500, error: `Could not look up the workspace for Stripe customer ${customerId} (${error.message}); Stripe will retry.` };
  const rows = (Array.isArray(data) ? data : []) as Array<{ id: string; stripe_subscription_id?: string | null }>;
  if (rows.length > 1) {
    return { ok: false, status: 409, error: `More than one workspace claims Stripe customer ${customerId}; nothing was written. Clear the stray orgs.stripe_customer_id (${LEDGER_MIGRATION}'s inventory counts them) and Stripe's retry applies the event.` };
  }
  return { ok: true, org: rows[0] ? { id: rows[0].id, stripe_subscription_id: rows[0].stripe_subscription_id ?? null } : null };
}

const pgrstQuote = (v: string) => `"${v.replace(/["\\]/g, "\\$&")}"`;

/** One CHECKED orgs update. With a guard it applies only while the
 *  workspace is on that subscription (or, with allowNone, on none) — and,
 *  with fromStatuses, only from one of those statuses: a subscription the
 *  workspace is not on cannot take its access away, and an invoice moves only
 *  the current subscription. It always says whether a row was written: with no
 *  guard, none means the workspace does not exist (second review fix pass). */
async function writeOrg(
  sb: Db, orgId: string, patch: Record<string, unknown>,
  guard: OrgGuard | null,
): Promise<{ ok: true; applied: boolean } | { ok: false; status: number; error: string }> {
  // A snapshot with nothing left to write (its status held by a newer invoice
  // event, and no plan, subscription id or period end in it) is not sent to
  // PostgREST as an empty update: the row is read through the same guard, so
  // the outcome is the one the write would have had (third review fix pass).
  if (Object.keys(patch).length === 0) {
    const { data, error } = await withGuard(sb.from("orgs").select("id").eq("id", orgId), guard);
    if (error) return { ok: false, status: 500, error: `The workspace's billing state was not read (${error.message}); Stripe will retry.` };
    return { ok: true, applied: Array.isArray(data) && data.length > 0 };
  }
  const { data, error } = await withGuard(sb.from("orgs").update(patch).eq("id", orgId), guard).select("id");
  if (error) return { ok: false, status: 500, error: `The workspace's billing state was not written (${error.message}); Stripe will retry.` };
  return { ok: true, applied: Array.isArray(data) && data.length > 0 };
}

/** The row guard, as PostgREST filters on the orgs query. */
function withGuard(q: Db, guard: OrgGuard | null): Db {
  if (!guard) return q;
  q = guard.allowNone
    ? q.or(`stripe_subscription_id.is.null,stripe_subscription_id.eq.${pgrstQuote(guard.subscription)}`)
    : q.eq("stripe_subscription_id", guard.subscription);
  if (guard.fromStatuses) q = q.in("subscription_status", guard.fromStatuses);
  return q;
}

/** DEC-87 §2: a machine audit row, CHECKED by the caller. */
async function auditRow(sb: Db, action: string, orgId: string, details: Record<string, unknown>): Promise<DbError> {
  const { error } = await sb.from("audit_logs").insert({
    action,
    resource_id: orgId,
    resource_type: "org",
    org_id: orgId,
    user_id: null,
    user_email: STRIPE_WEBHOOK_ACTOR.email,
    user_role: STRIPE_WEBHOOK_ACTOR.role,
    details: { channel: CHANNEL, ...details },
  });
  return error ?? null;
}

function auditRefused(error: NonNullable<DbError>): Handled {
  return { ok: false, status: 500, error: `The workspace's billing state was written but its audit row was not (${error.message}); Stripe will retry, which writes both again.` };
}
