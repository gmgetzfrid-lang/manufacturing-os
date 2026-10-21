// @vitest-environment jsdom
//
// lib/__tests__/aoRoundGP17RestoreRenumberReport.test.ts
//
// admin-and-org Round G, package P17 RESTORE RENUMBER REPORT — admin-and-org
// BKP-16, under the integrator's rulings (DEC-90: fail-safe, no regression).
//
// Since P16 (drafting-flow EDGE-5), a backup request whose number another
// request of the workspace already carries is restored under a fresh number
// (TICKET_RENUMBERED). The restore page's result panel rendered that through
// its generic "cleared pointer" lines: the headline counted it as "N
// pointer(s) cleared" and the table line named the column (ticket_id) and a
// code label, so the old → new pair was only in a note's text and the audit
// row. Rendered here (react-dom/server, as the page renders it):
//
//   (1) each renumbered request on its own line, "restored as <new> — <old>
//       was taken", the two numbers read from RestoreTableOutcome.renumbered
//       (structured fields, also carried on the line as data attributes) —
//       never counted as a pointer cleared; an entry flagged `unconfirmed`
//       is said as not confirmed, never as restored;
//   (2) the two refusal codes (TICKET_NUMBER_IN_USE, TICKET_NUMBER_UNSETTLED)
//       in words a plant admin understands, naming the number (the refusal's
//       structured `ticketNumber`) and what to do;
//   (3) REGRESSION: every other outcome, count and label renders exactly as
//       before — the markup of nine results covering every branch of the
//       panel is pinned by digest, captured from the panel moved verbatim out
//       of page.tsx (base 8845807) before any change.

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import { db, from, type Row } from "./helpers/restoreMemoryDb";

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
  applyRestoreChunk, planRestore, runChunkedRestore, renumberedOf, unconfirmedRenumberings,
  TICKET_RENUMBERED, TICKET_NUMBER_IN_USE, TICKET_NUMBER_UNSETTLED, DANGLING_FLOW_CODE, RESTORE_HELD_BACK_ROUNDS,
  type ChunkedRestoreResult, type RestoreTableOutcome, type RestoreRowRefusal, type RestorePost, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";

void from;

// ── rendering ────────────────────────────────────────────────────────────
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
/** A run result whose totals are summed from its tables exactly as
 *  runChunkedRestore sums them. */
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
const renumberNote = (id: string, from: string, to: string, holder: string): RestoreRowRefusal => ({
  id, code: TICKET_RENUMBERED,
  message: `ticket_id "${from}" → "${to}": request ${holder} of this workspace carries "${from}" (a request this workspace holds that is not one of this backup's), so this request was restored under a fresh number rather than beside it or not at all`,
  renumbered: { from, to, numberHeldBy: holder },
});
/** A tickets outcome as the driver builds it: `renumbered` from the notes. */
const ticketsWith = (cleared: RestoreRowRefusal[], o: Partial<RestoreTableOutcome> = {}) =>
  table("tickets", { rows: 10, inserted: 10, cleared, renumbered: renumberedOf(cleared), ...o });

/** REGRESSION fixtures — every branch of the panel with no renumbering and
 *  neither ticket-number refusal; each digest was captured from the panel
 *  moved verbatim out of page.tsx at base 8845807, before P17 changed it. */
