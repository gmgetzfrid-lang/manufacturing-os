// lib/notify/recipients.ts
//
// Unified recipient resolution for the notification dispatcher (emit()). It
// turns an emit()'s audience into a list of user ids from these sources:
//   • the watch / follow table `subscriptions` (lib/watches.ts — documents /
//     projects / assets / libraries; WatchResourceType has no ticket)
//   • tickets.watchers, for a ticket resource — read ONLY for an emit() that
//     passes `followers: true` on a ticket, which today is the intake door's
//     redline notice (app/api/intake/upload/route.ts). The two ticket routes
//     (app/api/tickets/comment, app/api/tickets/workflow-action) do NOT walk
//     this resolver: they fold tickets.watchers into their own fan-out (the
//     transition's unread_by — lib/ticketTransitions.ts — and the comment
//     route's merge). A ticket emit that adds `followers: true` beside them
//     would double-supply the watchers (drafting-flow ROUTE-3 (a), N15).
//   • role pools (additive roles[])
//   • project membership (implicit follow)
//
// Discovery (NEDGE-6 done-when 3, TAX-4 done-when 3 — notifications Round G
// N15): a document's follower who may not DISCOVER it (a hidden or private
// node, an ACL that excludes them) is dropped from a document-scoped event —
// discoveringAmong, below; controllers are never dropped (DEC-43). A
// library's follower is asked the same about each document a library-scoped
// notice names (NEDGE-22, N16 — dispatch.ts resolveAudience). A failed
// check's controllers lookup is bounded (controllersAmong — NEDGE-6's
// remainder, N16).
//
// Membership (NEDGE-3, notifications Round G N5): only an ACTIVE member of
// the event's org is a recipient. The role pool always asked for status =
// 'active'; the follow stores and the project roster did not, so a suspended
// member, a restore's 'inactive' placeholder or a removed member kept every
// watch. dispatch.ts resolveRecipients filters the final set once, centrally
// (activeMembersOf); resolveFollowers applies the same filter itself as a
// defence in depth, for any caller that reads followers directly.

import { supabase } from "@/lib/supabase";
import { memberHoldsAny, roleFilter } from "@/lib/roleHeld";

export type ResourceType = "ticket" | "document" | "project" | "asset" | "library";
export interface ResourceRef {
  type: ResourceType;
  id: string;
}

/** How many uids one membership read carries (a long `in.(…)` list is a
 *  long URL; the DIST-15 precedent chunks it). */
const MEMBERSHIP_CHUNK = 150;

/** The subset of `uids` that are ACTIVE members of `orgId`, in input order
 *  (NEDGE-3). Not a member of the org, suspended, invited or inactive: out.
 *  A read that FAILS keeps the input unchanged and logs: a transient error
 *  must never silently drop a compliance notice, and the database refuses a
 *  browser's row for a non-member anyway (20261160) while the read policy
 *  hides it from one (20261161). */
export async function activeMembersOf(orgId: string, uids: string[]): Promise<string[]> {
  const want = Array.from(new Set(uids.filter(Boolean)));
  if (!orgId || want.length === 0) return [];
  const active = new Set<string>();
  for (let i = 0; i < want.length; i += MEMBERSHIP_CHUNK) {
    const { data, error } = await supabase
      .from("org_members")
      .select("uid")
      .eq("org_id", orgId)
      .eq("status", "active")
      .in("uid", want.slice(i, i + MEMBERSHIP_CHUNK));
    if (error) {
      console.warn("[notify] active-membership read failed — recipients not filtered", error.message);
      return want;
    }
    ((data as Array<{ uid: string }> | null) ?? []).forEach((m) => active.add(m.uid));
  }
  return want.filter((u) => active.has(u));
}

/** Everyone following a resource: generic subscriptions ∪ (tickets) watchers,
 *  limited to active members of `orgId`. */
