// POST /api/print-sheet-tokens — the per-print sheet token's only writer
// (public-surfaces PS-P9; intelligence DACL-8 criterion 2, rulings under
// DEC-90). print_sheet_tokens (20261237) is service-role only: no client can
// read or write it, so the token a sheet's QR carries is minted HERE, after
// the caller's session and membership are checked.
//
//   { action: "mint", orgId, sheets: [{ documentId, versionId }] }
//     → { available: true, printId, tokens: { <documentId>: <token> } }
//     One token per sheet the caller is about to stamp. A sheet is minted
//     only when the caller's OWN session can read its document in that
//     workspace (the read runs as the caller — RLS judges it, as the print
//     path's own read did) and the version belongs to that document; any
//     other sheet is simply not in `tokens` and keeps today's QR. Only the
//     token's SHA-256 is stored.
//     Before 20261237 is pasted (42P01 / PGRST205): { available: false } —
//     the print stamps today's QR on every sheet; nothing breaks.
//
//   { action: "settle", orgId, printId, printed: [documentId…] }
//     → { settled: true, voided: n }
//     After the download: every token of the print whose sheet is NOT in
//     `printed` is voided ('not_printed' — that paper never left); an EMPTY
//     `printed` voids the whole print ('print_aborted' — nothing was
//     downloaded). Only the member who minted the print, only once (a
//     settled print is final — the 20261237 guard refuses a change too).
//     A voided token's scan reads stale, never green.
//
// Any active member of the workspace may print a pack (the pack builder has
// no role gate), so any active member may mint (authorizeOrgRole over every
// role — the additive collection, never the headline alone). One member may
// mint at most SHEET_TOKEN_MINT_WINDOW_MAX sheets an hour (counted from the
// table on (minted_by, minted_at)); over it the mint answers 429 and the pack
// keeps today's QR.

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { authorizeOrgRole, callerScopedClient } from "@/lib/serverAuth";
import { ALL_ROLES } from "@/types/schema";
import { SHEET_TOKEN_MINT_MAX } from "@/lib/printSheetTokens";
import {
  hashSheetToken,
  isMissingSheetTokenTable,
  newSheetToken,
  SHEET_TOKEN_MINT_WINDOW_MAX,
  SHEET_TOKEN_MINT_WINDOW_MS,
  type SheetTokenVoidReason,
} from "@/lib/printSheetTokensServer";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 100;

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "Invalid request" }, 400);
  const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  const actor = await authorizeOrgRole(req, orgId, [...ALL_ROLES]);
  if ("error" in actor) return json({ error: actor.error }, actor.status);

  if (body.action === "mint") {
    const raw = Array.isArray(body.sheets) ? body.sheets : null;
    if (!raw || raw.length === 0 || raw.length > SHEET_TOKEN_MINT_MAX) return json({ error: "Invalid sheets" }, 400);
    const seen = new Set<string>();
    const sheets: Array<{ documentId: string; versionId: string }> = [];
    for (const s of raw as Array<Record<string, unknown>>) {
      const documentId = typeof s?.documentId === "string" ? s.documentId.toLowerCase() : "";
      const versionId = typeof s?.versionId === "string" ? s.versionId.toLowerCase() : "";
      if (!UUID_RE.test(documentId) || !UUID_RE.test(versionId)) return json({ error: "Invalid sheets" }, 400);
      if (seen.has(documentId)) continue;
      seen.add(documentId);
      sheets.push({ documentId, versionId });
    }

    // The caller's own session decides which documents they may print here.
    const caller = callerScopedClient(req);
    if ("error" in caller) return json({ error: caller.error }, caller.status);
    const readable = new Set<string>();
    for (const ids of chunks(sheets.map((s) => s.documentId))) {
      const { data, error } = await caller.from("documents").select("id, org_id").in("id", ids);
      if (error) return json({ error: "Couldn't check the sheets — try again" }, 503);
      for (const d of (data as Array<{ id: string; org_id: string | null }> | null) ?? []) {
        if (d.org_id === orgId) readable.add(String(d.id).toLowerCase());
      }
    }
    const versionOf = new Map<string, string>();
    for (const ids of chunks(sheets.map((s) => s.versionId))) {
      const { data, error } = await actor.admin.from("document_versions").select("id, record_id").in("id", ids);
      if (error) return json({ error: "Couldn't check the sheets — try again" }, 503);
      for (const v of (data as Array<{ id: string; record_id: string | null }> | null) ?? []) {
        versionOf.set(String(v.id).toLowerCase(), String(v.record_id ?? "").toLowerCase());
      }
    }
    const eligible = sheets.filter((s) => readable.has(s.documentId) && versionOf.get(s.versionId) === s.documentId);

    const printId = randomUUID();
    const tokens: Record<string, string> = {};
    if (eligible.length === 0) return json({ available: true, printId, tokens });

    // The per-member window: a member's mints in the last hour, plus this
    // one, stay under the cap — or this pack keeps today's QR.
    const since = new Date(Date.now() - SHEET_TOKEN_MINT_WINDOW_MS).toISOString();
    const { count: recent, error: windowErr } = await actor.admin
      .from("print_sheet_tokens")
      .select("id", { count: "exact" })
      .eq("minted_by", actor.userId)
      .gte("minted_at", since)
      .limit(1);
    if (windowErr) {
      if (isMissingSheetTokenTable(windowErr)) return json({ available: false });
      console.error("[print-sheet-tokens] mint window unreadable — the pack keeps today's QR:", windowErr.message);
      return json({ error: "Couldn't mint the sheet tokens" }, 503);
    }
    if ((recent ?? 0) + eligible.length > SHEET_TOKEN_MINT_WINDOW_MAX) {
      return json({ error: "Too many sheets minted in the last hour — this pack keeps today's QR" }, 429);
    }

    const rows = eligible.map((s) => {
      const token = newSheetToken();
      tokens[s.documentId] = token;
      return {
        token_hash: hashSheetToken(token),
        print_id: printId,
        org_id: orgId,
        document_id: s.documentId,
        version_id: s.versionId,
        minted_by: actor.userId,
      };
    });
    const { error } = await actor.admin.from("print_sheet_tokens").insert(rows);
    if (error) {
      if (isMissingSheetTokenTable(error)) return json({ available: false });
      console.error("[print-sheet-tokens] mint refused — the pack keeps today's QR:", error.message);
      return json({ error: "Couldn't mint the sheet tokens" }, 503);
    }
    return json({ available: true, printId, tokens });
  }

  if (body.action === "settle") {
    const printId = typeof body.printId === "string" ? body.printId.toLowerCase() : "";
    if (!UUID_RE.test(printId) || !Array.isArray(body.printed)) return json({ error: "Invalid request" }, 400);
    const printed = new Set(
      (body.printed as unknown[]).filter((x): x is string => typeof x === "string" && UUID_RE.test(x)).map((x) => x.toLowerCase()),
    );
    const { data, error } = await actor.admin
      .from("print_sheet_tokens")
      .select("id, document_id")
      .eq("print_id", printId)
      .eq("org_id", orgId)
      .eq("minted_by", actor.userId)
      .is("settled_at", null);
    if (error) {
      if (isMissingSheetTokenTable(error)) return json({ available: false, settled: false });
      return json({ error: "Couldn't settle the print — try again" }, 503);
    }
    const rows = (data as Array<{ id: string; document_id: string }> | null) ?? [];
    if (rows.length === 0) return json({ error: "Unknown or already settled print" }, 404);

    const now = new Date().toISOString();
    const reason: SheetTokenVoidReason = printed.size === 0 ? "print_aborted" : "not_printed";
    const voidIds = rows.filter((r) => !printed.has(String(r.document_id).toLowerCase())).map((r) => r.id);
    let voided = 0;
    for (const ids of chunks(voidIds)) {
      const { data: hit, error: vErr } = await actor.admin
        .from("print_sheet_tokens")
        .update({ voided_at: now, void_reason: reason, settled_at: now })
        .in("id", ids)
        .is("settled_at", null)
        .select("id");
      if (vErr) return json({ error: "Couldn't settle the print — try again" }, 503);
      voided += (hit as unknown[] | null)?.length ?? 0;
    }
    if (voided !== voidIds.length) return json({ error: "The print changed while it was settled — try again" }, 409);
    const keep = rows.length - voidIds.length;
    if (keep > 0) {
      const { data: hit, error: sErr } = await actor.admin
        .from("print_sheet_tokens")
        .update({ settled_at: now })
        .eq("print_id", printId)
        .eq("org_id", orgId)
        .eq("minted_by", actor.userId)
        .is("settled_at", null)
        .select("id");
      if (sErr) return json({ error: "Couldn't settle the print — try again" }, 503);
      if (((hit as unknown[] | null)?.length ?? 0) !== keep) return json({ error: "The print changed while it was settled — try again" }, 409);
    }
    return json({ settled: true, voided });
  }

  return json({ error: "Unknown action" }, 400);
}