const REGRESSION: Array<{ name: string; result: () => ChunkedRestoreResult; digest: string }> = [
  { name: "a clean restore (green)", digest: "37b5eeee4bc2592260b01f317f1ee3076faf32f6cdcb74ac1a9bed39ddff04f7", result: () => result([table("libraries", { rows: 4, inserted: 4 }), table("documents", { rows: 12, inserted: 12 })]) },
  { name: "a run that stopped (with a refusal before it stopped)", digest: "24a571a0037dce44a3d869a1a9c82389baf3a1060609e591f56af4f06c4dd7b7", result: () => result(
    [table("libraries", { rows: 4, inserted: 4 }), table("documents", { rows: 12, inserted: 7, refused: [refusal("d-1", "23505")], error: "permission denied" })],
    { stoppedAt: { table: "documents", error: "permission denied" }, notAttempted: ["document_versions", "tickets"] }) },
  { name: "ids held by another workspace", digest: "f028a0621dbac5dbc93406d0a8982f7adb8d43c48bf1ecfe31b04043f130a142", result: () => result([table("documents", { rows: 5, inserted: 3, heldElsewhere: 2 }), table("tickets", { rows: 1, heldElsewhere: 1 })]) },
  { name: "nothing new (every row already here)", digest: "e3bdf1f351a6a39121eab17f84de4434d4ea1deff7cab068ebb2b940e4c2f675", result: () => result([table("documents", { rows: 5, existing: 5 })]) },
  { name: "refused, dangling flows, cleared pointers, decisions not applied, unmapped members, placeholders, filtered, counters", digest: "6f465799b83d36e87105933421050cdaa8cde705eefce2c5fd3f32119f2dacec", result: () => result([
    table("ticket_number_counters", { rows: 1, existing: 1, advanced: 1 }),
    table("documents", { rows: 9, inserted: 6, existing: 1, refused: [refusal("d-1", "23505"), refusal("d-2", "parent_outside_workspace"), refusal("d-3", "23505")] }),
    table("process_flows", { rows: 4, inserted: 2, refused: [refusal("f-1", DANGLING_FLOW_CODE), refusal("f-2", DANGLING_FLOW_CODE)] }),
    table("tickets", { rows: 6, inserted: 6, cleared: [personCleared("t-1"), personCleared("t-2", "assigned_to")] }),
    table("ticket_comments", { rows: 8, inserted: 6, filtered: 2 }),
    table("entity_mentions", { rows: 3, existing: 3, notApplied: [refusal("m-1", "explicit_not_applied", "the backup's explicit link was not applied")] }),
  ], { unmappedMembers: 2, placeholdersWithoutProfile: 1 }) },
  { name: "dangling flows only", digest: "2ec941de9bd7060de206d2d22a00e65a6b30bf87b32b5747a366de5cd5a5aff3", result: () => result([table("process_flows", { rows: 3, inserted: 2, refused: [refusal("f-1", DANGLING_FLOW_CODE)] })]) },
  { name: "rows the server did not count", digest: "fdaeffdd4515e79a6a60688ca4aa849f7eb85a5e946f209ad49e447e0faa7a1f", result: () => result([table("documents", { rows: 5, inserted: 2, uncounted: 3 })]) },
  { name: "pointers cleared only", digest: "c1e9cb59a58324f2261468593c6de2d86babdfb23aba0119477ec957b53cdae7", result: () => result([
    table("tickets", { rows: 3, inserted: 3, cleared: [personCleared("t-1"), personCleared("t-2")] }),
    table("teams", { rows: 1, inserted: 1, cleared: [personCleared("team-1", "created_by")] }),
  ]) },
  { name: "more than five decisions not applied; a refused ticket (23505) on its generic line", digest: "e972d50197a2b0c03978e6c46c64213760ab56549faa1186dd44470f62a437d4", result: () => result([
    table("knowledge_links", { rows: 7, existing: 7, notApplied: Array.from({ length: 7 }, (_, i) => refusal(`k-${i}`, "decision_not_applied", `decision ${i} kept live`)) }),
    table("tickets", { rows: 2, inserted: 1, refused: [refusal("t-9", "23505")] }),
  ]) },
];

describe("BKP-16 (3) REGRESSION — every other outcome, count and label renders exactly as before (digests of the base panel's markup)", () => {
  for (const f of REGRESSION) {
    it(f.name, () => {
      const html = markup(f.result());
      if (process.env.P17_CAPTURE) console.log(`P17_CAPTURE ${JSON.stringify(f.name)} ${sha(html)}\n${html}`);
      expect(sha(html)).toBe(f.digest);
    });
  }
});

