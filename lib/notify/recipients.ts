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
// discoveringAmong, below; controllers are never dropped (DEC-43).
//
// Membership (NEDGE-3, notifications Round G N5): only an ACTIVE member of
// the event's org is a recipient. The role pool always asked for status =
// 'active'; the follow stores and the project roster did not, so a suspended
// member, a restore's 'inactive' placeholder or a removed member kept every
// watch. dispatch.ts resolveRecipients filters the final set once, centrally
// (activeMembersOf); resolveFollowers applies the same filter itself as a
// defence in depth, for any caller that reads followers directly.

import { supabase } from "@/lib/supabase";

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

/** The BROWSER check: POST /api/documents/discoverers with the member's own
 *  token. The route answers only about a document the caller's session can
 *  read, and only the subset of the people sent. Never throws. */
async function browserDiscoverCheck(input: { orgId: string; documentId: string; uids: string[] }): Promise<DiscoverCheckAnswer> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return { ok: false, error: "no signed-in session" };
    const res = await fetch("/api/documents/discoverers", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => null)) as { discover?: unknown; error?: unknown } | null;
    if (!res.ok || !body || !Array.isArray(body.discover)) {
      return { ok: false, error: typeof body?.error === "string" ? body.error : `the discover check answered ${res.status}` };
    }
    return { ok: true, discover: (body.discover as unknown[]).filter((u): u is string => typeof u === "string") };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}

export type DiscoverFilter = {
  /** the people kept, in input order */
  uids: string[];
  /** checked: the check answered; failed: it ran and did not answer — only
   *  the controllers were kept (fail closed); unavailable: no check exists in
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
 * logs. A context with no check (unregistered server entry) keeps everyone,
 * logged — the behaviour before this filter. Never throws.
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
    let controllers = new Set<string>();
    try {
      controllers = new Set(await resolveRoleRecipients(orgId, ["Admin", "DocCtrl"]));
    } catch { /* nobody but a known controller */ }
    const kept = want.filter((u) => controllers.has(u));
    console.warn(`[notify] the discover check for document ${documentId} failed (${failure}) — ${want.length - kept.length} non-controller recipient(s) withheld`);
    return { uids: kept, outcome: "failed", error: failure };
  }
  return { uids: want.filter((u) => seen.has(u)), outcome: "checked" };
}
