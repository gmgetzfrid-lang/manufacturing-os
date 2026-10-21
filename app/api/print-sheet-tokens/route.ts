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
//     A voided token's scan reads stale, never green. The settle never reads
//     or writes the cover link (PS-P10 review fix: it first carried it, but
//     the settle is fired and never awaited, so a dropped settle left the
//     print unlinked for good — the link moved to `link`, below).
//
//   { action: "link", orgId, printId, coverPrintId, printed: [documentId…] }
//     → { linked: true, sheets: n } | { available: false, linked: false }
//       | 400 { refused: true, code: "cover_mismatch", error }
//     PS-P10 (PHYS-19 c3): a work-package pack's sheet tokens link by key to
//     the work_package_prints id of the cover printed with them. The cover is
//     recorded AFTER the sheets are stamped (PKG-6), so the mint cannot carry
//     it; the pack path calls this right after recording the cover and
//     AWAITS it BEFORE the download. The server checks it — same workspace,
//     printed by the caller, its printed sheets exactly `printed` at the
//     versions the tokens were minted for, recorded after the mint, linked to
//     no other print (no package identity is compared) — and stores it on
//     every unsettled token row of the print in ONE guarded update
//     (print_sheet_tokens.cover_print_id, 20261240): a print is wholly linked
//     or not linked at all. A mismatch is the REFUSAL — 400 carrying
//     `refused: true, code: "cover_mismatch"` — and nothing is written; ONLY
//     that refusal stops the print (nothing downloaded; the abort voids the
//     tokens). Every other answer — a 5xx or no answer after the client's one
//     retry, a 401, 404 or 409, or any other 400 (a malformed body, an
//     "Unknown action" from an older route) — FAILS OPEN: the pack prints
//     unlinked, exactly as before PS-P10, and a recall by its cover answers
//     the truthful 404. So a work-package pack printed after 20261240 carries
//     the link only when its link was written. Repeating a link that is
//     already written answers linked (idempotent). Before 20261240 is pasted
//     (42703 / PGRST204): { available: false } — the pack prints as today,
//     unlinked. A pack without a cover (the asset hub's, the two "Print all"
//     packs) never calls it: its token print keeps its own id and a NULL link.
//
//   { action: "void", orgId, coverPrintId | printId, reason }
//     → { recalled: true, voided: n, alreadyVoid: m }
//     PS-P10 (intelligence DACL-8 residual (c)): a controller — Admin or
//     Document Control by the role collection — recalls a printed pack: every
//     live token of that print (by the token print id, or by the cover's
//     work_package_prints id — which finds the token print(s) linked to it
//     and then takes EVERY token of those prints, linked or not) is voided
//     'recalled', settled or not (the 20261237
//     guard allows a void after a settle; a void stays one-way). The audit
//     row (DISTRIBUTION_RECALL, with the reason) is written FIRST — nothing is
//     voided without it — and a short void writes a second row saying so.
//     A recalled sheet's scan reads print_voided: red, never green. A
//     non-controller is refused 403 before anything is read. Before 20261240
//     is pasted: { available: false } and nothing is written — by a cover or
//     by a token print id, the token read names cover_print_id, so its 42703
//     answers before the audit row (fifth review fix); a void refused by a
//     void-reason CHECK without 'recalled' also answers { available: false }.
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
  isVoidReasonCheckRefusal,
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

/** A recall by a cover's print id that finds no sheet code linked to it.
 *  Three cases leave a print record with no linked code, and the answer
 *  names all three (PS-P10 second review fix): the print may have been
 *  STOPPED before anything was downloaded — its cover snapshot is recorded
 *  before the link, so a link that failed leaves the record and no paper. */
const NO_LINKED_SHEET_CODE =
  "No sheet code is linked to this print record, so a recall from here cannot reach its sheets — nothing was changed. " +
  "Either this print was stopped before anything was downloaded (its record is kept, but no paper left — there is nothing to withdraw), " +
  "or its per-print codes could not be linked when it was printed (the link failed, so the pack printed unlinked, as before per-print " +
  "links), or its sheets carry the document's own QR (no per-print code could be issued) or codes printed before per-print " +
  "codes were linked to their print record (database update 20261240 and this release); those sheets keep scanning " +
  "by their revision's status. If paper from this print is in use, withdraw it by hand, and hold or supersede the revision if its sheets must read red.";

/** The marker on the link's one refusal (the cover is not this print's).
 *  The pack path stops the print ONLY on a 400 carrying it; any other 400
 *  prints unlinked (lib/printSheetTokensClient.ts, lib/docPack.ts). */
const COVER_MISMATCH = "cover_mismatch";
const coverRefusal = (error: string) => json({ refused: true, code: COVER_MISMATCH, error }, 400);

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

  if (body.action === "link") return linkCover(actor, orgId, body);

  if (body.action === "void") return recallPrint(actor, orgId, body);

  return json({ error: "Unknown action" }, 400);
}