// ── the restore itself, through the real routes over the in-memory engine ─
const ORG = "org-1";
const YY = "26";
const NUMBER_KEY: string[][] = [["id"], ["org_id", "ticket_id"]];
const REMAP = { orgId: { "backup-org": ORG }, uid: {} };
const ticket = (id: string, num: string, org = "backup-org", extra: Row = {}): Row => ({ id, org_id: org, ticket_id: num, title: `Request ${num}`, status: "CLOSED", ...extra });
const routePost: RestorePost = async (path, b) => {
  const req = new NextRequest(`https://app${path}`, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(b) });
  const handler = path.startsWith("/api/admin/restore/begin") ? beginRoute : applyTable;
  const res = await handler(req);
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
const planFor = (envelope: RestoreEnvelopeLike) => planRestore(envelope, { orgId: ORG, orgName: "Acme", members: [] });
const drive = (env: RestoreEnvelopeLike) => runChunkedRestore({ orgId: ORG, envelope: env, plan: planFor(env), orgNameChoice: "current", post: routePost });
/** One applyRestoreChunk answer as the page's driver folds it into a run. */
const asRun = (r: Awaited<ReturnType<typeof applyRestoreChunk>>) => result([table("tickets", {
  rows: r.rowsAfterFilters, inserted: r.inserted, existing: r.existing, uncounted: r.uncounted, refused: r.refused, cleared: r.cleared, renumbered: renumberedOf(r.cleared),
})]);
const lines = (d: Document) => byTestId(d, "restore-renumbered-line").map((li) => ({
  from: li.getAttribute("data-renumbered-from"), to: li.getAttribute("data-renumbered-to"), unconfirmed: li.getAttribute("data-unconfirmed") === "true", text: flat(li.textContent),
}));

beforeEach(() => {
  db.rows = { orgs: [{ id: ORG, name: "Acme" }], org_members: [] };
  db.keys = { ticket_number_counters: [["org_id", "year"]] };
  db.writeError = null; db.readError = {}; db.writes = []; db.attempts = []; db.countless = false; db.fks = {}; db.maxRows = 1000; db.generated = {}; db.authUsers = null;
});

for (const world of ["without the number key", "with the number key"] as const) {
  describe(`BKP-16 (1) — the plant-merge restore through the page's driver, ${world}: the renumbered request on its own line, never a pointer cleared`, () => {
    beforeEach(() => { if (world === "with the number key") db.keys.tickets = NUMBER_KEY; });

    it("headline and line name the old and the new number (from RestoreTableOutcome.renumbered); no 'pointer cleared' anywhere", async () => {
      db.rows.tickets = [ticket("t-live-1", "KE-DDRT-26-0001", ORG)];
      const env: RestoreEnvelopeLike = { manifest: { orgId: "backup-org" }, tables: {
        tickets: [ticket("t-b-1", "KE-DDRT-26-0001"), ticket("t-b-2", "KE-DDRT-26-0402")],
        ticket_comments: [{ id: "c-1", org_id: "backup-org", ticket_id: "t-b-1", body: "on the renumbered one" }],
      } };
      const run = await drive(env);
      const t = run.tables.find((x) => x.name === "tickets")!;
      expect(t.renumbered).toEqual([{ id: "t-b-1", from: "KE-DDRT-26-0001", to: `DDRT-${YY}-0403`, numberHeldBy: "t-live-1" }]);
      const d = render(run);
      expect(headline(d)).toBe("Records restored — 1 request(s) restored under a new number");
      expect(lines(d)).toEqual([{ from: "KE-DDRT-26-0001", to: `DDRT-${YY}-0403`, unconfirmed: false, text: `restored as DDRT-${YY}-0403 — KE-DDRT-26-0001 was taken (request t-live-1 has it)` }]);
      expect(flat(byTestId(d, "restore-renumbered")[0].textContent)).toMatch(/^tickets: 1 request\(s\) restored under a new number — another request here already had its number/);
      // never "the labels now mean the new one": the old number still opens the request that already had it
      expect(flat(byTestId(d, "restore-renumbered")[0].textContent)).toContain("Labels, transmittals and archives printed with the old number for this request must be read as the new number. In this workspace the old number still identifies the request that already had it (named on each line).");
      expect(body(d)).not.toMatch(/now mean the new one/);
      expect(body(d)).not.toMatch(/pointer/);
      expect(body(d)).not.toMatch(/restored with a pointer cleared/);
      // the run's counts are as before: the note still rides `cleared` (and the audit row)
      expect(run.totalCleared).toBe(1);
      expect(body(d)).toContain("Imported 4 new record(s)"); // the completed counter row, both requests, the comment
    });
  });
}

