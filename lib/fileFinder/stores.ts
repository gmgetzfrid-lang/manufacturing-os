// lib/fileFinder/stores.ts — where aliases and drive listings live.
//
// Supabase when the 20261019 migration has been applied; the browser's own
// storage when it hasn't. The fallback exists so the prototype can be seen
// working on a workspace that is behind on migrations — but it is per-user
// and per-browser, and the UI says so, because a taught alias nobody else
// can see is a trap.

import { supabase } from "@/lib/supabase";
import { canonicalForm } from "./tagForms";
import type { FinderAlias, FinderAliasKind } from "./aliasTypes";
import type { ListedFile } from "./dirTree";

export interface FinderListing {
  id: string;
  orgId: string;
  name: string;
  format: string | null;
  fileCount: number;
  files: ListedFile[];
  folders: string[];
  createdByName: string | null;
  createdAt: string;
}

const missing = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || /does not exist|schema cache/i.test(e.message ?? ""));

/** True once a read has fallen back — the UI shows a "browser only" note. */
export const storeState = { aliasesLocal: false, listingsLocal: false };

function lsKey(kind: "aliases" | "listings", orgId: string) {
  return `manufacturingos.finder.${kind}.${orgId}`;
}
function lsRead<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(window.localStorage.getItem(key) ?? "[]") as T[]; } catch { return []; }
}
function lsWrite<T>(key: string, rows: T[]) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(key, JSON.stringify(rows)); } catch { /* quota or private mode */ }
}
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

// ── Aliases ───────────────────────────────────────────────────────────────

function aliasFromRow(r: Record<string, unknown>): FinderAlias {
  return {
    id: String(r.id), orgId: String(r.org_id),
    term: String(r.term), termCanonical: String(r.term_canonical),
    means: String(r.means), meansCanonical: String(r.means_canonical),
    kind: (r.kind as FinderAliasKind) ?? "term",
    origin: (r.origin as FinderAlias["origin"]) ?? "human",
    hits: Number(r.hits ?? 0), misses: Number(r.misses ?? 0),
    note: (r.note as string | null) ?? null,
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: String(r.created_at ?? ""),
  };
}

export async function listFinderAliases(orgId: string): Promise<FinderAlias[]> {
  const { data, error } = await supabase.from("finder_aliases").select("*").eq("org_id", orgId).order("created_at");
  if (error) {
    if (!missing(error)) throw new Error(error.message);
    storeState.aliasesLocal = true;
    return lsRead<FinderAlias>(lsKey("aliases", orgId));
  }
  storeState.aliasesLocal = false;
  return ((data as Record<string, unknown>[]) ?? []).map(aliasFromRow);
}

export async function addFinderAlias(input: {
  orgId: string; term: string; means: string; kind: FinderAliasKind; note?: string;
  userId?: string | null; userName?: string | null;
}): Promise<FinderAlias> {
  const term = input.term.trim(), means = input.means.trim();
  if (!term || !means) throw new Error("Both the alias and what it means are required.");
  const row = {
    org_id: input.orgId, term, term_canonical: canonicalForm(term),
    means, means_canonical: canonicalForm(means), kind: input.kind, origin: "human",
    note: input.note?.trim() || null, created_by: input.userId ?? null, created_by_name: input.userName ?? null,
  };
  const { data, error } = await supabase.from("finder_aliases").insert(row).select("*").single();
  if (error) {
    if (error.code === "23505") throw new Error("That alias is already taught.");
    if (!missing(error)) throw new Error(error.message);
    const local: FinderAlias = {
      id: newId(), orgId: input.orgId, term, termCanonical: row.term_canonical,
      means, meansCanonical: row.means_canonical, kind: input.kind, origin: "human",
      hits: 0, misses: 0, note: row.note, createdByName: input.userName ?? null, createdAt: new Date().toISOString(),
    };
    const key = lsKey("aliases", input.orgId);
    const rows = lsRead<FinderAlias>(key);
    if (rows.some((a) => a.termCanonical === local.termCanonical && a.meansCanonical === local.meansCanonical)) {
      throw new Error("That alias is already taught.");
    }
    lsWrite(key, [...rows, local]);
    return local;
  }
  return aliasFromRow(data as Record<string, unknown>);
}