/** PS-P10 (PHYS-19 c3): a work-package pack's token print linked by key to
 *  its cover's print, before the download (the pack path awaits it: only the
 *  marked cover_mismatch refusal stops the print; any other failure, after
 *  one retry, prints the pack unlinked as before PS-P10). Writes only
 *  unsettled rows the caller minted, in one guarded update; idempotent under
 *  the client's own retry. */
async function linkCover(actor: AuthorizedActor, orgId: string, body: Record<string, unknown>) {
  const printId = typeof body.printId === "string" ? body.printId.toLowerCase() : "";
  const coverPrintId = typeof body.coverPrintId === "string" ? body.coverPrintId.toLowerCase() : "";
  if (!UUID_RE.test(printId) || !UUID_RE.test(coverPrintId) || !Array.isArray(body.printed) || body.printed.length === 0) {
    return json({ error: "Invalid request" }, 400);
  }
  const printed = new Set(
    (body.printed as unknown[]).filter((x): x is string => typeof x === "string" && UUID_RE.test(x)).map((x) => x.toLowerCase()),
  );
  const unavailable = () => json({ available: false, linked: false });
  const { data, error } = await actor.admin
    .from("print_sheet_tokens")
    .select("id, document_id, version_id, minted_at, cover_print_id")
    .eq("print_id", printId)
    .eq("org_id", orgId)
    .eq("minted_by", actor.userId)
    .is("settled_at", null);
  if (error) {
    if (isMissingSheetTokenTable(error) || isMissingCoverLinkColumn(error)) return unavailable();
    console.error("[print-sheet-tokens] link: print unreadable — nothing linked:", error.message);
    return json({ error: "Couldn't link the sheets to the cover — try again" }, 503);
  }
  const rows = (data as Array<{ id: string; document_id: string; version_id?: string | null; minted_at?: string | null; cover_print_id?: string | null }> | null) ?? [];
  if (rows.length === 0) return json({ error: "Unknown or already settled print" }, 404);
  const linkedTo = new Set(rows.map((r) => (r.cover_print_id ? String(r.cover_print_id).toLowerCase() : null)).filter((x): x is string => !!x));
  if ([...linkedTo].some((c) => c !== coverPrintId)) return coverRefusal("This print is already linked to another cover");
  const toLink = rows.filter((r) => !r.cover_print_id);
  // A repeat of a link already written (a retry after a lost answer).
  if (toLink.length === 0) return json({ linked: true, sheets: rows.length });

  const check = await checkCoverLink(actor, { orgId, printId, coverPrintId, rows, printed });
  if (check.outcome === "unavailable") return unavailable();
  if (check.outcome === "refused") return coverRefusal(check.error);
  if (check.outcome === "error") return json({ error: "Couldn't link the sheets to the cover — try again" }, 503);

  // ONE guarded statement (fourth review fix — it was chunked by id, so a
  // chunk that failed left the print part-linked): Postgres applies it
  // whole or not at all, so the print is either wholly linked or not linked.
  const { data: hit, error: lErr } = await actor.admin
    .from("print_sheet_tokens")
    .update({ cover_print_id: coverPrintId })
    .eq("print_id", printId)
    .eq("org_id", orgId)
    .eq("minted_by", actor.userId)
    .is("settled_at", null)
    .is("cover_print_id", null)
    .select("id");
  if (lErr) {
    if (isMissingCoverLinkColumn(lErr)) return unavailable();
    console.error("[print-sheet-tokens] link write refused — nothing linked:", lErr.message);
    return json({ error: "Couldn't link the sheets to the cover — try again" }, 503);
  }
  const linked = (hit as unknown[] | null)?.length ?? 0;
  if (linked !== toLink.length) {
    // A short write is not yet a conflict: an earlier request for the SAME
    // link that the client gave up on (its timeout) and then retried may
    // have written these rows while this one was checking — the guard's
    // `.is("cover_print_id", null)` then skips them. Re-read: when every row
    // this request meant to link now names THIS cover, the link is written
    // (the lost-answer retry) — 409 only when a row is still unlinked or
    // names another cover.
    const { data: after, error: rErr } = await actor.admin
      .from("print_sheet_tokens")
      .select("id, cover_print_id")
      .eq("print_id", printId)
      .eq("org_id", orgId)
      .eq("minted_by", actor.userId);
    if (rErr) {
      console.error("[print-sheet-tokens] link: short write unreadable:", rErr.message);
      return json({ error: "Couldn't link the sheets to the cover — try again" }, 503);
    }
    const linkedNow = new Map(
      ((after as Array<{ id: string; cover_print_id?: string | null }> | null) ?? [])
        .map((r) => [String(r.id), r.cover_print_id ? String(r.cover_print_id).toLowerCase() : null] as const),
    );
    if (!toLink.every((r) => linkedNow.get(String(r.id)) === coverPrintId)) {
      return json({ error: "The print changed while it was linked — try again" }, 409);
    }
  }
  return json({ linked: true, sheets: rows.length });
}

