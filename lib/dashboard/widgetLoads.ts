// lib/dashboard/widgetLoads.ts - the first loads of Home's widgets and of
// its libraries and projects strip, named so the widget and sign-in start
// the same one (components/dashboard/kit useWidgetData `name`). Each is
// the query the widget always made; only where it lives changed.

import { supabase } from "@/lib/supabase";
import { sharedLoad } from "@/lib/warmLoads";
import { headCount, fetchRecentDates, widgetLoadKey } from "@/components/dashboard/kit";
import { listKnowledgeLibraries } from "@/lib/knowledge";
import { myProjectIds } from "@/lib/projects";
import { phasesOfRow, projectDue, projectDueWords } from "@/lib/projectPhases";
import { dayKey } from "@/lib/scheduleTz";
import type { WidgetType } from "@/lib/dashboard/types";

// ─── Document Control: the libraries, with their counts ────────────
export interface DocLib { id: string; name: string; color?: string | null; icon?: string | null; type?: string | null; cover_image_url?: string | null; cover_tint?: "none" | "brand" | "mono" | null; count?: number }
export async function loadDocTop(orgId: string): Promise<{ libs: DocLib[]; totalDocs: number; newDates: string[] }> {
  let libs: DocLib[] = [];
  const rich = await supabase.from("libraries").select("id, name, color, icon, type, cover_image_url, cover_tint").eq("org_id", orgId).order("name");
  if (!rich.error) libs = (rich.data ?? []) as DocLib[];
  else libs = ((await supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name")).data ?? []) as DocLib[];
  const head = libs.slice(0, 24);
  const [counted, totalDocs, newDates] = await Promise.all([
    Promise.all(head.map(async (l) => ({
      ...l,
      count: await headCount(() => supabase.from("documents").select("id", { count: "exact", head: true })
        .eq("org_id", orgId).eq("library_id", l.id) as unknown as Promise<{ count: number | null }>),
    }))),
    headCount(() => supabase.from("documents").select("id", { count: "exact", head: true }).eq("org_id", orgId) as unknown as Promise<{ count: number | null }>),
    fetchRecentDates("documents", orgId, 14),
  ]);
  return { libs: [...counted, ...libs.slice(24)], totalDocs, newDates };
}

// ─── Drafting Requests: the open ones ──────────────────────────────
export interface OpenTicketRow {
  id: string; ticket_id: string | null; title: string | null; status: string | null; priority: number | null;
  created_at: string | null; updated_at: string | null; requester_id: string | null; requester_name: string | null;
  assigned_drafter_id: string | null; assigned_drafter_name: string | null; assigned_engineer_id: string | null;
}
export async function loadOpenRequests(orgId: string): Promise<{ rows: OpenTicketRow[]; newDates: string[] }> {
  const [rows, newDates] = await Promise.all([
    supabase.from("tickets")
      .select("id, ticket_id, title, status, priority, created_at, updated_at, requester_id, requester_name, assigned_drafter_id, assigned_drafter_name, assigned_engineer_id")
      .eq("org_id", orgId).not("status", "in", '("CLOSED","CANCELED")')
      .order("created_at", { ascending: false }).limit(500),
    fetchRecentDates("tickets", orgId, 14),
  ]);
  return { rows: (rows.data ?? []) as OpenTicketRow[], newDates };
}

// ─── Ask Knowledge: the libraries to ask ───────────────────────────
export async function loadKnowledgeLibs(orgId: string): Promise<Array<{ id: string; name: string }>> {
  // A failed read throws: the frame says it failed instead of "no libraries".
  return (await listKnowledgeLibraries(orgId)).map((l) => ({ id: l.id, name: l.name }));
}

// ─── Home's libraries and projects strip ───────────────────────────
/** What changed last in a library: the document, who, when. */
export interface LastChange { label: string; rev: string | null; by: string | null; at: string }
/** Counts are null when they couldn't be read. */
export interface HomeLibRow { id: string; name: string; docs: number | null; out: number | null; last: LastChange | null }
export interface HomeProjRow {
  id: string; name: string; owner: string | null; moc: string | null; lastActivity: string | null;
  due: string | null; late: boolean; timezone: string | null;
}

async function nullableCount(build: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number | null> {
  try { const r = await build(); return r.error ? null : r.count; } catch { return null; }
}

/** The most recently changed document in each library, with who changed
 *  it (names read in one batch). Best effort: a failure leaves it blank. */
async function lastChanges(orgId: string, libIds: string[], uid: string | null): Promise<Map<string, LastChange>> {
  const out = new Map<string, LastChange>();
  try {
    const rows = await Promise.all(libIds.map(async (id) => {
      const { data } = await supabase.from("documents")
        .select("library_id, document_number, title, name, rev, revision, updated_at, updated_by")
        .eq("org_id", orgId).eq("library_id", id).not("updated_at", "is", null)
        .order("updated_at", { ascending: false }).limit(1);
      return ((data ?? []) as Array<Record<string, unknown>>)[0] ?? null;
    }));
    const who = [...new Set(rows.map((r) => (r?.updated_by as string | null) ?? null).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    if (who.length) {
      const { data } = await supabase.from("users").select("id, display_name, email").in("id", who);
      for (const u of (data ?? []) as Array<{ id: string; display_name: string | null; email: string | null }>) {
        names.set(u.id, u.id === uid ? "you" : u.display_name || (u.email ?? "").split("@")[0] || "");
      }
    }
    rows.forEach((r, i) => {
      if (!r?.updated_at) return;
      const label = String(r.document_number || r.title || r.name || "A document");
      const rev = (r.rev ?? r.revision ?? null) as string | null;
      const by = r.updated_by ? names.get(String(r.updated_by)) || null : null;
      out.set(libIds[i], { label, rev: rev ? String(rev) : null, by, at: String(r.updated_at) });
    });
  } catch { /* the column stays blank */ }
  return out;
}

export const homeLibrariesKey = (orgId: string, uid: string | null) => `home-libs:${orgId}|${uid ?? ""}`;
export async function loadHomeLibraries(orgId: string, uid: string | null): Promise<HomeLibRow[]> {
  try {
    const { data } = await supabase.from("libraries").select("id, name").eq("org_id", orgId).order("name").limit(12);
    const rows = (data ?? []) as Array<{ id: string; name: string | null }>;
    const [counted, last] = await Promise.all([
      Promise.all(rows.map(async (l) => ({
        id: l.id,
        name: l.name ?? "Library",
        docs: await nullableCount(() => supabase.from("documents").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("library_id", l.id)),
        out: await nullableCount(() => supabase.from("documents").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("library_id", l.id).not("checked_out_by", "is", null)),
      }))),
      lastChanges(orgId, rows.map((l) => l.id), uid),
    ]);
    const withLast: HomeLibRow[] = counted.map((l) => ({ ...l, last: last.get(l.id) ?? null }));
    // The library changed most recently first, so the busy ones are in sight.
    withLast.sort((a, b) => (b.last?.at ?? "").localeCompare(a.last?.at ?? "") || ((b.docs ?? 0) > 0 ? 1 : 0) - ((a.docs ?? 0) > 0 ? 1 : 0));
    return withLast;
  } catch { return []; }
}

export const homeProjectsKey = (orgId: string, uid: string | null) => `home-projects:${orgId}|${uid ?? ""}`;
export async function loadHomeProjects(orgId: string, uid: string | null): Promise<HomeProjRow[]> {
  try {
    // Only yours: the projects you own or are a member of.
    const [{ data }, mine] = await Promise.all([
      supabase.from("projects")
        .select("id, name, owner_user_id, owner_user_name, moc_reference, last_activity_at, target_completion_date, timezone, phases, st_phases:shift_times->phases")
        .eq("org_id", orgId).eq("status", "active")
        .order("last_activity_at", { ascending: false, nullsFirst: false }).limit(200),
      uid ? myProjectIds(orgId, uid) : Promise.resolve(new Set<string>()),
    ]);
    const now = Date.now();
    return ((data ?? []) as Array<{
      id: string; name: string | null; owner_user_id: string | null; owner_user_name: string | null; moc_reference: string | null;
      last_activity_at: string | null; target_completion_date: string | null; timezone?: string | null; phases?: unknown; st_phases?: unknown;
    }>).filter((p) => mine.has(p.id) || (!!uid && p.owner_user_id === uid)).slice(0, 12).map((p) => {
      const due = projectDue(phasesOfRow({ phases: p.phases, shift_times: p.st_phases != null ? { phases: p.st_phases } : null }), p.target_completion_date, dayKey(now, p.timezone || "America/Los_Angeles"));
      return {
        id: p.id, name: p.name ?? "Untitled project",
        owner: p.owner_user_id && p.owner_user_id === uid ? "You" : p.owner_user_name,
        moc: p.moc_reference, lastActivity: p.last_activity_at,
        due: due ? projectDueWords(due) : null, late: due?.kind === "past target", timezone: p.timezone ?? null,
      };
    });
  } catch { return []; }
}

/** Start the first loads of these widgets, and of the strip under them. */
export function warmWidgets(types: WidgetType[], orgId: string, uid: string): void {
  const has = new Set(types);
  if (has.has("documentControl")) void sharedLoad(widgetLoadKey("docs.top", orgId, uid), () => loadDocTop(orgId)).catch(() => undefined);
  if (has.has("draftingRequests")) void sharedLoad(widgetLoadKey("requests.open", orgId, uid), () => loadOpenRequests(orgId)).catch(() => undefined);
  if (has.has("askKnowledge")) void sharedLoad(widgetLoadKey("knowledge.libs", orgId, uid), () => loadKnowledgeLibs(orgId)).catch(() => undefined);
  void sharedLoad(homeLibrariesKey(orgId, uid), () => loadHomeLibraries(orgId, uid));
  void sharedLoad(homeProjectsKey(orgId, uid), () => loadHomeProjects(orgId, uid));
}