export async function removeFinderAlias(orgId: string, id: string): Promise<void> {
  const { error } = await supabase.from("finder_aliases").delete().eq("id", id);
  if (error && !missing(error)) throw new Error(error.message);
  if (error) {
    const key = lsKey("aliases", orgId);
    lsWrite(key, lsRead<FinderAlias>(key).filter((a) => a.id !== id));
  }
}

/** A result reached through this alias was opened (hit) or its chip was
 *  removed (miss). Best-effort: a failed bump is never surfaced. */
export async function bumpFinderAlias(orgId: string, id: string, what: "hit" | "miss"): Promise<void> {
  const col = what === "hit" ? "hits" : "misses";
  const { data, error } = await supabase.from("finder_aliases").select(col).eq("id", id).maybeSingle();
  if (!error && data) {
    const cur = Number((data as Record<string, unknown>)[col] ?? 0);
    await supabase.from("finder_aliases").update({ [col]: cur + 1 }).eq("id", id);
    return;
  }
  const key = lsKey("aliases", orgId);
  lsWrite(key, lsRead<FinderAlias>(key).map((a) => (a.id === id ? { ...a, [col]: a[col] + 1 } : a)));
}

// ── Listings ──────────────────────────────────────────────────────────────

function listingFromRow(r: Record<string, unknown>): FinderListing {
  return {
    id: String(r.id), orgId: String(r.org_id), name: String(r.name),
    format: (r.format as string | null) ?? null,
    fileCount: Number(r.file_count ?? 0),
    files: (r.files as ListedFile[]) ?? [],
    folders: (r.folders as string[]) ?? [],
    createdByName: (r.created_by_name as string | null) ?? null,
    createdAt: String(r.created_at ?? ""),
  };
}

export async function listFinderListings(orgId: string): Promise<FinderListing[]> {
  const { data, error } = await supabase.from("finder_listings").select("*").eq("org_id", orgId).order("created_at");
  if (error) {
    if (!missing(error)) throw new Error(error.message);
    storeState.listingsLocal = true;
    return lsRead<FinderListing>(lsKey("listings", orgId));
  }
  storeState.listingsLocal = false;
  return ((data as Record<string, unknown>[]) ?? []).map(listingFromRow);
}

export async function saveFinderListing(input: {
  orgId: string; name: string; format: string; files: ListedFile[]; folders: string[];
  userId?: string | null; userName?: string | null;
}): Promise<FinderListing> {
  const name = input.name.trim() || "Pasted listing";
  const row = {
    org_id: input.orgId, name, format: input.format, file_count: input.files.length,
    files: input.files, folders: input.folders,
    created_by: input.userId ?? null, created_by_name: input.userName ?? null,
  };
  const { data, error } = await supabase.from("finder_listings").insert(row).select("*").single();
  if (error) {
    if (!missing(error)) throw new Error(error.message);
    const local: FinderListing = {
      id: newId(), orgId: input.orgId, name, format: input.format, fileCount: input.files.length,
      files: input.files, folders: input.folders, createdByName: input.userName ?? null, createdAt: new Date().toISOString(),
    };
    const key = lsKey("listings", input.orgId);
    lsWrite(key, [...lsRead<FinderListing>(key), local]);
    return local;
  }
  return listingFromRow(data as Record<string, unknown>);
}

export async function deleteFinderListing(orgId: string, id: string): Promise<void> {
  const { error } = await supabase.from("finder_listings").delete().eq("id", id);
  if (error && !missing(error)) throw new Error(error.message);
  if (error) {
    const key = lsKey("listings", orgId);
    lsWrite(key, lsRead<FinderListing>(key).filter((l) => l.id !== id));
  }
}
