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

/** How long a mint or a settle may take before the print stops waiting for
 *  it. A mint that times out stamps today's QR (the print is never held on
 *  the token route — a cold start, a slow read or a stalled field network
 *  costs the print at most this long); a settle that times out leaves the
 *  print unsettled, which keeps every token live. */
export const SHEET_TOKEN_FETCH_TIMEOUT_MS = 8000;

/** POST to the token route under a timeout that covers the response body
 *  too. Throws on a network error or the timeout (the callers catch). */
async function postTokenRoute(token: string, payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: unknown }> {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), SHEET_TOKEN_FETCH_TIMEOUT_MS) : null;
  try {
    const res = await fetch("/api/print-sheet-tokens", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    if (ctl?.signal.aborted) throw new Error("timed out");
    const body = await Promise.race([
      res.json().catch(() => null),
      new Promise<null>((_, reject) => ctl?.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true })),
    ]);
    return { ok: res.ok, status: res.status, body };
  } finally {
    if (timer) clearTimeout(timer);
  }
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
 *  printer — the print itself is unaffected; an empty mint — no eligible
 *  sheet — is null too, silently, and nothing is settled). */
export async function mintSheetTokens(input: {
  orgId: string;
  sheets: Array<{ documentId: string; versionId: string }>;
}): Promise<MintedSheetTokens | null> {
  if (input.sheets.length === 0 || input.sheets.length > SHEET_TOKEN_MINT_MAX) return null;
  try {
    const token = await bearer();
    if (!token) return null;
    const res = await postTokenRoute(token, { action: "mint", orgId: input.orgId, sheets: input.sheets });
    const body = res.body as
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
    for (const [documentId, t] of Object.entries(body.tokens)) if (isSheetToken(t)) tokens.set(documentId.toLowerCase(), t);
    // An empty mint (no sheet eligible — none the caller's session may read
    // here, or no version belonging to its document): nothing to settle, so
    // null — every sheet carries today's QR, no settle request, no warning
    // (the integrator at the PS-P9 merge, DEC-90).
    if (tokens.size === 0) return null;
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
    const res = await postTokenRoute(token, { action: "settle", orgId: input.orgId, printId: input.printId, printed: input.printedDocumentIds });
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

/** What linking a token print to its cover's print came to (public-surfaces
 *  PS-P10; PHYS-19 c3). `linked: false` with ok — database update 20261240
 *  is not pasted yet: the pack prints as today, unlinked. `refused` — the
 *  server's own cover-mismatch refusal (a 400 carrying `refused: true, code:
 *  "cover_mismatch"`), the only answer that stops the print; any other
 *  failure, a bare 400 included (a malformed body, an older route's
 *  "Unknown action"), is not a refusal. */
export type SheetTokenCoverLinkResult =
  | { ok: true; linked: boolean }
  | { ok: false; refused: boolean; status: number; error: string };

/** Link a work-package pack's token print to the work_package_prints id of
 *  the cover printed with it, by key (the server checks the cover: same
 *  workspace, printed by this member, listing exactly `printedDocumentIds` at
 *  the minted versions). Called by the pack path BEFORE the download and
 *  awaited — the marked cover_mismatch refusal stops the print; any other
 *  failure, after one retry, lets the pack print unlinked (lib/docPack.ts).
 *  Never throws. */
export async function linkSheetTokensToCover(input: {
  orgId: string;
  printId: string;
  coverPrintId: string;
  printedDocumentIds: string[];
}): Promise<SheetTokenCoverLinkResult> {
  try {
    const token = await bearer();
    if (!token) return { ok: false, refused: false, status: 401, error: "You are signed out — sign in and try again." };
    const res = await postTokenRoute(token, {
      action: "link", orgId: input.orgId, printId: input.printId, coverPrintId: input.coverPrintId, printed: input.printedDocumentIds,
    });
    const body = res.body as { linked?: boolean; available?: boolean; refused?: boolean; code?: string; error?: string } | null;
    if (res.ok && body?.linked === true) return { ok: true, linked: true };
    if (res.ok && body?.available === false) return { ok: true, linked: false };
    const refused = res.status === 400 && body?.refused === true && body?.code === "cover_mismatch";
    return { ok: false, refused, status: res.status, error: body?.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, refused: false, status: 0, error: (e as Error)?.message || "network" };
  }
}

/** What a controller's recall of a printed pack came to (public-surfaces
 *  PS-P10; intelligence DACL-8 residual (c)). */
export type SheetPrintRecallResult =
  | { ok: true; voided: number; alreadyVoid: number }
  | { ok: false; unavailable: boolean; status: number; error: string };

/** Recall a printed work-package pack by its cover's print id: every live
 *  sheet token of that print is voided ('recalled'), so each of its sheets
 *  scans "PRINT CANCELLED — DO NOT USE" (red, never green). Admin / Document
 *  Control only (the server checks the role collection); the reason is
 *  required and is written to the audit row first. Never throws. */
export async function recallSheetPrint(input: {
  orgId: string;
  coverPrintId: string;
  reason: string;
}): Promise<SheetPrintRecallResult> {
  try {
    const token = await bearer();
    if (!token) return { ok: false, unavailable: false, status: 401, error: "You are signed out — sign in and try again." };
    const res = await postTokenRoute(token, { action: "void", orgId: input.orgId, coverPrintId: input.coverPrintId, reason: input.reason });
    const body = res.body as { recalled?: boolean; voided?: number; alreadyVoid?: number; available?: boolean; error?: string } | null;
    if (res.ok && body?.recalled === true) return { ok: true, voided: body.voided ?? 0, alreadyVoid: body.alreadyVoid ?? 0 };
    return {
      ok: false,
      unavailable: body?.available === false,
      status: res.status,
      error: body?.error ?? `The recall was not recorded (HTTP ${res.status}) — nothing was changed.`,
    };
  } catch (e) {
    return { ok: false, unavailable: false, status: 0, error: `The recall could not be sent (${(e as Error)?.message || "network"}) — nothing was changed.` };
  }
}
