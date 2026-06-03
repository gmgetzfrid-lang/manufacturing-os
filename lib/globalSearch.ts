// lib/globalSearch.ts
//
// Cross-resource search for the global Cmd+K palette. Fans out one
// tsvector query per resource type in parallel via Promise.allSettled
// so a single source failing returns partial results instead of
// blanking everything.
//
// Each hit is normalised to a GlobalHit shape so the palette can
// render them uniformly: title, subtitle, kind chip, href.

import { searchDocuments, searchAssets, searchTickets } from "@/lib/search";
import { supabase } from "@/lib/supabase";

export type GlobalHitKind = "document" | "ticket" | "project" | "asset" | "note" | "transmittal";

export interface GlobalHit {
  id: string;
  kind: GlobalHitKind;
  title: string;
  subtitle?: string;
  badge?: string;
  href: string;
}

export interface GlobalSearchInput {
  orgId: string;
  query: string;
  perKindLimit?: number; // default 5
}

export async function globalSearch({ orgId, query, perKindLimit = 5 }: GlobalSearchInput): Promise<GlobalHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const results = await Promise.allSettled([
    searchDocuments({ orgId, query: q, limit: perKindLimit }),
    searchTickets({ orgId, query: q, limit: perKindLimit }),
    searchAssets({ orgId, query: q, limit: perKindLimit }),
    searchProjects(orgId, q, perKindLimit),
    searchNotes(orgId, q, perKindLimit),
    searchTransmittals(orgId, q, perKindLimit),
  ]);

  const hits: GlobalHit[] = [];

  if (results[0].status === "fulfilled") {
    for (const d of results[0].value) {
      hits.push({
        id: String(d.id),
        kind: "document",
        title: d.document_number || d.title || "Untitled",
        subtitle: d.title || undefined,
        badge: d.status ?? undefined,
        href: `/documents/${d.library_id}?doc=${d.id}`,
      });
    }
  }

  if (results[1].status === "fulfilled") {
    for (const t of results[1].value) {
      hits.push({
        id: String(t.id),
        kind: "ticket",
        title: t.ticket_id ? `${t.ticket_id} · ${t.title}` : t.title,
        subtitle: t.requester_name || undefined,
        badge: t.status ?? undefined,
        href: `/requests/${t.id}`,
      });
    }
  }

  if (results[2].status === "fulfilled") {
    for (const a of results[2].value) {
      hits.push({
        id: String(a.id),
        kind: "asset",
        title: a.tag,
        subtitle: a.description || undefined,
        href: `/admin/assets?tag=${encodeURIComponent(a.tag)}`,
      });
    }
  }

  if (results[3].status === "fulfilled") {
    for (const p of results[3].value) {
      hits.push({
        id: String(p.id),
        kind: "project",
        title: p.name,
        subtitle: p.description || undefined,
        badge: p.status,
        href: `/projects/${p.id}`,
      });
    }
  }

  if (results[4].status === "fulfilled") {
    for (const n of results[4].value) {
      hits.push({
        id: String(n.id),
        kind: "note",
        title: n.preview,
        subtitle: n.created_by_name || undefined,
        href: n.href,
      });
    }
  }

  if (results[5].status === "fulfilled") {
    for (const t of results[5].value) {
      hits.push({
        id: String(t.id),
        kind: "transmittal",
        title: t.number,
        subtitle: t.subject || t.recipient_name || undefined,
        badge: t.status ?? undefined,
        href: "/transmittals",
      });
    }
  }

  return hits;
}

// ─── per-resource helpers ────────────────────────────────────────────

// Resilient: if the transmittals table isn't migrated yet, the query
// resolves with data:null → we return [] and search is unaffected.
async function searchTransmittals(
  orgId: string,
  q: string,
  limit: number,
): Promise<Array<{ id: string; number: string; subject: string | null; recipient_name: string | null; status: string }>> {
  const { data } = await supabase
    .from("transmittals")
    .select("id, number, subject, recipient_name, status")
    .eq("org_id", orgId)
    .or(`number.ilike.%${escape(q)}%,subject.ilike.%${escape(q)}%,recipient_name.ilike.%${escape(q)}%,recipient_company.ilike.%${escape(q)}%`)
    .order("seq", { ascending: false })
    .limit(limit);
  return ((data || []) as Array<{ id: string; number: string; subject: string | null; recipient_name: string | null; status: string }>);
}

async function searchProjects(
  orgId: string,
  q: string,
  limit: number,
): Promise<Array<{ id: string; name: string; description: string | null; status: string }>> {
  const { data } = await supabase
    .from("projects")
    .select("id, name, description, status")
    .eq("org_id", orgId)
    .or(`name.ilike.%${escape(q)}%,description.ilike.%${escape(q)}%`)
    .order("last_activity_at", { ascending: false })
    .limit(limit);
  return ((data || []) as Array<{ id: string; name: string; description: string | null; status: string }>);
}

async function searchNotes(
  orgId: string,
  q: string,
  limit: number,
): Promise<Array<{ id: string; preview: string; created_by_name: string | null; href: string }>> {
  const { data } = await supabase
    .from("notes")
    .select("id, body, created_by_name, document_id, project_id, asset_id")
    .eq("org_id", orgId)
    .ilike("body", `%${escape(q)}%`)
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data || []) as Array<Record<string, unknown>>).map((r) => {
    const body = String(r.body ?? "");
    const preview = body.length > 80 ? body.slice(0, 77) + "…" : body;
    let href = "/scratchpad";
    if (r.document_id) href = `/scratchpad?document=${r.document_id}`;
    else if (r.project_id) href = `/projects/${r.project_id}`;
    else if (r.asset_id) href = `/admin/assets`;
    return {
      id: String(r.id),
      preview,
      created_by_name: (r.created_by_name as string | null) ?? null,
      href,
    };
  });
}

function escape(s: string): string {
  return s.replace(/[%_,]/g, "\\$&");
}
