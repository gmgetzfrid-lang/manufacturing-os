// lib/printSheetTokensServer.ts — the server's half of the per-print sheet
// token (public-surfaces PS-P9; intelligence DACL-8 criterion 2). Minting,
// hashing and the "table not there yet" test. Server only (node:crypto).
//
// The token printed in a sheet's QR is a 192-bit random bearer string; the
// database keeps only its SHA-256 (print_sheet_tokens.token_hash, 20261237),
// so a read of the table never yields a scannable QR.

import { createHash, randomBytes } from "node:crypto";
import { SHEET_TOKEN_RE } from "@/lib/printSheetTokens";

/** A fresh sheet token: 24 random bytes, base64url (32 characters). */
export function newSheetToken(): string {
  const t = randomBytes(24).toString("base64url");
  if (!SHEET_TOKEN_RE.test(t)) throw new Error("sheet token shape");
  return t;
}

/** The stored form of a token: lowercase hex SHA-256. */
export function hashSheetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 20261237 not pasted: the table is absent (42P01 / PGRST205, or the
 *  message says so). The print falls back to today's QR; a scan of a token
 *  reads "Unknown code" (none can exist without the table). */
export function isMissingSheetTokenTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /print_sheet_tokens/.test(error.message ?? "") && /does not exist|could not find|schema cache/i.test(error.message ?? "");
}

/** The SOFT per-member mint window: at most this many sheets minted by one
 *  member in the last SHEET_TOKEN_MINT_WINDOW_MS, checked by a read before
 *  the insert — not atomic, so concurrent mints by one member can exceed it
 *  (the integrator at the PS-P9 merge, DEC-90: soft by choice). A mint over
 *  it is refused (429) and that pack keeps today's QR — the print is never
 *  refused. Five maximum-size packs an hour; a field crew's normal packs stay
 *  far below. */
export const SHEET_TOKEN_MINT_WINDOW_MAX = 5000;
export const SHEET_TOKEN_MINT_WINDOW_MS = 60 * 60 * 1000;

/** Why a token's print was voided (the CHECK in 20261237; 'recalled' since
 *  20261240 — a controller's recall of a printed pack, public-surfaces
 *  PS-P10). */
export type SheetTokenVoidReason = "not_printed" | "print_aborted" | "recalled";

/** 20261240 not pasted: print_sheet_tokens has no cover_print_id column
 *  (42703 on a read naming it, PGRST204 on a write naming it, or the message
 *  says so). The settle then settles exactly as before, unlinked, and a
 *  recall answers "not available yet" without writing anything
 *  (public-surfaces PS-P10; DEC-90 ruling (2)). */
export function isMissingCoverLinkColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  return /cover_print_id/.test(error.message ?? "") && /does not exist|could not find|schema cache/i.test(error.message ?? "");
}

/** 20261240 not pasted, seen on the recall's void: the 20261237 void-reason
 *  CHECK (print_sheet_tokens_void_reason_known) has no 'recalled' and refuses
 *  the update (23514). The recall then answers "not available yet" — never
 *  "try again" (public-surfaces PS-P10, fifth review fix). */
export function isVoidReasonCheckRefusal(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error || error.code !== "23514") return false;
  return /void_reason/.test(error.message ?? "");
}

/** Who may recall a printed pack (void a settled print): a controller —
 *  Admin or Document Control — by the role COLLECTION (memberHoldsAny over
 *  the headline and the additive roles, never the headline alone; the
 *  integrator at the PS-P9 merge, DEC-90 ruling (3)). */
export const SHEET_PRINT_RECALL_ROLES: readonly string[] = ["Admin", "DocCtrl"];

/** A recall's reason: required (it is the audit row's why), at most this
 *  long. */
export const SHEET_PRINT_RECALL_REASON_MIN = 3;
export const SHEET_PRINT_RECALL_REASON_MAX = 500;

/** One sheet of a cover snapshot (work_package_prints.sheets) as printed:
 *  every entry whose `printed` is not false (a snapshot written before VFY-19
 *  has no `printed` key — every entry it holds was printed). Lowercased
 *  document id → lowercased version id (null when the snapshot has none).
 *  Pure. */
export function coverPrintedSheets(sheets: unknown): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!Array.isArray(sheets)) return out;
  for (const s of sheets as Array<Record<string, unknown>>) {
    if (!s || typeof s !== "object" || s.printed === false) continue;
    const documentId = typeof s.documentId === "string" ? s.documentId.toLowerCase() : "";
    if (!documentId) continue;
    out.set(documentId, typeof s.versionId === "string" ? s.versionId.toLowerCase() : null);
  }
  return out;
}
