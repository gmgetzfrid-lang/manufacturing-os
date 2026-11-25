// lib/shareLinks.ts: SERVER-ONLY. The rules for links sent to people
// outside the company (document_shares), shared by the /api/share routes.
//
// A link is a token (32 url-safe random characters) that opens one or more
// documents with no sign-in, until it expires or someone turns it off. It
// can ask for a 6-digit code first: only a scrypt hash of the code is kept,
// salted with the link's own token, and ten wrong codes lock the link for
// good (that lockout is the rate limit on guessing). Every file it serves is
// stamped as an uncontrolled copy on the server.
//
// Links made before 20261123_controlled_links.sql have none of the new
// columns: they read as one document, no code, download allowed, which is
// exactly how they behaved.

import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertSafeStorageKey } from "@/lib/storageKey";

export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Wrong codes before a link locks. */
export const CODE_LOCK_AT = 10;
export const EXPIRY_DAYS = [1, 7, 30] as const;
export const MAX_SHARE_ITEMS = 200;
export const SHARE_SQL_MESSAGE = "Run the SQL in supabase/migrations/20261123_controlled_links.sql first.";

// ─── Token and code ────────────────────────────────────────────────────────

/** 32 url-safe characters (24 random bytes). */
export function newShareToken(): string {
  return randomBytes(24).toString("base64url");
}

/** 6 random digits, leading zeros kept. */
export function newShareCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const HASH_PREFIX = "scrypt1$";

function scryptHex(code: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(code, `document_share:${salt}`, 32, SCRYPT_PARAMS, (err, key) => (err ? reject(err) : resolve(key.toString("hex"))));
  });
}

/** What is stored for a code: never the code itself. The salt is the
 *  link's token, so the same code on two links hashes differently. */
export async function hashShareCode(code: string, salt: string): Promise<string> {
  return `${HASH_PREFIX}${await scryptHex(code, salt)}`;
}

