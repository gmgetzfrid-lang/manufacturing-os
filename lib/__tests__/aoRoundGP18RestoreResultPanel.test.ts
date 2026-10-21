// @vitest-environment jsdom
//
// lib/__tests__/aoRoundGP18RestoreResultPanel.test.ts
//
// admin-and-org Round G, package P18 RESTORE REVIEW-MODEL ROWS, final pass —
// admin-and-org BKP-17 (assigned to this pass by the integrator, DEC-90:
// fail-safe, no regression). Since P18 a tickets restore into a database with
// 20261250 writes two kinds of line the result panel did not show as such:
//   (1) each table outcome's plain-language notes (RestoreTableOutcome.notes —
//       for tickets, the "filed before the review model" line), now rendered
//       under that table's name;
//   (2) each request restored without its like-in-kind declaration
//       (DECLARATION_NOT_RESTORED, a `cleared` note), now listed per request
//       (its number from the note's structured `ticketNumber`) in its own
//       block in the note's words, and counted apart in the headline — "N
//       declaration(s) not restored (those requests now need an engineer's
//       sign-off)" — never inside "pointer(s) cleared";
//   (3) REGRESSION: every other count, label and outcome renders exactly as
//       before — P17's nine digests (aoRoundGP17RestoreRenumberReport.test.ts)
//       stay byte-identical, and the five results below (renumberings,
//       unconfirmed, the two number refusals, more than ten lines, a refused
//       headline) are pinned by digests captured from the panel at adb7509,
//       before this pass changed it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

import { db, type Row } from "./helpers/restoreMemoryDb";

vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
      userId: "admin-1", email: "admin@x.io", orgId, role: "Admin", roles: ["Admin"], admin: { from: mem.from },
    })),
  };
});

import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as beginRoute } from "@/app/api/admin/restore/begin/route";
import { RestoreResultPanel } from "@/app/(protected)/admin/restore/RestoreResultPanel";
import {
  planRestore, runChunkedRestore, renumberedOf, filedBeforeReviewModelNote,
  TICKET_RENUMBERED, TICKET_NUMBER_IN_USE, TICKET_NUMBER_UNSETTLED, DANGLING_FLOW_CODE, DECLARATION_NOT_RESTORED,
  type ChunkedRestoreResult, type RestoreTableOutcome, type RestoreRowRefusal, type RestorePost, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";

// ── rendering (as aoRoundGP17RestoreRenumberReport.test.ts renders it) ────
const markup = (result: ChunkedRestoreResult) => renderToStaticMarkup(React.createElement(RestoreResultPanel, { result }));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function render(result: ChunkedRestoreResult): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${markup(result)}</body>`, "text/html");
}
const flat = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const headline = (d: Document) => flat(d.querySelector("div.text-sm.font-black")?.textContent);
const body = (d: Document) => flat(d.body.textContent);
const byTestId = (d: Document, id: string) => Array.from(d.querySelectorAll(`[data-testid="${id}"]`));

// ── result fixtures ──────────────────────────────────────────────────────
const table = (name: string, o: Partial<RestoreTableOutcome> = {}): RestoreTableOutcome => ({
  name, rows: 0, inserted: 0, existing: 0, heldElsewhere: 0, uncounted: 0, filtered: 0, refused: [], cleared: [], advanced: 0, notApplied: [], renumbered: [], ...o,
});
function result(tables: RestoreTableOutcome[], o: Partial<ChunkedRestoreResult> = {}): ChunkedRestoreResult {
  const sum = (f: (t: RestoreTableOutcome) => number) => tables.reduce((s, t) => s + f(t), 0);
  const dangling = sum((t) => t.refused.filter((r) => r.code === DANGLING_FLOW_CODE).length);
  return {
    idRemap: { orgId: { "backup-org": "org-1" }, uid: {} }, createdUsers: 2, linkedUsers: 3, placeholdersWithoutProfile: 0, unmappedMembers: 0,
    totalInserted: sum((t) => t.inserted), totalExisting: sum((t) => t.existing), totalHeldElsewhere: sum((t) => t.heldElsewhere),
    totalUncounted: sum((t) => t.uncounted), totalFiltered: sum((t) => t.filtered),
    totalRefused: sum((t) => t.refused.length) - dangling, totalDanglingFlows: dangling,
    totalCleared: sum((t) => t.cleared.length), totalAdvanced: sum((t) => t.advanced), totalNotApplied: sum((t) => t.notApplied.length),
    meaningIndexRebuild: {}, meaningIndexUnchecked: [], tables, stoppedAt: null, notAttempted: [], ...o,
  };
}
const personCleared = (id: string, column = "created_by"): RestoreRowRefusal =>
  ({ id, code: "person_not_restored", message: `${column} cleared: the backup names a restored placeholder with no sign-in account yet` });
const refusal = (id: string, code: string, message = `refused ${code}`): RestoreRowRefusal => ({ id, code, message });
const renumberNote = (id: string, from: string, to: string, holder: string, unconfirmed = false): RestoreRowRefusal => ({
  id, code: TICKET_RENUMBERED,
  message: `ticket_id "${from}" → "${to}": request ${holder} of this workspace carries "${from}"`,
  renumbered: { from, to, numberHeldBy: holder, ...(unconfirmed ? { unconfirmed: true as const } : {}) },
});
const declarationNote = (id: string, num: string | null): RestoreRowRefusal => ({
  id, code: DECLARATION_NOT_RESTORED,
  message: `like_in_kind_* cleared on request ${num ?? id}: its requester declared the work like-in-kind and signed that declaration electronically, but the signature is not on record in this workspace (a backup carries no signatures), so the request was restored as undeclared — it now needs an engineer's sign-off (or a recorded management override) before it issues, as any undeclared request does.`,
  ...(num ? { ticketNumber: num } : {}),
});
const ticketsWith = (cleared: RestoreRowRefusal[], o: Partial<RestoreTableOutcome> = {}) =>
  table("tickets", { rows: 10, inserted: 10, cleared, renumbered: renumberedOf(cleared), ...o });

