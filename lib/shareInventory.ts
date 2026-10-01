// lib/shareInventory.ts — DIST-15: the org-wide inventory of external share
// links, for Admin → Share links.
//
// Every listing of share links used to be per document (the share modal, one
// selected document at a time), so "every public link outstanding on the
// unit's P&IDs" or "the links a contractor made before their seat was
// removed" had no in-app answer, and revoking them was one document at a
// time. The inventory is read by the server (/api/share/inventory, the
// controller tier by role COLLECTION — isControllerRole, never a literal) and
// carries no token: it lists who made which link to what, when it expires and
// how often it was opened, and whether its creator is still an active member.
// Revocation — one row or many — goes through revokeShareLink, the checked,
// audited revoke the share modal uses, so every revoked link writes its own
// SHARE_LINK_REVOKED row. A bulk revoke is that call per row, never a
// parallel UPDATE.
//
// No imports on purpose: the server route reads the types and constants, the
// page passes in its session token and revokeShareLink.

/** The one revoke this module calls — lib/documentShares.ts revokeShareLink's shape. */
export type RevokeShareLink = (id: string, actorUserId: string) => Promise<{ auditWarning: string | null }>;

export interface ShareInventoryRow {
  id: string;
  documentId: string;
  documentNumber: string | null;
  documentTitle: string | null;
  documentStatus: string | null;
  libraryId: string | null;
  libraryName: string | null;
  createdBy: string;
  createdByName: string | null;
  /** false when the creator is no longer an ACTIVE member of the org. */
  creatorActive: boolean;
  createdAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  accessCount: number;
  accessLastAt: string | null;
  note: string | null;
}

export interface ShareInventory {
  /** EVERY live link in the org, then the newest SHARE_INVENTORY_LIMIT expired or revoked ones. */
  rows: ShareInventoryRow[];
  /** true when there were more expired / revoked links than SHARE_INVENTORY_LIMIT. Never
   *  about live links: the server lists every one (or refuses past SHARE_INVENTORY_LIVE_CEILING),
   *  so the bulk scopes ("every live link by / on / in …") act on the whole set. */
  truncated: boolean;
}

/** The most EXPIRED or REVOKED rows one inventory read returns (newest first) —
 *  the record. Live links are never capped by it. */
export const SHARE_INVENTORY_LIMIT = 1000;

/** Past this many LIVE links the server refuses (500) rather than list a part:
 *  a partial live set would make "revoke every live link by X" a lie. */
export const SHARE_INVENTORY_LIVE_CEILING = 50_000;

/** Ids per `.in()` filter in the server's joins — the filter travels in the
 *  request URL (lib/acknowledgments.ts and lib/reviewControl.ts chunk at 150
 *  for the same reason). */
export const SHARE_INVENTORY_IN_CHUNK = 150;

/** Shown when the server refuses a member below the controller tier. */
export const SHARE_INVENTORY_DENIED =
  "Only Document Control or an Admin can see and revoke every share link in the organisation. Your own links are listed on each document's Share panel.";

export type ShareLinkState = "live" | "expired" | "revoked";

/** A link is live until it is revoked or its expiry has passed. */
export function shareLinkState(row: Pick<ShareInventoryRow, "revokedAt" | "expiresAt">, now: number = Date.now()): ShareLinkState {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && Date.parse(row.expiresAt) <= now) return "expired";
  return "live";
}

const STATE_ORDER: Record<ShareLinkState, number> = { live: 0, expired: 1, revoked: 2 };

/** Live links first, then expired, then revoked (kept for the record); newest first within each. */
export function sortShareInventory(rows: ShareInventoryRow[], now: number = Date.now()): ShareInventoryRow[] {
  return [...rows].sort((a, b) =>
    STATE_ORDER[shareLinkState(a, now)] - STATE_ORDER[shareLinkState(b, now)]
    || String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/** What a bulk revoke acts on. */
export type ShareBulkSelection =
  | { kind: "selected"; ids: string[] }
  | { kind: "creator"; createdBy: string }
  | { kind: "document"; documentId: string }
  | { kind: "library"; libraryId: string };

/** The LIVE links a selection names — a revoked or expired link is never revoked again. */
export function shareBulkTargets(rows: ShareInventoryRow[], sel: ShareBulkSelection, now: number = Date.now()): string[] {
  const live = rows.filter((r) => shareLinkState(r, now) === "live");
  switch (sel.kind) {
    case "selected": { const ids = new Set(sel.ids); return live.filter((r) => ids.has(r.id)).map((r) => r.id); }
    case "creator": return live.filter((r) => r.createdBy === sel.createdBy).map((r) => r.id);
    case "document": return live.filter((r) => r.documentId === sel.documentId).map((r) => r.id);
    case "library": return live.filter((r) => r.libraryId === sel.libraryId).map((r) => r.id);
  }
}

export interface ShareBulkRevokeResult {
  revoked: string[];
  failed: Array<{ id: string; reason: string }>;
  /** A link that was revoked but whose audit row was refused (revokeShareLink's auditWarning). */
  auditWarnings: string[];
}

/** Revoke each link through revokeShareLink — one checked, audited revoke per
 *  row, in order. A refusal is reported for its row and the rest continue;
 *  nothing reads as revoked that was not. */
export async function revokeShareLinks(
  ids: string[],
  actorUserId: string,
  revoke: RevokeShareLink,
): Promise<ShareBulkRevokeResult> {
  const out: ShareBulkRevokeResult = { revoked: [], failed: [], auditWarnings: [] };
  for (const id of ids) {
    try {
      const { auditWarning } = await revoke(id, actorUserId);
      out.revoked.push(id);
      if (auditWarning) out.auditWarnings.push(auditWarning);
    } catch (e) {
      out.failed.push({ id, reason: (e as Error)?.message || String(e) });
    }
  }
  return out;
}

/** Read the org's inventory from the server. Throws with the server's reason
 *  (the controller-tier refusal included) — an unread inventory never renders
 *  as "no links". */
export async function loadShareInventory(orgId: string, accessToken: string | null | undefined): Promise<ShareInventory> {
  if (!accessToken) throw new Error("Not authenticated");
  const res = await fetch(`/api/share/inventory?orgId=${encodeURIComponent(orgId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const out = (await res.json().catch(() => ({}))) as { rows?: ShareInventoryRow[]; truncated?: boolean; error?: string };
  if (!res.ok) throw new Error(out.error || `Couldn't load the share links (HTTP ${res.status}).`);
  return { rows: out.rows ?? [], truncated: out.truncated === true };
}
