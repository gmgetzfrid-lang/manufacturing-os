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
import { findUnits } from "@/lib/findEverywhere";
import { tagKey } from "@/lib/findCore";

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
    // Room for every unit's copy of a tag: "E-22" is on three units.
    searchAssets({ orgId, query: q, limit: Math.max(perKindLimit, 8), archived: false }),
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
    // Names are never unique; say the unit, the ID and what it is, and open
    // the search with that one picked (its documents, the map, a preview).
    const units = new Map((await findUnits(orgId)).map((u) => [u.code, u.label]));
    const rows = results[2].value as Array<{ id: string; tag: string; description: string | null; unit_code?: string | null; code?: string | null }>;
    const key = tagKey(q);
    rows.sort((x, y) => Number(tagKey(y.tag) === key) - Number(tagKey(x.tag) === key));
    for (const a of rows) {
      const unit = a.unit_code ? `${a.unit_code} ${units.get(a.unit_code) ?? ""}`.trim() : "No unit set";
      hits.push({
        id: String(a.id),
        kind: "asset",
        title: a.code && !a.tag.includes(a.code) ? `${a.tag} · ${a.code}` : a.tag,
        subtitle: [unit, a.description].filter(Boolean).join(" · "),
        href: `/search?q=${encodeURIComponent(a.tag)}&pick=${encodeURIComponent(String(a.id))}`,
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
  // Notes live where the work lives (asset / project / document quick notes),
  // so each result links to the surface that shows it. A note anchored to
  // nothing has no surface anymore (the standalone scratchpad is gone) — those
  // are skipped rather than linked to a dead end.
  const { data } = await supabase
    .from("notes")
    .select("id, body, created_by_name, document_id, project_id, asset_id, documents:document_id(library_id)")
    .eq("org_id", orgId)
    .ilike("body", `%${escape(q)}%`)
    .order("created_at", { ascending: false })
    .limit(limit);
  const out: Array<{ id: string; preview: string; created_by_name: string | null; href: string }> = [];
  for (const r of (data || []) as Array<Record<string, unknown>>) {
    const body = String(r.body ?? "");
    const preview = body.length > 80 ? body.slice(0, 77) + "…" : body;
    let href: string | null = null;
    if (r.document_id) {
      const libraryId = (r.documents as { library_id?: string | null } | null)?.library_id ?? null;
      href = libraryId ? `/documents/${libraryId}?doc=${r.document_id}` : "/documents";
    } else if (r.project_id) href = `/projects/${r.project_id}`;
    else if (r.asset_id) href = `/admin/assets`;
    if (!href) continue;
    out.push({
      id: String(r.id),
      preview,
      created_by_name: (r.created_by_name as string | null) ?? null,
      href,
    });
  }
  return out;
}

function escape(s: string): string {
  return s.replace(/[%_,]/g, "\\$&");
}