/** REGRESSION fixtures beyond P17's nine — no table note and no declaration;
 *  each digest captured from RestoreResultPanel.tsx at adb7509 (this
 *  package's head before this pass), before the panel changed. */
const REGRESSION: Array<{ name: string; result: () => ChunkedRestoreResult; digest: string }> = [
  { name: "a renumbering beside cleared pointers", digest: "f40992d4115a5253cd9547493f2cafeebd2e2dff2458f930940a2abab20822c6", result: () => result([ticketsWith([personCleared("t-1"), renumberNote("t-2", "A-1", "A-9", "t-live"), personCleared("t-3", "assigned_to")])]) },
  { name: "an unconfirmed renumbering", digest: "46638d649992126458230667c543f23768fabc0bd070ac2e096d3afa14042a7c", result: () => result([ticketsWith([renumberNote("t-2", "A-1", "A-9", "t-live", true)])]) },
  { name: "the two request-number refusals beside a 23505", digest: "1d37684b728d82388c417ca720e7c9fe1e43a51688eaa515f45607c7889ec27b", result: () => result([ticketsWith([], {
    refused: [
      { id: "t-b-2", code: TICKET_NUMBER_IN_USE, message: "in use", ticketNumber: "A-7", numberHeldBy: "t-b-1" },
      { id: "t-b-3", code: TICKET_NUMBER_UNSETTLED, message: "unsettled", ticketNumber: "A-8" },
      refusal("t-b-4", "23505"),
    ],
  })]) },
  { name: "twelve renumberings (the print-only list)", digest: "f658107f9e25c0b018c9217b787bda42b3fdd0defee507cb4b5688baeef311f6", result: () => result([ticketsWith(Array.from({ length: 12 }, (_, i) => renumberNote(`t-${i}`, `A-${i}`, `A-${100 + i}`, `t-live-${i}`)))]) },
  { name: "a refused headline over cleared pointers and a dangling flow", digest: "ce7491225ea29c41dfc39738641bac9945839a384eac559ec3ac3282ef3b535b", result: () => result([
    ticketsWith([personCleared("t-1")], { refused: [refusal("t-9", "parent_outside_workspace")] }),
    table("process_flows", { rows: 2, inserted: 1, refused: [refusal("f-1", DANGLING_FLOW_CODE)] }),
  ]) },
];

describe("BKP-17 (3) REGRESSION — every other count, label and outcome renders exactly as before (digests of the panel at adb7509)", () => {
  for (const f of REGRESSION) {
    it(f.name, () => {
      const html = markup(f.result());
      if (process.env.P18_CAPTURE) console.log(`P18_CAPTURE ${JSON.stringify(f.name)} ${sha(html)}`);
      expect(sha(html)).toBe(f.digest);
    });
  }
});