export async function resolveFollowers(resource: ResourceRef, orgId: string): Promise<string[]> {
  const ids = new Set<string>();

  const { data: subs } = await supabase
    .from("subscriptions")
    .select("user_id")
    .eq("resource_type", resource.type)
    .eq("resource_id", resource.id);
  ((subs as Array<{ user_id: string }> | null) ?? []).forEach((r) => ids.add(r.user_id));

  // Tickets carry their own watchers array. Only an emit() that passes
  // `followers: true` on a ticket reaches here (the intake door's redline
  // notice); the two ticket routes fold tickets.watchers themselves and never
  // call this (ROUTE-3 (a) — see the header).
  if (resource.type === "ticket") {
    const { data: t } = await supabase
      .from("tickets")
      .select("watchers")
      .eq("id", resource.id)
      .maybeSingle();
    ((t?.watchers as string[] | null) ?? []).forEach((u) => ids.add(u));
  }

  return activeMembersOf(orgId, Array.from(ids));
}

/** Active org members whose role — headline OR additive collection — is in `roles`. */
export async function resolveRoleRecipients(orgId: string, roles: string[]): Promise<string[]> {
  if (!orgId || roles.length === 0) return [];
  const { data } = await supabase
    .from("org_members")
    .select("uid, role, roles")
    .eq("org_id", orgId)
    .eq("status", "active");
  const want = new Set(roles);
  const out = new Set<string>();
  ((data as Array<{ uid: string; role: string | null; roles: string[] | null }> | null) ?? []).forEach((m) => {
    const held = m.roles && m.roles.length > 0 ? m.roles : m.role ? [m.role] : [];
    if (held.some((r) => want.has(r))) out.add(m.uid);
  });
  return Array.from(out);
}

/** Members of a project — implicit followers of project-scoped events. */
export async function resolveProjectMembers(projectId: string): Promise<string[]> {
  if (!projectId) return [];
  const { data } = await supabase
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId);
  return ((data as Array<{ user_id: string }> | null) ?? []).map((r) => r.user_id);
}

/** The project row projectVisibleAmong judges by: its visibility and owner. */
export interface ProjectVisibilityRow {
  visibility?: string | null;
  owner_user_id?: string | null;
}

/** SEC-2 (notifications N8, final review fix): the subset of `uids` who can
 *  see project `projectId`, in input order. This is the rule the database's
 *  project_visible_to_me holds for change orders, cost accounts and turnover
 *  items (20260913:40, 20261102). A project that is not private
 *  (`visibility IS DISTINCT FROM 'private'`) keeps everyone; the dispatcher
 *  then keeps active org members only. A PRIVATE project keeps only its
 *  owner, its roster (project_members — resolveProjectMembers, the
 *  dispatcher's { projectId } audience) and the org's controllers (an
 *  active Admin or DocCtrl, headline or additive — resolveRoleRecipients,
 *  never wider than is_org_controller). For a recipient a producer names by
 *  hand (a budget line's CAM, a change order's proposer, a turnover item's
 *  creator, a task's new assignee): it only ever removes. `project` is the
 *  row when the caller has read it already (null: it could not be read);
 *  otherwise it is read here. A project that cannot be read keeps nobody
 *  (fail closed). Never throws. */
export async function projectVisibleAmong(
  orgId: string, projectId: string, uids: Array<string | null | undefined>, project?: ProjectVisibilityRow | null,
): Promise<string[]> {
  const want = Array.from(new Set(uids.filter((u): u is string => !!u)));
  if (!projectId || want.length === 0) return [];
  try {
    let row = project;
    if (row === undefined) {
      const { data, error } = await supabase.from("projects").select("visibility, owner_user_id").eq("id", projectId).maybeSingle();
      row = error ? null : ((data as ProjectVisibilityRow | null) ?? null);
    }
    if (!row) return [];
    if (row.visibility !== "private") return want;
    const seeing = new Set<string>(row.owner_user_id ? [row.owner_user_id] : []);
    if (want.some((u) => !seeing.has(u))) (await resolveProjectMembers(projectId)).forEach((u) => seeing.add(u));
    if (want.some((u) => !seeing.has(u))) (await resolveRoleRecipients(orgId, ["Admin", "DocCtrl"])).forEach((u) => seeing.add(u));
    return want.filter((u) => seeing.has(u));
  } catch (e) {
    console.warn("[notify] project visibility could not be read — the hand-named recipients are left out", (e as Error)?.message ?? e);
    return [];
  }
}

// ─── Discovery (NEDGE-6 done-when 3, TAX-4 done-when 3 — N15) ───────────────

/** One discover check's answer: who among the people asked may discover the
 *  document. */
