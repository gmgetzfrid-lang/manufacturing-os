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
//     PS-P10 (PHYS-19 c3): a work-package pack's settle also carries
//     `coverPrintId`, the work_package_prints id of the cover printed with it
//     (the cover is recorded AFTER the sheets are stamped — PKG-6 — so the
//     mint cannot carry it; the settle is the first moment it exists). The
//     server checks it — same workspace, printed by the caller, its printed
//     sheets exactly this settle's `printed` sheets at the versions the
//     tokens were minted for, recorded after the mint, linked to no other
//     print — and stores it on every token row of the print
//     (print_sheet_tokens.cover_print_id, 20261240). A mismatched id is
//     refused 400 and NOTHING is settled (the tokens stay live — what an
//     unsettled print always means). Before 20261240 is pasted (42703 /
//     PGRST204) the id is ignored and the print settles exactly as today.
//     A pack without a cover (the asset hub's, the two "Print all" packs)
//     sends none: its token print keeps its own id and a NULL link.
//
//   { action: "void", orgId, coverPrintId | printId, reason }
//     → { recalled: true, voided: n, alreadyVoid: m }
//     PS-P10 (intelligence DACL-8 residual (c)): a controller — Admin or
//     Document Control by the role collection — recalls a printed pack: every
//     live token of that print (by the cover's work_package_prints id, or by
//     the token print id) is voided 'recalled', settled or not (the 20261237
//     guard allows a void after a settle; a void stays one-way). The audit
//     row (DISTRIBUTION_RECALL, with the reason) is written FIRST — nothing is
//     voided without it — and a short void writes a second row saying so.
//     A recalled sheet's scan reads print_voided: red, never green. A
//     non-controller is refused 403 before anything is read. Before 20261240
//     is pasted: { available: false } and nothing is written.
//
// Any active member of the workspace may print a pack (the pack builder has
// no role gate), so any active member may mint (authorizeOrgRole over every
// role — the additive collection, never the headline alone). A SOFT
// per-member window: a mint that would take one member past
// SHEET_TOKEN_MINT_WINDOW_MAX sheets in the last hour (counted from the table
// on (minted_by, minted_at)) answers 429 and the pack keeps today's QR. It is
// a read-then-insert, not atomic: concurrent mints by one member can each
// pass the check and together exceed it (the integrator at the PS-P9 merge,
// DEC-90 — soft by choice: it bounds an ordinary member's rate, it is not a
// quota, and an overrun only adds rows that grant nothing).

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { authorizeOrgRole, callerScopedClient, type AuthorizedActor } from "@/lib/serverAuth";
import { ALL_ROLES } from "@/types/schema";
import { memberHoldsAny } from "@/lib/roleHeld";
import { SHEET_TOKEN_MINT_MAX } from "@/lib/printSheetTokens";
import {
  coverPrintedSheets,
  hashSheetToken,
  isMissingCoverLinkColumn,
  isMissingSheetTokenTable,
  newSheetToken,
  SHEET_PRINT_RECALL_REASON_MAX,
  SHEET_PRINT_RECALL_REASON_MIN,
  SHEET_PRINT_RECALL_ROLES,
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

    // The soft per-member window: a member's mints in the last hour, plus
    // this one, stay under the cap — or this pack keeps today's QR. Not
    // atomic (read, then insert): concurrent requests can exceed it.
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
    // PS-P10: the cover's print id, when the pack has a cover.
    const coverRequested = body.coverPrintId !== undefined && body.coverPrintId !== null;
    if (coverRequested && (typeof body.coverPrintId !== "string" || !UUID_RE.test(body.coverPrintId))) {
      return json({ error: "Invalid request" }, 400);
    }
    let coverPrintId = coverRequested ? String(body.coverPrintId).toLowerCase() : null;
    const printed = new Set(
      (body.printed as unknown[]).filter((x): x is string => typeof x === "string" && UUID_RE.test(x)).map((x) => x.toLowerCase()),
    );
    const { data, error } = await actor.admin
      .from("print_sheet_tokens")
      .select("id, document_id, version_id, minted_at")
      .eq("print_id", printId)
      .eq("org_id", orgId)
      .eq("minted_by", actor.userId)
      .is("settled_at", null);
    if (error) {
      if (isMissingSheetTokenTable(error)) return json({ available: false, settled: false });
      return json({ error: "Couldn't settle the print — try again" }, 503);
    }
    const rows = (data as Array<{ id: string; document_id: string; version_id?: string | null; minted_at?: string | null }> | null) ?? [];
    if (rows.length === 0) return json({ error: "Unknown or already settled print" }, 404);

    // PS-P10: check the cover before anything is written. A mismatch is a
    // 400 and nothing is settled; before 20261240 the link is skipped.
    if (coverPrintId) {
      const link = await checkCoverLink(actor, { orgId, printId, coverPrintId, rows, printed });
      if (link.outcome === "refused") return json({ error: link.error }, 400);
      if (link.outcome === "error") return json({ error: "Couldn't settle the print — try again" }, 503);
      if (link.outcome === "unavailable") coverPrintId = null;
    }
    const linkPatch = coverPrintId ? { cover_print_id: coverPrintId } : {};

    const now = new Date().toISOString();
    const reason: SheetTokenVoidReason = printed.size === 0 ? "print_aborted" : "not_printed";
    const voidIds = rows.filter((r) => !printed.has(String(r.document_id).toLowerCase())).map((r) => r.id);
    let voided = 0;
    for (const ids of chunks(voidIds)) {
      const { data: hit, error: vErr } = await actor.admin
        .from("print_sheet_tokens")
        .update({ voided_at: now, void_reason: reason, settled_at: now, ...linkPatch })
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
        .update({ settled_at: now, ...linkPatch })
        .eq("print_id", printId)
        .eq("org_id", orgId)
        .eq("minted_by", actor.userId)
        .is("settled_at", null)
        .select("id");
      if (sErr) return json({ error: "Couldn't settle the print — try again" }, 503);
      if (((hit as unknown[] | null)?.length ?? 0) !== keep) return json({ error: "The print changed while it was settled — try again" }, 409);
    }
    return json({ settled: true, voided, ...(coverRequested ? { coverLinked: !!coverPrintId } : {}) });
  }

  if (body.action === "void") return recallPrint(actor, orgId, body);

  return json({ error: "Unknown action" }, 400);
}