describe("BKP-16 (1) — mixed, many, unconfirmed and unreadable renumberings", () => {
  it("a renumbered request that also had a pointer cleared: the headline counts the pointers apart, and the pointer line no longer names ticket_id", () => {
    const run = result([ticketsWith([personCleared("t-1"), personCleared("t-2", "assigned_to"), renumberNote("t-2", "KE-1", "KE-9", "t-live")])]);
    const d = render(run);
    expect(headline(d)).toBe("Records restored — 2 pointer(s) cleared · 1 request(s) restored under a new number");
    const pointerLine = Array.from(d.querySelectorAll("div")).map((x) => flat(x.textContent)).find((x) => x.startsWith("tickets: 2 row(s) restored with a pointer cleared"))!;
    expect(pointerLine).toBe("tickets: 2 row(s) restored with a pointer cleared — created_by, assigned_to (names a person with no sign-in account yet (a restored placeholder) — re-invite them).");
    expect(pointerLine).not.toMatch(/ticket_id|fresh number/);
    expect(lines(d)).toEqual([{ from: "KE-1", to: "KE-9", unconfirmed: false, text: "restored as KE-9 — KE-1 was taken (request t-live has it)" }]);
  });

  it("more than ten renumbered requests: ten shown, every one behind 'show all'", () => {
    const notes = Array.from({ length: 13 }, (_, i) => renumberNote(`t-${i}`, `OLD-${i}`, `NEW-${i}`, `h-${i}`));
    const d = render(result([ticketsWith(notes)]));
    expect(headline(d)).toBe("Records restored — 13 request(s) restored under a new number");
    const block = byTestId(d, "restore-renumbered")[0];
    expect(block.querySelector(":scope > ul")!.querySelectorAll("li")).toHaveLength(10);
    const all = byTestId(d, "restore-renumbered-all")[0];
    expect(flat(all.querySelector("summary")!.textContent)).toBe("and 3 more — show all 13");
    expect(Array.from(all.querySelectorAll("li")).map((li) => li.getAttribute("data-renumbered-to"))).toEqual(notes.map((_, i) => `NEW-${i}`));
  });

  it("an entry the database did not confirm (a write with no count) is said as NOT confirmed, never as restored", async () => {
    db.rows.tickets = [ticket("t-live-1", "KE-DDRT-26-0007", ORG)];
    db.countless = true;
    const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b-1", "KE-DDRT-26-0007")], idRemap: REMAP });
    expect(r.renumbered).toEqual([expect.objectContaining({ id: "t-b-1", from: "KE-DDRT-26-0007", unconfirmed: true })]);
    const d = render(asRun(r));
    const [line] = lines(d);
    expect(line).toMatchObject({ from: "KE-DDRT-26-0007", unconfirmed: true });
    expect(line.text).toBe(`sent as ${String(line.to)} — KE-DDRT-26-0007 was taken (request t-live-1 has it); not confirmed as restored`);
    expect(line.text).not.toMatch(/^restored as/);
    expect(flat(byTestId(d, "restore-renumbered-unconfirmed")[0].textContent)).toMatch(/1 request\(s\) sent under a new number but NOT confirmed as restored/);
    expect(byTestId(d, "restore-renumbered")).toHaveLength(0);
    // the uncounted write heads the panel as before; the renumbering is not said as restored anywhere
    expect(headline(d)).toBe("Restored — 1 record(s) the server did not count");
    expect(body(d)).not.toMatch(/restored under a new number|restored as/);
  });

  it("…and with no uncounted row ahead of it in the headline, the headline says it is not confirmed", () => {
    const [note] = unconfirmedRenumberings([renumberNote("t-1", "KE-1", "KE-2", "h")]);
    const d = render(result([ticketsWith([note], { inserted: 4 })]));
    expect(headline(d)).toBe("Records restored — 1 request(s) sent under a new number, not confirmed as restored");
  });

  it("a renumbering note whose numbers cannot be read is never dropped, never counted as a pointer, never said as restored; the headline and its block say the same", () => {
    const bare: RestoreRowRefusal = { id: "t-x", code: TICKET_RENUMBERED, message: "ticket_id renumbered" };
    const d = render(result([ticketsWith([bare])]));
    expect(headline(d)).toBe("Records restored — 1 request(s) given a new number that this page could not read");
    // the only renumbering: no "more" with nothing above it
    expect(flat(byTestId(d, "restore-renumbered-unread")[0].textContent)).toBe("tickets: 1 request(s) given a new number that this page could not read — each is named, with its old and new number, in the audit log's RESTORE_CHUNK rows.");
    expect(body(d)).not.toMatch(/pointer|not confirmed|restored under a new number/);
  });

  it("an unreadable note beside listed renumberings: 'more' after the listed lines, and the headline counts each kind apart", () => {
    const bare: RestoreRowRefusal = { id: "t-x", code: TICKET_RENUMBERED, message: "ticket_id renumbered" };
    const [unconf] = unconfirmedRenumberings([renumberNote("t-2", "KE-3", "KE-4", "h2")]);
    const d = render(result([ticketsWith([renumberNote("t-1", "KE-1", "KE-2", "h"), unconf, bare, personCleared("t-5")])]));
    expect(headline(d)).toBe("Records restored — 1 pointer(s) cleared · 1 request(s) restored under a new number · 1 request(s) sent under a new number, not confirmed as restored · 1 request(s) given a new number that this page could not read");
    expect(flat(byTestId(d, "restore-renumbered-unread")[0].textContent)).toBe("tickets: 1 more request(s) given a new number that this page could not read — each is named, with its old and new number, in the audit log's RESTORE_CHUNK rows.");
    expect(lines(d).map((l) => [l.from, l.unconfirmed])).toEqual([["KE-1", false], ["KE-3", true]]);
  });

  it("a headline that outranks it (rows refused) is unchanged, and the renumbering still has its line", () => {
    const run = result([ticketsWith([renumberNote("t-1", "KE-1", "KE-2", "h")], { refused: [refusal("t-9", "23505")] })]);
    const d = render(run);
    expect(headline(d)).toBe("Records restored — 1 row(s) refused");
    expect(lines(d).map((l) => l.text)).toEqual(["restored as KE-2 — KE-1 was taken (request h has it)"]);
    expect(body(d)).toContain("tickets: 1 row(s) refused — a unique key it carries is already in use (see the audit log's RESTORE_CHUNK rows for each id).");
  });
});

