// lib/ticketFileHash.ts
//
// drafting-flow EVID-12 (fleet F7, DEC-90 option (b)): a ticket file is
// fingerprinted ONCE, server-side, when it is attached — the workflow route's
// attach step (app/api/tickets/workflow-action/route.ts vetTicketAttachment's
// callers) reads the stored bytes and records their sha256 on the attachment
// entry, so a later approval's OWN audit row can carry that hash without
// reading storage before it answers.
//
// What the stored hash is bound to, and why it is sealed:
//   * the bytes — a storage key under orgs/<org>/tickets/<n>/ CAN be written
//     again after the attach (app/api/storage/upload-url signs a PUT for any
//     key of the caller's workspace that is not a published document
//     version, and a signed PUT stays usable for 15 minutes). So the entry
//     records what was hashed — the byte count read and the storage ETag of
//     the GetObject that served those bytes (when: the entry's own
//     server-stamped uploadedAt, the same request). The approval's row
//     carries the hash WITH that binding ("hashed at attach"); the approval's
//     after-the-response follow-up row (TICKET_<ACTION>_FILES_HASHED, kept)
//     reads the bytes again and says whether they still match
//     (`matchesStoredHash`), so a replaced file is visible as stale.
//   * the entry — `tickets.attachments` is written by a browser client until
//     20261166's ticket_update_guard is pasted. An entry's hash is believed
//     only under an HMAC seal the route computes over (org, ticket row,
//     storage key, sha256, bytes, etag) — a hash a client wrote, or one
//     moved onto another ticket or key, does not verify and is never carried
//     as "server-computed" (the approval then names the file as before and
//     the follow-up row hashes it, today's path).
//
// Bookkeeping (class b): nothing here can refuse or fail an attach. A file not
// hashed within the bound (HASH_LIMITS.attachDeadlineMs / attachByteBudget),
// or that storage cannot serve, gets no stored hash; the attach lands exactly
// as before and the attaching action's audit row says why (sha256Unavailable).

import { createHmac, timingSafeEqual } from "node:crypto";
import { hashStoredFilesBounded, type FileHash } from "@/lib/ticketRoster";
import type { TicketAttachment } from "@/types/schema";

/** What the attach step stores on an attachment entry (`contentHash`). */
export interface StoredContentHash {
  sha256: string;
  /** bytes read and hashed */
  bytes: number;
  /** the storage ETag of the GetObject that served those bytes (quotes
   *  stripped), null when storage sent none */
  etag: string | null;
  /** HMAC over the fields above, the org, the ticket row and the key */
  seal: string;
}

/** Where a sealed hash belongs: the ticket's org and row id. */
export interface HashSealContext {
  orgId: string;
  ticketRowId: string;
}

const LABEL = "manufacturing-os:ticket-file-hash:v1:";