/** PS-P10 (PHYS-19 c3): may this settle's print be linked to that cover?
 *  `unavailable` — 20261240 not pasted (the link column is missing): settle
 *  as today, unlinked. `refused` — the cover is not this print's: 400,
 *  nothing settled. Read-only. */
async function checkCoverLink(
  actor: AuthorizedActor,
  input: {
    orgId: string; printId: string; coverPrintId: string;
    rows: Array<{ document_id: string; version_id?: string | null; minted_at?: string | null }>;
    printed: Set<string>;
  },
): Promise<{ outcome: "ok" | "unavailable" | "error" } | { outcome: "refused"; error: string }> {
  const refused = (error: string) => ({ outcome: "refused" as const, error });
  // The probe: is the column there, and is this cover already another print's?
  const { data: elsewhere, error: probeErr } = await actor.admin
    .from("print_sheet_tokens")
    .select("id")
    .eq("cover_print_id", input.coverPrintId)
    .neq("print_id", input.printId)
    .limit(1);
  if (probeErr) {
    if (isMissingCoverLinkColumn(probeErr)) return { outcome: "unavailable" };
    console.error("[print-sheet-tokens] cover link unreadable — nothing settled:", probeErr.message);
    return { outcome: "error" };
  }
  if (((elsewhere as unknown[] | null) ?? []).length > 0) return refused("That cover is already linked to another print");

  const { data: cover, error: coverErr } = await actor.admin
    .from("work_package_prints")
    .select("id, org_id, printed_by, printed_at, sheets")
    .eq("id", input.coverPrintId)
    .maybeSingle();
  if (coverErr) {
    console.error("[print-sheet-tokens] cover unreadable — nothing settled:", coverErr.message);
    return { outcome: "error" };
  }
  const c = cover as { org_id?: string | null; printed_by?: string | null; printed_at?: string | null; sheets?: unknown } | null;
  // Same workspace, and the caller is the one who printed that cover.
  if (!c || c.org_id !== input.orgId || !c.printed_by || c.printed_by !== actor.userId) {
    return refused("That cover is not one this print can be linked to");
  }
  // The cover belongs to the pack being printed: its printed sheets are
  // exactly this settle's sheets, each at the version its token was minted
  // for, and it was recorded after the tokens were minted.
  const onCover = coverPrintedSheets(c.sheets);
  const same = onCover.size === input.printed.size && [...input.printed].every((d) => onCover.has(d));
  const versionsMatch = input.rows.every((r) => {
    const d = String(r.document_id).toLowerCase();
    return !input.printed.has(d) || onCover.get(d) === String(r.version_id ?? "").toLowerCase();
  });
  const mintedAt = Math.min(...input.rows.map((r) => Date.parse(String(r.minted_at ?? ""))));
  const coverAt = Date.parse(String(c.printed_at ?? ""));
  const after = Number.isFinite(mintedAt) && Number.isFinite(coverAt) && coverAt >= mintedAt;
  if (!same || !versionsMatch || !after) return refused("That cover does not list the sheets of this print");
  return { outcome: "ok" };
}

/** PS-P10 (intelligence DACL-8 residual (c)): a controller recalls a printed
 *  pack — every live token of the print is voided 'recalled', audit row
 *  first. */
