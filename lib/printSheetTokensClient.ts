// lib/printSheetTokensClient.ts — the browser's half of the per-print sheet
// token (public-surfaces PS-P9; intelligence DACL-8 criterion 2).
//
// It FAILS SAFE to today's QR: when the tokens cannot be minted — the table
// is not there yet (20261237 not pasted: 42P01 / PGRST205), no session, a
// network error, any refusal — the print stamps every sheet exactly as it
// did before (`/verify/<document>?v=<version>`) and nothing breaks (DEC-90
// ruling (4)). Every QR printed before this package keeps being answered
// exactly as today (ruling (2)).

import { supabase } from "@/lib/supabase";
import { isSheetToken, SHEET_TOKEN_MINT_MAX } from "@/lib/printSheetTokens";

export interface MintedSheetTokens {
  printId: string;
  /** document id → token, for each sheet the server minted. A sheet missing
   *  here is stamped with today's QR. */
  tokens: Map<string, string>;
}

async function bearer(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** Ask the server for one token per sheet about to be stamped. Never throws:
 *  null means "stamp today's QR" (said once in the console, not to the
 *  printer — the print itself is unaffected). */
export async function mintSheetTokens(input: {
  orgId: string;
  sheets: Array<{ documentId: string; versionId: string }>;
}): Promise<MintedSheetTokens | null> {
  if (input.sheets.length === 0 || input.sheets.length > SHEET_TOKEN_MINT_MAX) return null;
  try {
    const token = await bearer();
    if (!token) return null;
    const res = await fetch("/api/print-sheet-tokens", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "mint", orgId: input.orgId, sheets: input.sheets }),
    });
    const body = (await res.json().catch(() => null)) as
      | { available?: boolean; printId?: string; tokens?: Record<string, string>; error?: string }
      | null;
    if (!res.ok || !body || body.available !== true || typeof body.printId !== "string" || !body.tokens) {
      if (body?.available === false) {
        console.info("[print-sheet-tokens] not available yet (20261237 not pasted) — this pack's sheets carry today's QR");
      } else {
        console.warn("[print-sheet-tokens] not minted — this pack's sheets carry today's QR:", body?.error ?? res.status);
      }
      return null;
    }
    const tokens = new Map<string, string>();
    for (const [documentId, t] of Object.entries(body.tokens)) if (isSheetToken(t)) tokens.set(documentId, t);
    return { printId: body.printId, tokens };
  } catch (e) {
    console.warn("[print-sheet-tokens] not minted — this pack's sheets carry today's QR:", (e as Error)?.message);
    return null;
  }
}

/** Tell the server which sheets left in the PDF: every other token of the
 *  print is voided ('not_printed'); an EMPTY list voids the whole print
 *  ('print_aborted' — nothing was downloaded). Never throws: an unsettled
 *  print keeps every token live, which is what a downloaded pack needs. */
export async function settleSheetTokens(input: {
  orgId: string;
  printId: string;
  printedDocumentIds: string[];
}): Promise<boolean> {
  try {
    const token = await bearer();
    if (!token) return false;
    const res = await fetch("/api/print-sheet-tokens", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "settle", orgId: input.orgId, printId: input.printId, printed: input.printedDocumentIds }),
    });
    if (!res.ok) {
      console.warn("[print-sheet-tokens] print not settled:", res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[print-sheet-tokens] print not settled:", (e as Error)?.message);
    return false;
  }
}