describe("BKP-16 (2) — the two request-number refusals in words a plant admin understands, naming the number and what to do", () => {
  it(`${TICKET_NUMBER_IN_USE}: names the number (the refusal's ticketNumber) and says a re-run gives it a new number`, async () => {
    db.rows.ticket_number_counters = [{ org_id: ORG, year: 2026, next_seq: 5 }];
    const sb = { from: (t: string) => {
      const b = from(t) as Record<string, (...a: unknown[]) => unknown>;
      if (t === "ticket_number_counters") { const origEq = b.eq; b.eq = (c: unknown, v: unknown) => (c === "next_seq" ? origEq(c, -1) : origEq(c, v)); }
      return b;
    } };
    const r = await applyRestoreChunk(sb as never, { orgId: ORG, table: "tickets", rows: [ticket("t-b-1", "KE-DDRT-26-0007"), ticket("t-b-2", "KE-DDRT-26-0007")], idRemap: REMAP });
    expect(r.refused).toEqual([expect.objectContaining({ id: "t-b-2", code: TICKET_NUMBER_IN_USE, ticketNumber: "KE-DDRT-26-0007" })]);
    const d = render(asRun(r));
    const block = flat(byTestId(d, "restore-number-in-use")[0].textContent);
    expect(block).toBe("tickets: 1 request(s) NOT restored — another request here already has the number, and the restore could not take a new number for it this time. Run the restore again: a re-run gives each one a new number (records already restored are skipped, not duplicated).KE-DDRT-26-0007 (request t-b-2)");
    // not repeated under the generic refused line; the headline count is as before
    expect(body(d)).not.toMatch(/row\(s\) refused —/);
    expect(headline(d)).toBe("Records restored — 1 row(s) refused");
  });

  it(`${TICKET_NUMBER_UNSETTLED}: names the number and says the duplicates must be resolved first; the database's own refusals keep their generic line`, async () => {
    const carriers = Array.from({ length: RESTORE_HELD_BACK_ROUNDS + 2 }, (_, i) => ticket(`t-c-${String(i).padStart(2, "0")}`, "LEGACY-1"));
    const doomed = new Set(carriers.slice(0, RESTORE_HELD_BACK_ROUNDS + 1).map((t) => String(t.id)));
    db.writeError = (tb, op, rows) => (tb === "tickets" && op === "upsert" && rows.some((x) => doomed.has(String(x.id))) ? { code: "23514", message: "refused by a check" } : null);
    const r = await applyRestoreChunk({ from } as never, { orgId: ORG, table: "tickets", rows: [ticket("t-plain", "KE-DDRT-26-0001"), ...carriers], idRemap: REMAP });
    const unsettled = r.refused.filter((x) => x.code === TICKET_NUMBER_UNSETTLED);
    expect(unsettled).toEqual([expect.objectContaining({ id: `t-c-${RESTORE_HELD_BACK_ROUNDS + 1}`, ticketNumber: "LEGACY-1" })]);
    const d = render(asRun(r));
    const block = flat(byTestId(d, "restore-number-unsettled")[0].textContent);
    expect(block).toMatch(/^tickets: 1 request\(s\) NOT restored — several requests in this backup carry the same number, and every one of them tried first was refused or not written, so the restore could not tell which should keep it\. Resolve the duplicates first: fix what kept the other requests carrying the number from being written \(see the refused and not-restored lines above and the audit log's RESTORE_CHUNK rows\), then run the restore again\./);
    expect(block).not.toMatch(/listed here/);
    expect(block).toMatch(/then run the restore again\.LEGACY-1 \(request t-c-17\)$/);
    // the 17 database refusals (23514) are on the generic line, exactly as before
    expect(body(d)).toContain(`tickets: ${RESTORE_HELD_BACK_ROUNDS + 1} row(s) refused — refused by a database check (see the audit log's RESTORE_CHUNK rows for each id).`);
    expect(headline(d)).toBe(`Records restored — ${RESTORE_HELD_BACK_ROUNDS + 2} row(s) refused`);
  });

  it("a refusal without a number (an older server) still says what to do, naming the request", () => {
    const d = render(result([table("tickets", { rows: 1, refused: [{ id: "t-1", code: TICKET_NUMBER_IN_USE, message: "x" }] })]));
    expect(flat(byTestId(d, "restore-number-in-use")[0].textContent)).toMatch(/Run the restore again: a re-run gives each one a new number .*a request \(request t-1\)$/);
  });
});

describe("BKP-16 — where the panel lives", () => {
  it("page.tsx renders the moved panel (one copy, no second panel in the page)", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/restore/page.tsx"), "utf8");
    expect(page).toContain('import { RestoreResultPanel, fmtNum } from "./RestoreResultPanel";');
    expect(page).toContain("<RestoreResultPanel result={applyResult} />");
    expect(page).not.toMatch(/function RestoreResultPanel\(/);
  });
});