function sealKey(): string | null {
  const s = (process.env.TICKET_FILE_HASH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  return s || null;
}

function sealOf(ctx: HashSealContext, url: string, h: Omit<StoredContentHash, "seal">): string | null {
  const key = sealKey();
  if (!key || !ctx.orgId || !ctx.ticketRowId || !url) return null;
  return createHmac("sha256", key)
    .update(`${LABEL}${ctx.orgId}\n${ctx.ticketRowId}\n${url}\n${h.sha256}\n${h.bytes}\n${h.etag ?? ""}`, "utf8")
    .digest("base64url");
}

/** A sealed StoredContentHash for `url` on this ticket, or null when no
 *  sealing key is configured (nothing is stored unsealed). */
export function sealContentHash(ctx: HashSealContext, url: string, h: Omit<StoredContentHash, "seal">): StoredContentHash | null {
  const seal = sealOf(ctx, url, h);
  return seal ? { sha256: h.sha256, bytes: h.bytes, etag: h.etag, seal } : null;
}

/** The attachment's stored hash when it is one the route sealed for THIS
 *  ticket and THIS storage key; null otherwise (none stored, a legacy entry,
 *  a client-written or moved one). Constant-time comparison. Pure. */
export function verifiedStoredHash(a: Pick<TicketAttachment, "url" | "contentHash"> | null | undefined, ctx: HashSealContext): StoredContentHash | null {
  const c = a?.contentHash as Partial<StoredContentHash> | null | undefined;
  if (!a?.url || !c || typeof c !== "object") return null;
  if (typeof c.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(c.sha256)) return null;
  if (typeof c.bytes !== "number" || !Number.isFinite(c.bytes) || c.bytes < 0) return null;
  if (!(c.etag === null || typeof c.etag === "string") || typeof c.seal !== "string") return null;
  const want = sealOf(ctx, a.url, { sha256: c.sha256, bytes: c.bytes, etag: c.etag });
  if (!want) return null;
  const x = Buffer.from(want, "utf8");
  const y = Buffer.from(c.seal, "utf8");
  if (x.length !== y.length || !timingSafeEqual(x, y)) return null;
  return { sha256: c.sha256, bytes: c.bytes, etag: c.etag, seal: c.seal };
}

/** What an audit row says of a stored hash: the sha256 and what it is bound
 *  to (never the seal). */
export function storedHashFields(s: StoredContentHash | null): Record<string, unknown> {
  return s ? { sha256: s.sha256, sha256AtAttach: { bytes: s.bytes, etag: s.etag } } : {};
}

/** The minimum of an S3-style GetObject answer read here. */
interface StoredObject {
  ContentLength?: number;
  ETag?: unknown;
  Body?: unknown;
}

export type AttachHash =
  | { ok: true; hash: StoredContentHash }
  | { ok: false; reason: string };

/**
 * Hash the files an action attaches, under ONE deadline and ONE byte budget
 * (lib/ticketRoster.ts hashStoredFilesBounded — the GetObject is aborted at
 * the clock). `vettedEtags` maps a key to the ETag the vetting HEAD read: when
 * both are known and differ, the bytes changed between the check and the
 * read, and no hash is stored ("the stored file changed while it was being
 * attached"). Never throws; every key gets an answer.
 */
export async function hashFilesAtAttach(
  keys: ReadonlyArray<string>,
  get: (key: string, signal?: AbortSignal) => Promise<StoredObject>,
  limits: { deadlineMs: number; byteBudget: number },
  ctx: HashSealContext,
  vettedEtags: ReadonlyMap<string, string | null> = new Map(),
): Promise<Map<string, AttachHash>> {
  const out = new Map<string, AttachHash>();
  const unique = [...new Set(keys.filter(Boolean))];
  if (unique.length === 0) return out;
  const servedEtag = new Map<string, string | null>();
  let hashes: Map<string, FileHash>;
  try {
    hashes = await hashStoredFilesBounded(unique, async (k, signal) => {
      const o = await get(k, signal);
      servedEtag.set(k, typeof o?.ETag === "string" ? o.ETag.replace(/"/g, "") : null);
      return o as never;
    }, limits);
  } catch (e) {
    const reason = `not hashed (${(e as Error)?.message ?? "error"})`;
    for (const k of unique) out.set(k, { ok: false, reason });
    return out;
  }
  for (const k of unique) {
    const h = hashes.get(k);
    if (!h) { out.set(k, { ok: false, reason: "not hashed" }); continue; }
    if (!h.ok) { out.set(k, { ok: false, reason: h.reason }); continue; }
    const etag = servedEtag.get(k) ?? null;
    const vetted = vettedEtags.get(k) ?? null;
    if (etag && vetted && etag !== vetted) { out.set(k, { ok: false, reason: "the stored file changed while it was being attached" }); continue; }
    const sealed = sealContentHash(ctx, k, { sha256: h.sha256, bytes: h.bytes ?? 0, etag });
    out.set(k, sealed ? { ok: true, hash: sealed } : { ok: false, reason: "no sealing key configured" });
  }
  return out;
}