describe("BKP-17 (1)(2) — the review-model lines, rendered", () => {
  it("a declaration restored without its e-signature: its own block, listed per request by number in the note's words; the headline counts it apart — never 'pointer(s) cleared'", () => {
    const run = result([ticketsWith([declarationNote("t-1", "AC-DDRT-26-0001"), declarationNote("t-2", "AC-DDRT-26-0002")])]);
    const d = render(run);
    expect(headline(d)).toBe("Records restored — 2 declaration(s) not restored (those requests now need an engineer's sign-off)");
    expect(body(d)).not.toMatch(/pointer/);
    const block = byTestId(d, "restore-declarations-cleared");
    expect(block).toHaveLength(1);
    expect(flat(block[0].textContent)).toMatch(/^tickets: 2 request\(s\) restored without their like-in-kind declaration — each requester signed the declaration electronically, but a backup carries no signatures and that signature is not on record in this workspace, so each request was restored as undeclared and now needs an engineer's sign-off \(or a recorded management override\) before it issues, as any undeclared request does\./);
    const lines = byTestId(d, "restore-declaration-line");
    expect(lines.map((li) => li.getAttribute("data-ticket-number"))).toEqual(["AC-DDRT-26-0001", "AC-DDRT-26-0002"]);
    expect(flat(lines[0].textContent)).toBe(`AC-DDRT-26-0001 — ${flat(declarationNote("t-1", "AC-DDRT-26-0001").message)}`);
    // tone: still amber (a cleared note), as before
    expect(markup(run)).toContain("border-amber-200 bg-amber-50 text-amber-900");
  });

  it("beside cleared pointers and a renumbering: the headline counts each apart, and the pointer line counts only the pointers", () => {
    const d = render(result([ticketsWith([personCleared("t-1"), declarationNote("t-2", "A-2"), renumberNote("t-3", "A-1", "A-9", "t-live"), personCleared("t-4", "assigned_to")])]));
    expect(headline(d)).toBe("Records restored — 2 pointer(s) cleared · 1 declaration(s) not restored (those requests now need an engineer's sign-off) · 1 request(s) restored under a new number");
    expect(body(d)).toContain("tickets: 2 row(s) restored with a pointer cleared — created_by, assigned_to (");
    expect(body(d)).not.toContain("like_in_kind_*,");
    expect(byTestId(d, "restore-declaration-line")).toHaveLength(1);
    expect(byTestId(d, "restore-renumbered-line")).toHaveLength(1);
  });

  it("a note without a number (an older server) names the backup request; more than ten declarations print in full", () => {
    const d = render(result([ticketsWith([declarationNote("t-x", null)])]));
    expect(flat(byTestId(d, "restore-declaration-line")[0].textContent)).toMatch(/^backup request t-x — like_in_kind_\* cleared on request t-x:/);
    expect(byTestId(d, "restore-declaration-line")[0].hasAttribute("data-ticket-number")).toBe(false);
    const many = render(result([ticketsWith(Array.from({ length: 12 }, (_, i) => declarationNote(`t-${i}`, `A-${i}`)))]));
    expect(headline(many)).toBe("Records restored — 12 declaration(s) not restored (those requests now need an engineer's sign-off)");
    expect(byTestId(many, "restore-declarations-cleared-all")).toHaveLength(1);
    expect(byTestId(many, "restore-declarations-cleared-all-print")[0].querySelectorAll("li")).toHaveLength(12);
  });

  it("a headline that outranks it (rows refused) is unchanged; the declaration still has its block", () => {
    const d = render(result([ticketsWith([declarationNote("t-2", "A-2")], { refused: [refusal("t-9", "23505")] })]));
    expect(headline(d)).toBe("Records restored — 1 row(s) refused");
    expect(byTestId(d, "restore-declaration-line")).toHaveLength(1);
  });

  it("each table's notes render under that table's name, in the line's own words; a clean run with a note keeps its green headline", () => {
    const line = filedBeforeReviewModelNote(3);
    const run = result([table("libraries", { rows: 1, inserted: 1 }), ticketsWith([], { inserted: 3, rows: 3, notes: [line] })]);
    const d = render(run);
    expect(headline(d)).toBe("Records restored");
    expect(markup(run)).toContain("border-emerald-200 bg-emerald-50 text-emerald-900");
    expect(byTestId(d, "restore-table-note").map((x) => flat(x.textContent))).toEqual([`tickets: ${line}`]);
    // the panel without the note is the panel as before, plus nothing
    const without = markup(result([table("libraries", { rows: 1, inserted: 1 }), ticketsWith([], { inserted: 3, rows: 3 })]));
    expect(markup(run).replace(/<div data-testid="restore-table-note">.*?<\/div>/, "")).toBe(without);
  });
});

// ── the restore itself, through the real routes over the in-memory engine ─
const ORG = "org-1";
const REMAP_ORG = "backup-org";
const SIG = "11111111-2222-4333-8444-555555555555";
const prePaste = (id: string, num: string, extra: Row = {}): Row => ({ id, org_id: REMAP_ORG, ticket_id: num, title: `Request ${num}`, status: "PENDING_REVIEW", requester_role: "Manager", requester_id: "u-req", ...extra });
const declared = (id: string, num: string): Row => prePaste(id, num, {
  review_model_filed: true, engineering_required: false, work_class: null, code_class: null,
  like_in_kind_statement: "Identical replacement.", like_in_kind_declared_by: "u-req", like_in_kind_declared_at: "2026-10-01T10:00:00Z", like_in_kind_signature_id: SIG,
});
const routePost: RestorePost = async (path, b) => {
  const req = new NextRequest(`https://app${path}`, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(b) });
  const handler = path.startsWith("/api/admin/restore/begin") ? beginRoute : applyTable;
  const res = await handler(req);
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
const drive = (env: RestoreEnvelopeLike) => runChunkedRestore({ orgId: ORG, envelope: env, plan: planRestore(env, { orgId: ORG, orgName: "Acme", members: [] }), orgNameChoice: "current", post: routePost });

beforeEach(() => {
  db.rows = { orgs: [{ id: ORG, name: "Acme", ticket_prefix: "AC" }], org_members: [] };
  db.keys = { ticket_number_counters: [["org_id", "year"]] };
  db.writeError = null; db.readError = {}; db.writes = []; db.attempts = []; db.countless = false; db.fks = {};
  db.maxRows = 1000; db.generated = {}; db.authUsers = null; db.defaults = {}; db.missingColumns = {};
});

describe("BKP-17 — a tickets restore through the page's driver, rendered", () => {
  it("a backup with a pre-paste request and a declaration with no e-signature here: the filed-before line under tickets, the declaration listed by number, counted apart", async () => {
    const run = await drive({ manifest: { orgId: REMAP_ORG }, tables: { tickets: [prePaste("t-1", "AC-DDRT-26-0001"), declared("t-2", "AC-DDRT-26-0002")] } });
    expect(run.stoppedAt).toBeNull();
    const t = run.tables.find((x) => x.name === "tickets")!;
    expect(t.notes).toEqual([filedBeforeReviewModelNote(1)]);
    expect(t.cleared).toEqual([expect.objectContaining({ id: "t-2", code: DECLARATION_NOT_RESTORED, ticketNumber: "AC-DDRT-26-0002" })]);
    const d = render(run);
    expect(headline(d)).toBe("Records restored — 1 declaration(s) not restored (those requests now need an engineer's sign-off)");
    expect(body(d)).not.toMatch(/pointer/);
    expect(byTestId(d, "restore-table-note").map((x) => flat(x.textContent))).toEqual([`tickets: ${filedBeforeReviewModelNote(1)}`]);
    const line = byTestId(d, "restore-declaration-line");
    expect(line.map((li) => li.getAttribute("data-ticket-number"))).toEqual(["AC-DDRT-26-0002"]);
    expect(flat(line[0].textContent)).toBe(`AC-DDRT-26-0002 — ${flat(t.cleared[0].message)}`);
  });

  it("a declared request renumbered on restore is listed under the number it is restored under", async () => {
    db.rows.tickets = [{ id: "t-live", org_id: ORG, ticket_id: "AC-DDRT-26-0001", title: "live" }];
    db.rows.ticket_number_counters = [{ org_id: ORG, year: 2026, next_seq: 5 }];
    const run = await drive({ manifest: { orgId: REMAP_ORG }, tables: { tickets: [declared("t-2", "AC-DDRT-26-0001")] } });
    const t = run.tables.find((x) => x.name === "tickets")!;
    const to = t.renumbered[0].to;
    expect(to).not.toBe("AC-DDRT-26-0001");
    const d = render(run);
    expect(byTestId(d, "restore-declaration-line").map((li) => li.getAttribute("data-ticket-number"))).toEqual([to]);
    expect(headline(d)).toBe("Records restored — 1 declaration(s) not restored (those requests now need an engineer's sign-off) · 1 request(s) restored under a new number");
  });
});
