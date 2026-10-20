// lib/printSheetTokens.ts — the per-print sheet token (public-surfaces PS-P9;
// intelligence DACL-8 criterion 2, rulings under DEC-90).
//
// A printed field pack's sheet QR names its sheet by a per-print token the
// SERVER mints at print time (POST /api/print-sheet-tokens), not by the
// document's durable UUID: `<origin>/verify/<token>`. The public /api/verify
// resolves the token to (document, version, print) and answers current /
// stale / superseded for THAT print; a token whose print was voided (the
// pack never left, or the sheet did not make it into the PDF) reads stale.
//
// This module is the token's SHAPE, shared by the browser's half
// (lib/printSheetTokensClient.ts), the server's half
// (lib/printSheetTokensServer.ts) and the scan page. Pure.

/** A sheet token: 32 base64url characters (24 random bytes, 192 bits) —
 *  never UUID-shaped, so a scan landing on /verify/<x> tells a token from a
 *  document id by its shape alone. */
export const SHEET_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function isSheetToken(s: string | null | undefined): s is string {
  return typeof s === "string" && SHEET_TOKEN_RE.test(s);
}

/** The QR target of a token-named sheet. */
export function sheetTokenVerifyUrl(origin: string, token: string): string {
  return `${origin}/verify/${token}`;
}

/** At most this many sheets are minted in one call (a bigger pack keeps
 *  today's QR on every sheet — never a refused print). */
export const SHEET_TOKEN_MINT_MAX = 1000;

/** The /api/verify query for a scan of /verify/<segment>[?v=]: a per-print
 *  sheet token is sent as `t` alone; anything else is the document id, with
 *  `v` when the QR names the printed version — exactly as before PS-P9. */
export function verifyQueryFor(segment: string, versionId: string | null): URLSearchParams {
  if (isSheetToken(segment)) return new URLSearchParams({ t: segment });
  const qs = new URLSearchParams({ doc: segment });
  if (versionId) qs.set("v", versionId);
  return qs;
}