/** PS-P10 (PHYS-19 c3): may this print be linked to that cover?
 *  `unavailable` — 20261240 not pasted (the link column is missing): the
 *  pack prints as today, unlinked. `refused` — the cover is not this print's:
 *  400, nothing written. `error` — a transient read failure: 503, nothing
 *  written. Read-only. */
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
    console.error("[print-sheet-tokens] cover link unreadable — nothing linked:", probeErr.message);
    return { outcome: "error" };
  }
  if (((elsewhere as unknown[] | null) ?? []).length > 0) return refused("That cover is already linked to another print");

  const { data: cover, error: coverErr } = await actor.admin
    .from("work_package_prints")
    .select("id, org_id, printed_by, printed_at, sheets")
    .eq("id", input.coverPrintId)
    .maybeSingle();
  if (coverErr) {
    console.error("[print-sheet-tokens] cover unreadable — nothing linked:", coverErr.message);
    return { outcome: "error" };
  }
  const c = cover as { org_id?: string | null; printed_by?: string | null; printed_at?: string | null; sheets?: unknown } | null;
  // Same workspace, and the caller is the one who printed that cover.
  if (!c || c.org_id !== input.orgId || !c.printed_by || c.printed_by !== actor.userId) {
    return refused("That cover is not one this print can be linked to");
  }
  // The cover belongs to the pack being printed: its printed sheets are
  // exactly the sheets this print downloads, each at the version its token
  // was minted for, and it was recorded after the tokens were minted.
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
 *  first. By a cover's print id, the cover finds the token print(s) linked to
 *  it and the recall takes every token of those prints, linked or not
 *  (fourth review fix: a print linked only in part is still recalled whole). */
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

  const notYet = () => json({ available: false, recalled: false, error: "Recalling a printed pack needs database update 20261240 — nothing was changed." });
  // By a cover: first the token print(s) linked to it. The recall then takes
  // EVERY token of those prints in this workspace — a row the link did not
  // reach is still that print's paper.
  let tokenPrintIds: string[] = printId ? [printId] : [];
  if (coverPrintId) {
    const { data: linkedRows, error: linkErr } = await actor.admin
      .from("print_sheet_tokens")
      .select("print_id")
      .eq("org_id", orgId)
      .eq("cover_print_id", coverPrintId);
    if (linkErr) {
      if (isMissingSheetTokenTable(linkErr) || isMissingCoverLinkColumn(linkErr)) return notYet();
      return json({ error: "Couldn't read the print — try again" }, 503);
    }
    tokenPrintIds = [...new Set(((linkedRows as Array<{ print_id: string }> | null) ?? []).map((r) => String(r.print_id).toLowerCase()))];
  }
  // Said truthfully (PS-P10 review fix): no code is LINKED to this print
  // record — its paper may still carry live per-print codes from before the
  // link existed, which keep scanning by their revision's status.
  if (tokenPrintIds.length === 0) return json({ error: NO_LINKED_SHEET_CODE }, 404);

  // The read names the link column on EVERY recall path (fifth review fix:
  // by a token print id nothing else read it, so before 20261240 the read
  // succeeded, the audit row was written and the void then failed on the
  // 20261237 CHECK). Before the paste it is 42703 here — before the audit row.
  const { data, error } = await actor.admin
    .from("print_sheet_tokens")
    .select("id, print_id, settled_at, voided_at, cover_print_id")
    .eq("org_id", orgId)
    .in("print_id", tokenPrintIds);
  if (error) {
    if (isMissingSheetTokenTable(error) || isMissingCoverLinkColumn(error)) return notYet();
    return json({ error: "Couldn't read the print — try again" }, 503);
  }
  const rows = (data as Array<{ id: string; print_id: string; settled_at: string | null; voided_at: string | null }> | null) ?? [];
  if (rows.length === 0) return json({ error: NO_LINKED_SHEET_CODE }, 404);
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
      if (uErr) {
        // Belt and braces: a void-reason CHECK without 'recalled' (the
        // 20261237 one) means 20261240 is not pasted. Nothing is voided; the
        // attempt is already on the audit trail, so a follow-up row says it
        // did not apply and the answer is "not available", not "try again".
        if (voided === 0 && isVoidReasonCheckRefusal(uErr)) {
          const followErr = await audit({ reason, incomplete: true, sheets: live.length, voided: 0, notApplied: "needs database update 20261240" });
          if (followErr) console.error("[print-sheet-tokens] the recall's follow-up audit row was not written:", followErr);
          return json({ available: false, recalled: false, voided: 0, error: "Recalling a printed pack needs database update 20261240 — no sheet was voided." });
        }
        voidErr = uErr.message;
        break;
      }
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
