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

/** Why a token's print was voided (the CHECK in 20261237). */
export type SheetTokenVoidReason = "not_printed" | "print_aborted";