export type DiscoverCheckAnswer = { ok: true; discover: string[] } | { ok: false; error: string };
export type DiscoverCheck = (input: { orgId: string; documentId: string; uids: string[] }) => Promise<DiscoverCheckAnswer>;

/** The SERVER check (lib/documentDiscoverers.ts discoverersOfDocument, on the
 *  service role). That module registers it when it is loaded — it imports
 *  supabaseAdmin, so this file (bundled for the browser too) never imports
 *  it. A server entry that emits document-scoped follower notices loads it
 *  (app/api/intake/upload/route.ts). */
let serverDiscoverCheck: DiscoverCheck | null = null;
export function __registerServerDiscoverCheck(fn: DiscoverCheck | null): void {
  serverDiscoverCheck = fn;
}

/** How many people one discover call asks about (the route's
 *  DISCOVERERS_MAX_UIDS). */
export const DISCOVER_CHUNK = 500;

/** How long the browser waits for the WHOLE discover check — the session
 *  read and the route together — before it counts as FAILED (review fix;
 *  fix pass 4 widened it from the fetch alone: a stalled
 *  supabase.auth.getSession() held the caller open too). A timed-out check
 *  takes the failed-check path (controllers in full, the others redacted)
 *  instead of holding the emit — and whatever awaits it — open
 *  indefinitely. */
export const DISCOVER_TIMEOUT_MS = 5000;

const DISCOVER_TIMED_OUT = `the discover check did not answer within ${DISCOVER_TIMEOUT_MS} ms`;

/** NEDGE-6 remainder (notifications N16): how long a FAILED check's
 *  controllers lookup (controllersAmong — who among the people the check
 *  could not settle still gets the notice in full) may take, in the browser
 *  and on the server. Past it the lookup answers with nobody confirmed, so
 *  the LOOKUP itself never holds the emit open: the notice goes on to
 *  whoever was resolved — a controller not confirmed in time gets the notice
 *  without its details, like everyone else the check could not settle — and
 *  the shortfall is logged. It bounds the lookup only: the reads and inserts
 *  after it go through the same shared client, and a stalled session read
 *  (which that client awaits before every request) stalls them as it stalls
 *  every write in the app (NEDGE-6's residual). The same length as the
 *  check's own bound. */
export const CONTROLLERS_LOOKUP_TIMEOUT_MS = DISCOVER_TIMEOUT_MS;

/** NEDGE-6 remainder (N16): the row cap of the controllers read. The lookup
 *  reads the org's active controllers in ONE query (lib/roleHeld roleFilter
 *  — headline or additive, the one place that filter is spelled), at most
 *  this many rows (`.limit`; PostgREST's usual max-rows), and keeps the ones
 *  among the people asked. A read that comes back AT the cap is logged: a
 *  controller past it is left unconfirmed (the redacted notice), never
 *  dropped. An org's controller tier is a handful of people, so the cap is
 *  a guard, not a page size. */
export const CONTROLLERS_LOOKUP_MAX_ROWS = 1000;

/** The controller tier (DEC-43): an active Admin or DocCtrl, headline or
 *  additive. */
const CONTROLLER_ROLES = ["Admin", "DocCtrl"] as const;

export type ControllersLookup = {
  /** the active controllers among the people asked (none when the read did
   *  not answer in time or failed) */
  controllers: Set<string>;
  /** the lookup did not finish within CONTROLLERS_LOOKUP_TIMEOUT_MS */
  timedOut: boolean;
  /** the read failed */
  error?: string;
  /** the read came back with CONTROLLERS_LOOKUP_MAX_ROWS rows — a controller
   *  past the cap could not be confirmed */
  capped?: boolean;
};

/** NEDGE-6 remainder (notifications N16): the org's controllers among `uids`
 *  — the people a FAILED discover check still tells in full (DEC-43, DEC-106
 *  item 2). One read of the org's active controllers (roleFilter), bounded
 *  by a deadline (CONTROLLERS_LOOKUP_TIMEOUT_MS, the request aborted where
 *  the client supports it) and a row cap (CONTROLLERS_LOOKUP_MAX_ROWS),
 *  intersected with `uids` and re-checked with memberHoldsAny (the server
 *  rule; is_org_controller's). On the deadline or a read error it confirms
 *  nobody; whoever it could not confirm is left to the caller's failed-check
 *  path (the redacted notice). Never throws, never waits past the deadline.
 *  Exported for the test. */