/** True when `code` is the code `stored` was made from. */
export async function verifyShareCode(code: string, salt: string, stored: string): Promise<boolean> {
  if (!/^\d{6}$/.test(code) || !stored.startsWith(HASH_PREFIX)) return false;
  const want = Buffer.from(stored.slice(HASH_PREFIX.length), "hex");
  const got = Buffer.from(await scryptHex(code, salt), "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

// ─── What a link covers ────────────────────────────────────────────────────

export interface ShareItem { documentId: string; markupPath: string | null }

/** A marked-up copy must be a plain key in this workspace's shares folder. */
export function isValidMarkupPath(path: unknown, orgId: string): path is string {
  if (typeof path !== "string" || !UUID_RE.test(orgId)) return false;
  if (!path.startsWith(`orgs/${orgId}/shares/`) || path.includes("..")) return false;
  if (path.length > 400 || !/\.pdf$/i.test(path)) return false;
  try { assertSafeStorageKey(path); } catch { return false; }
  return true;
}

/** The documents a link opens: its items, or (older links, items null) the
 *  one document it was made for. */
export function shareItems(row: { document_id: string; items?: unknown; org_id?: string }): ShareItem[] {
  if (!Array.isArray(row.items) || row.items.length === 0) {
    return row.document_id ? [{ documentId: row.document_id, markupPath: null }] : [];
  }
  const out: ShareItem[] = [];
  const seen = new Set<string>();
  for (const raw of row.items as Array<Record<string, unknown>>) {
    const id = typeof raw?.documentId === "string" ? raw.documentId : "";
    if (!UUID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const mp = raw.markupPath;
    out.push({ documentId: id, markupPath: typeof mp === "string" && (!row.org_id || isValidMarkupPath(mp, row.org_id)) ? mp : null });
  }
  return out;
}

// ─── Reading a link ────────────────────────────────────────────────────────

export interface ShareRow {
  id: string;
  token: string;
  org_id: string;
  document_id: string;
  items: unknown;
  expires_at: string | null;
  revoked_at: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string | null;
  recipient: string | null;
  note: string | null;
  allow_download: boolean;
  code_hash: string | null;
  code_failures: number;
  access_count: number | null;
  access_last_at: string | null;
}

const LEGACY_COLS = "id, token, org_id, document_id, expires_at, revoked_at, created_by, created_by_name, created_at, note, access_count, access_last_at";
export const SHARE_COLS = `${LEGACY_COLS}, items, recipient, allow_download, code_hash, code_failures`;

/** Postgres or PostgREST saying a column (or the table's new shape) isn't
 *  there yet: the migration hasn't been run. */
export function isMissingShareColumn(e: { code?: string; message?: string } | null | undefined): boolean {
  if (!e) return false;
  if (e.code === "42703" || e.code === "PGRST204") return true;
  const m = (e.message ?? "").toLowerCase();
  return (m.includes("column") && m.includes("does not exist")) || (m.includes("could not find") && m.includes("column"));
}

/** A row from before the migration, read as the link it always was. */
export function withLegacyDefaults(r: Record<string, unknown>): ShareRow {
  return {
    ...(r as unknown as ShareRow),
    items: r.items ?? null,
    recipient: (r.recipient as string | null | undefined) ?? null,
    allow_download: r.allow_download === undefined || r.allow_download === null ? true : Boolean(r.allow_download),
    code_hash: (r.code_hash as string | null | undefined) ?? null,
    code_failures: Number(r.code_failures ?? 0) || 0,
  };
}

/** Find a link by its token. Before the migration it still reads (the old
 *  columns), so links already sent keep working. */
export async function loadShareByToken(sb: SupabaseClient, token: string): Promise<{ row: ShareRow | null; error?: string }> {
  const full = await sb.from("document_shares").select(SHARE_COLS).eq("token", token).maybeSingle();
  if (!full.error) return { row: full.data ? withLegacyDefaults(full.data as Record<string, unknown>) : null };
  if (!isMissingShareColumn(full.error)) return { row: null, error: full.error.message };
  const legacy = await sb.from("document_shares").select(LEGACY_COLS).eq("token", token).maybeSingle();
  if (legacy.error) return { row: null, error: legacy.error.message };
  return { row: legacy.data ? withLegacyDefaults(legacy.data as Record<string, unknown>) : null };
}

export type ShareStatus = "ok" | "revoked" | "expired" | "locked";

export function shareStatus(row: Pick<ShareRow, "revoked_at" | "expires_at" | "code_hash" | "code_failures">, now = Date.now()): ShareStatus {
  if (row.revoked_at) return "revoked";
  if (row.expires_at && new Date(row.expires_at).getTime() < now) return "expired";
  if (row.code_hash && (row.code_failures ?? 0) >= CODE_LOCK_AT) return "locked";
  return "ok";
}

/** Count one wrong code, safely when two guesses land at once (the update
 *  only applies to the count it read). Returns the count after this one. */
export async function registerCodeFailure(sb: SupabaseClient, row: Pick<ShareRow, "id" | "code_failures">): Promise<number> {
  let seen = row.code_failures ?? 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data, error } = await sb.from("document_shares")
      .update({ code_failures: seen + 1 })
      .eq("id", row.id).eq("code_failures", seen)
      .select("code_failures");
    if (!error && Array.isArray(data) && data.length > 0) return Number((data[0] as { code_failures: number }).code_failures);
    const { data: now } = await sb.from("document_shares").select("code_failures").eq("id", row.id).maybeSingle();
    seen = Number((now as { code_failures?: number } | null)?.code_failures ?? seen + 1);
    if (seen >= CODE_LOCK_AT) return seen;
  }
  return seen;
}

export type GateResult =
  | { ok: true }
  | { ok: false; status: number; error: "revoked" | "expired" | "locked" | "code" | "badcode" };

/** Everything a request must pass before it sees a document: the link is
 *  live, and when it asks for a code, the right code came with it. */
export async function gateShare(sb: SupabaseClient, row: ShareRow, code: string | null, now = Date.now()): Promise<GateResult> {
  const status = shareStatus(row, now);
  if (status === "revoked") return { ok: false, status: 410, error: "revoked" };
  if (status === "expired") return { ok: false, status: 410, error: "expired" };
  if (status === "locked") return { ok: false, status: 423, error: "locked" };
  if (!row.code_hash) return { ok: true };
  const given = (code ?? "").trim();
  if (!given) return { ok: false, status: 401, error: "code" };
  if (await verifyShareCode(given, row.token, row.code_hash)) return { ok: true };
  const failures = await registerCodeFailure(sb, row);
  if (failures >= CODE_LOCK_AT) return { ok: false, status: 423, error: "locked" };
  return { ok: false, status: 401, error: "badcode" };
}

// ─── The issued file ───────────────────────────────────────────────────────

export interface IssuedFile { path: string; versionId: string | null; fileType: string | null }

/** The current PUBLISHED version's file, never a draft in review. The
 *  version must belong to this document, and to the document's org when
 *  `org_id` is given (the service-role client bypasses RLS). */
export async function resolveIssuedFile(
  sb: SupabaseClient,
  doc: { id: string; org_id?: string | null; current_version_id?: string | null },
): Promise<IssuedFile | null> {
  const vid = doc.current_version_id ?? null;
  const orgId = typeof doc.org_id === "string" && doc.org_id ? doc.org_id : null;
  if (vid) {
    let byId = sb.from("document_versions").select("id, file_url, file_type").eq("id", vid).eq("record_id", doc.id);
    if (orgId) byId = byId.eq("org_id", orgId);
    const { data: v } = await byId.maybeSingle();
    const path = (v as { file_url?: string | null } | null)?.file_url ?? null;
    if (path) return { path, versionId: vid, fileType: (v as { file_type?: string | null }).file_type ?? null };
  }
  let latestQ = sb.from("document_versions")
    .select("id, file_url, file_type")
    .eq("record_id", doc.id);
  if (orgId) latestQ = latestQ.eq("org_id", orgId);
  const { data: latest } = await latestQ
    .or("review_state.is.null,review_state.eq.approved")
    .order("created_at", { ascending: false })
    .limit(1);
  const l = (latest as Array<{ id: string; file_url: string | null; file_type?: string | null }> | null)?.[0];
  return l?.file_url ? { path: l.file_url, versionId: l.id, fileType: l.file_type ?? null } : null;
}

/** What a stored file is, for stamping: a PDF, a picture (stamped as a
 *  one-page PDF), or anything else (which can't carry the stamp). */
export function fileKind(path: string, fileType?: string | null): "pdf" | "png" | "jpg" | "other" {
  const t = (fileType ?? "").toLowerCase();
  const ext = (path.split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (ext === "pdf" || t === "pdf" || t.includes("application/pdf")) return "pdf";
  if (ext === "png" || t === "png" || t.includes("image/png")) return "png";
  if (ext === "jpg" || ext === "jpeg" || t === "jpg" || t === "jpeg" || t.includes("image/jpeg")) return "jpg";
  return "other";
}

/** How a person names a document. */
export function docLabel(d: { document_number?: string | null; title?: string | null; name?: string | null } | null | undefined): string {
  return String(d?.document_number || d?.title || d?.name || "A document");
}