async function recallPrint(actor: AuthorizedActor, orgId: string, body: Record<string, unknown>) {
  // A controller only, by the role collection — refused before anything is read.
  if (!memberHoldsAny({ role: actor.role, roles: actor.roles }, SHEET_PRINT_RECALL_ROLES)) {
    return json({ error: "Only Document Control or an Admin can recall a printed pack" }, 403);
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < SHEET_PRINT_RECALL_REASON_MIN || reason.length > SHEET_PRINT_RECALL_REASON_MAX) {
    return json({ error: `Say why this print is recalled (${SHEET_PRINT_RECALL_REASON_MIN}–${SHEET_PRINT_RECALL_REASON_MAX} characters)` }, 400);
  }
  const coverPrintId = typeof body.coverPrintId === "string" ? body.coverPrintId.toLowerCase() : null;
  const printId = typeof body.printId === "string" ? body.printId.toLowerCase() : null;
  if ((coverPrintId === null) === (printId === null) || !UUID_RE.test(coverPrintId ?? printId ?? "")) {
    return json({ error: "Invalid request" }, 400);
  }

  let packageId: string | null = null;
  if (coverPrintId) {
    const { data: cover, error: coverErr } = await actor.admin
      .from("work_package_prints")
      .select("id, org_id, package_id")
      .eq("id", coverPrintId)
      .maybeSingle();
    if (coverErr) return json({ error: "Couldn't read the print — try again" }, 503);
    const c = cover as { org_id?: string | null; package_id?: string | null } | null;
    if (!c || c.org_id !== orgId) return json({ error: "Unknown print" }, 404);
    packageId = c.package_id ?? null;
  }

  const { data, error } = await actor.admin
    .from("print_sheet_tokens")
    .select("id, print_id, settled_at, voided_at, cover_print_id")
    .eq("org_id", orgId)
    .eq(coverPrintId ? "cover_print_id" : "print_id", (coverPrintId ?? printId) as string);
  if (error) {
    if (isMissingSheetTokenTable(error) || isMissingCoverLinkColumn(error)) {
      return json({ available: false, recalled: false, error: "Recalling a printed pack needs database update 20261240 — nothing was changed." });
    }
    return json({ error: "Couldn't read the print — try again" }, 503);
  }
  const rows = (data as Array<{ id: string; print_id: string; settled_at: string | null; voided_at: string | null }> | null) ?? [];
  if (rows.length === 0) {
    return json({ error: "No sheet of this print carries a per-print code (it was printed before the codes were linked to their cover, or they could not be issued) — a recall cannot reach its paper." }, 404);
  }
  const live = rows.filter((r) => !r.voided_at);
  if (live.length === 0) return json({ error: "Every sheet of this print is already void" }, 409);

  const printIds = [...new Set(rows.map((r) => String(r.print_id)))];
  const audit = async (details: Record<string, unknown>): Promise<string | null> => {
    try {
      const { error: aErr } = await actor.admin.from("audit_logs").insert({
        action: "DISTRIBUTION_RECALL",
        resource_id: packageId ?? orgId,
        resource_type: packageId ? "work_package" : "org",
        org_id: orgId,
        user_id: actor.userId,
        user_email: actor.email,
        user_role: memberHoldsAny({ roles: actor.roles }, ["Admin"]) ? "Admin" : "DocCtrl",
        details: { kind: "sheet_print_recall", coverPrintId, printIds, ...details },
      });
      return aErr ? aErr.message : null;
    } catch (e) {
      return (e as Error)?.message || String(e);
    }
  };
  // The record first: nothing is voided without it.
  const auditErr = await audit({ reason, sheets: live.length, alreadyVoid: rows.length - live.length, recordedBeforeApply: true });
  if (auditErr) {
    console.error("[print-sheet-tokens] recall audit row NOT written — nothing voided:", auditErr);
    return json({ error: "Couldn't record the recall — nothing was changed. Try again." }, 503);
  }

  const now = new Date().toISOString();
  let voided = 0;
  let voidErr: string | null = null;
  // A settled sheet keeps its settle; an unsettled one is settled by the void
  // (one update each — the guard keeps a settle final).
  for (const [ids, patch] of [
    [live.filter((r) => r.settled_at).map((r) => r.id), { voided_at: now, void_reason: "recalled" as SheetTokenVoidReason }],
    [live.filter((r) => !r.settled_at).map((r) => r.id), { voided_at: now, void_reason: "recalled" as SheetTokenVoidReason, settled_at: now }],
  ] as Array<[string[], Record<string, string>]>) {
    for (const part of chunks(ids)) {
      const { data: hit, error: uErr } = await actor.admin
        .from("print_sheet_tokens")
        .update(patch)
        .in("id", part)
        .is("voided_at", null)
        .select("id");
      if (uErr) { voidErr = uErr.message; break; }
      voided += (hit as unknown[] | null)?.length ?? 0;
    }
    if (voidErr) break;
  }
  if (voidErr || voided !== live.length) {
    const followErr = await audit({ reason, incomplete: true, sheets: live.length, voided, error: voidErr ?? "the print changed while it was recalled" });
    if (followErr) console.error("[print-sheet-tokens] the recall's follow-up audit row was not written:", followErr);
    return json({ error: `Only ${voided} of ${live.length} sheets were recalled — try again.`, voided }, 409);
  }
  return json({ recalled: true, voided, alreadyVoid: rows.length - live.length });
}