export async function controllersAmong(orgId: string, uids: string[]): Promise<ControllersLookup> {
  const want = new Set(uids.filter(Boolean));
  if (!orgId || want.size === 0) return { controllers: new Set(), timedOut: false };
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => { timedOut = true; ctrl?.abort(); resolve("timeout"); }, CONTROLLERS_LOOKUP_TIMEOUT_MS);
  });
  const looked = (async (): Promise<Omit<ControllersLookup, "timedOut">> => {
    try {
      let q = supabase
        .from("org_members")
        .select("uid, role, roles")
        .eq("org_id", orgId)
        .eq("status", "active")
        .or(roleFilter(CONTROLLER_ROLES))
        .limit(CONTROLLERS_LOOKUP_MAX_ROWS);
      const withSignal = q as unknown as { abortSignal?: (s: AbortSignal) => typeof q };
      if (ctrl && typeof withSignal.abortSignal === "function") q = withSignal.abortSignal(ctrl.signal);
      const { data, error } = await q;
      if (error) return { controllers: new Set(), error: error.message };
      const rows = (data as Array<{ uid: string; role: string | null; roles: string[] | null }> | null) ?? [];
      const controllers = new Set(rows.filter((m) => want.has(m.uid) && memberHoldsAny(m, CONTROLLER_ROLES)).map((m) => m.uid));
      return rows.length >= CONTROLLERS_LOOKUP_MAX_ROWS ? { controllers, capped: true } : { controllers };
    } catch (e) {
      return { controllers: new Set(), error: (e as Error)?.message ?? String(e) };
    }
  })();
  try {
    const first = await Promise.race([looked, deadline]);
    if (first === "timeout" || timedOut) return { controllers: new Set(), timedOut: true };
    return { ...first, timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/** The BROWSER check: POST /api/documents/discoverers with the member's own
 *  token. The route answers only about a document the caller's session can
 *  read, and only the subset of the people sent. Never throws; the session
 *  read and the fetch together are bounded by DISCOVER_TIMEOUT_MS — past it
 *  the check answers a failure at once and the fetch, if started, is
 *  aborted. */
function browserDiscoverCheck(input: { orgId: string; documentId: string; uids: string[] }): Promise<DiscoverCheckAnswer> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DiscoverCheckAnswer>((resolve) => {
    timer = setTimeout(() => {
      ctrl?.abort();
      resolve({ ok: false, error: DISCOVER_TIMED_OUT });
    }, DISCOVER_TIMEOUT_MS);
  });
  const asked = (async (): Promise<DiscoverCheckAnswer> => {
    try {
      const { data } = await supabase.auth.getSession();
      if (ctrl?.signal.aborted) return { ok: false, error: DISCOVER_TIMED_OUT };
      const token = data?.session?.access_token;
      if (!token) return { ok: false, error: "no signed-in session" };
      const res = await fetch("/api/documents/discoverers", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
        signal: ctrl?.signal,
      });
      const body = (await res.json().catch(() => null)) as { discover?: unknown; error?: unknown } | null;
      if (ctrl?.signal.aborted) return { ok: false, error: DISCOVER_TIMED_OUT };
      if (!res.ok || !body || !Array.isArray(body.discover)) {
        return { ok: false, error: typeof body?.error === "string" ? body.error : `the discover check answered ${res.status}` };
      }
      return { ok: true, discover: (body.discover as unknown[]).filter((u): u is string => typeof u === "string") };
    } catch (e) {
      if (ctrl?.signal.aborted) return { ok: false, error: DISCOVER_TIMED_OUT };
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  })();
  return Promise.race([asked, timedOut]).finally(() => clearTimeout(timer));
}

export type DiscoverFilter = {
  /** the people kept, in input order */
  uids: string[];
  /** checked: the check answered; failed: it ran and did not answer — only
   *  the controllers were kept (fail closed; the caller decides what the
   *  others get — emit() sends them redactedNotice(), the checkout thread
   *  keeps its session holders); unavailable: no check exists in
   *  this context (a server entry that did not load lib/documentDiscoverers)
   *  — everyone was kept, as before the filter, and it is logged. */
  outcome: "checked" | "failed" | "unavailable";
  error?: string;
};

/**
 * NEDGE-6 done-when 3 / TAX-4 done-when 3: the subset of `uids` who may
 * DISCOVER document `documentId` — the bar a member's own client applies
 * over the full library → folders → document chain, the effective owner and
 * the controller tier (DEC-43: an Admin or DocCtrl is never dropped). On the
 * server through the registered check; in the browser through the route.
 *
 * A check that runs and fails keeps only the org's controllers among `uids`
 * (fail closed — a notice names the document, so it is not sent to someone
 * who might not be allowed to know it exists; DEC-90's fail-safe rule) and
 * logs; the caller decides what the others get (emit() sends them a notice
 * without the details — dispatch.ts redactedNotice). The controllers are
 * read by controllersAmong — one read, bounded by CONTROLLERS_LOOKUP_TIMEOUT_MS
 * and a row cap (NEDGE-6 remainder, notifications N16): a controller it could
 * not confirm in time is left with the others, never waited for. A context with
 * no check (unregistered server entry) keeps everyone, logged — the
 * behaviour before this filter. Never throws.
 *
 * NEDGE-22 (N16): a notice about a LIBRARY that names a document in it asks
 * the same question about that document (dispatch.ts resolveAudience,
 * EmitInput.namesDocuments) — the server check and the route evaluate the
 * library rung the library page evaluates (lib/libraryAccess
 * effectiveLibraryAclFromRow through lib/docFileServer
 * loadContainerAclChain, DEC-90 R1).
 */
export async function discoveringAmong(orgId: string, documentId: string, uids: Array<string | null | undefined>): Promise<DiscoverFilter> {
  const want = Array.from(new Set(uids.filter((u): u is string => !!u)));
  if (!orgId || !documentId || want.length === 0) return { uids: [], outcome: "checked" };
  const check = typeof window === "undefined" ? serverDiscoverCheck : browserDiscoverCheck;
  if (!check) {
    console.warn(`[notify] no discover check in this context — ${want.length} follower(s) of document ${documentId} kept unchecked (load lib/documentDiscoverers in this server entry)`);
    return { uids: want, outcome: "unavailable" };
  }
  const seen = new Set<string>();
  let failure: string | null = null;
  for (let i = 0; i < want.length && !failure; i += DISCOVER_CHUNK) {
    let answer: DiscoverCheckAnswer;
    try {
      answer = await check({ orgId, documentId, uids: want.slice(i, i + DISCOVER_CHUNK) });
    } catch (e) {
      answer = { ok: false, error: (e as Error)?.message ?? String(e) };
    }
    if (!answer.ok) failure = answer.error;
    else answer.discover.forEach((u) => seen.add(u));
  }
  if (failure) {
    // NEDGE-6 remainder (notifications N16): the controllers lookup is
    // bounded (controllersAmong — one read of the org's controllers under a
    // deadline and a row cap). A lookup that times out, fails or comes back
    // at its cap keeps the controllers it confirmed (none, unless capped);
    // the rest are left unsettled (the redacted notice) — the lookup never
    // holds the emit open — and the shortfall is logged.
    const lookup = await controllersAmong(orgId, want);
    const kept = want.filter((u) => lookup.controllers.has(u));
    const short = lookup.timedOut || !!lookup.error || !!lookup.capped;
    if (short) {
      const why = lookup.timedOut
        ? `did not answer within ${CONTROLLERS_LOOKUP_TIMEOUT_MS} ms`
        : lookup.error ? `failed (${lookup.error})` : `came back at its row cap (${CONTROLLERS_LOOKUP_MAX_ROWS} rows)`;
      console.warn(`[notify] the controllers lookup for document ${documentId} ${why} — ${kept.length} controller(s) confirmed; the other ${want.length - kept.length} recipient(s), any controller among them included, are left to the notice without its details`);
    }
    console.warn(`[notify] the discover check for document ${documentId} failed (${failure}) — ${want.length - kept.length} ${short ? "unconfirmed" : "non-controller"} recipient(s) not settled (the caller withholds them or sends them a notice without the details)`);
    return { uids: kept, outcome: "failed", error: failure };
  }
  return { uids: want.filter((u) => seen.has(u)), outcome: "checked" };
}
