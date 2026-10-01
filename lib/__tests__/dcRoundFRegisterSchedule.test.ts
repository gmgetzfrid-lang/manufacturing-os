// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS: RET-11's
// register column. The master register names each record's scheduled
// end-of-life action from its EFFECTIVE retention policy (document → folder →
// library, P9's resolver and P9's label), says "unknown" — never "no
// schedule" — when an inherited policy could not be read, and carries it in
// the CSV an auditor is handed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newFakeDb, makeFakeSupabase, type FakeDb, type Row } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  failRead: null as null | string,
}));

vi.mock("@/lib/supabase", () => ({
  get supabase() {
    const base = makeFakeSupabase(state.db);
    return {
      ...base,
      from: (t: string) => {
        if (state.failRead === t) {
          const answer = { data: null, error: { message: "statement timeout" } };
          const chain: Record<string, unknown> = {};
          for (const m of ["select", "eq", "in", "is", "or", "order", "limit"]) chain[m] = () => chain;
          chain.then = (res: (v: unknown) => unknown) => Promise.resolve(answer).then(res);
          return chain;
        }
        return base.from(t);
      },
    };
  },
}));
vi.mock("@/lib/acknowledgments", () => ({
  getAckSummaries: vi.fn(async () => new Map()),
  ackStatusFor: () => "none",
}));
vi.mock("@/lib/reviewControl", () => ({ getReviewSummaries: vi.fn(async () => new Map()) }));
vi.mock("@/lib/ownership", () => ({
  resolveEffectiveOwner: () => ({ userId: null, name: null, source: null }),
  teamSupervisorMap: vi.fn(async () => new Map()),
}));

import { loadDocControlRegister, registerToCsv } from "@/lib/docControlRegister";

const ORG = "o1";
const T = (t: string) => (state.db.tables[t] ??= []);
const P = (p: Row) => ({ enabled: true, years: 7, basis: "issued", ...p });

/** A controlled document (status NULL — a controlled record, as the loader reads it). */
function doc(id: string, extra: Row = {}) {
  T("documents").push({
    id, org_id: ORG, library_id: "L1", collection_id: null, status: null, document_number: id.toUpperCase(), title: null, name: null,
    rev: "1", updated_at: "2026-09-01T00:00:00Z", owner_user_id: null, owner_name: null, next_review_date: null, pending_version_id: null,
    effective_date: null, retention_until: null, disposition_state: null, legal_hold: false, retention_policy: null,
    origin: null, external_source: null, external_reference: null, current_version_id: `${id}-v1`, ...extra,
  });
}
const byId = async () => new Map((await loadDocControlRegister(ORG)).rows.map((r) => [r.id, r]));

beforeEach(() => {
  state.db = newFakeDb();
  state.failRead = null;
  T("libraries").push({ id: "L1", org_id: ORG, name: "P&IDs", retention_policy: P({ action: "destroy" }) });
  T("libraries").push({ id: "L2", org_id: ORG, name: "Procedures", retention_policy: null });
  T("collections").push({ id: "C-archive", org_id: ORG, retention_policy: P({ years: 10, action: "archive" }) });
  T("collections").push({ id: "C-off", org_id: ORG, retention_policy: { enabled: false } });
  T("collections").push({ id: "C-none", org_id: ORG, retention_policy: null });
  T("org_members");
  T("distribution_acks");
});

describe("RET-11 — the register surfaces the scheduled end-of-life action", () => {
  it("names the EFFECTIVE policy's action: the library's, a folder's over it, the document's own over both; a disabled folder stops inheritance; no policy (or no length) is none", async () => {
    doc("lib");
    doc("folder", { collection_id: "C-archive" });
    doc("own", { collection_id: "C-archive", retention_policy: P({ years: 3, action: "review" }) });
    doc("off", { collection_id: "C-off" });
    doc("inherit-through-empty-folder", { collection_id: "C-none" });
    doc("none", { library_id: "L2" });
    doc("no-length", { library_id: "L2", retention_policy: { enabled: true, basis: "created", action: "destroy" } });
    const rows = await byId();
    expect(rows.get("lib")).toMatchObject({ scheduledAction: "destroy", scheduledActionLabel: "destroy", retentionSchedule: "Retain 7 years from issued, then destroy", retentionScheduleUnknown: false });
    expect(rows.get("folder")).toMatchObject({ scheduledAction: "archive", retentionSchedule: "Retain 10 years from issued, then archive" });
    expect(rows.get("own")).toMatchObject({ scheduledAction: "review", scheduledActionLabel: "flag for review", retentionSchedule: "Retain 3 years from issued, then flag for review" });
    expect(rows.get("off")).toMatchObject({ scheduledAction: null, scheduledActionLabel: null, retentionSchedule: null, retentionScheduleUnknown: false });
    expect(rows.get("inherit-through-empty-folder")).toMatchObject({ scheduledAction: "destroy" });
    expect(rows.get("none")).toMatchObject({ scheduledAction: null, retentionSchedule: null });
    expect(rows.get("no-length")).toMatchObject({ scheduledAction: null });
  });

  it("an unreadable library or folder policy makes an INHERITED schedule unknown — never 'no schedule'; a record's own policy, or a defined folder policy, still answers", async () => {
    doc("lib");
    doc("own", { retention_policy: P({ action: "archive" }) });
    state.failRead = "libraries";
    let rows = await byId();
    expect(rows.get("lib")).toMatchObject({ scheduledAction: null, retentionScheduleUnknown: true });
    expect(rows.get("own")).toMatchObject({ scheduledAction: "archive", retentionScheduleUnknown: false });
    state.db = newFakeDb();
    T("libraries").push({ id: "L1", org_id: ORG, name: "P&IDs", retention_policy: P({ action: "destroy" }) });
    doc("in-folder", { collection_id: "C-archive" });
    doc("at-root");
    state.failRead = "collections";
    rows = await byId();
    expect(rows.get("in-folder")).toMatchObject({ retentionScheduleUnknown: true, scheduledAction: null });
    expect(rows.get("at-root")).toMatchObject({ retentionScheduleUnknown: false, scheduledAction: "destroy" });
  });

  it("the CSV an auditor is handed carries the schedule column (and 'unknown' — never blank — when it could not be read)", async () => {
    doc("lib");
    doc("none", { library_id: "L2" });
    const { rows } = await loadDocControlRegister(ORG);
    const lines = registerToCsv(rows).split("\n");
    // the schedule column (GAP-9's field-verification column follows it)
    expect(lines[0].split(",").slice(-2)).toEqual(["Scheduled end of life", "Field verification"]);
    const csvFor = (id: string) => lines[1 + rows.findIndex((r) => r.id === id)];
    expect(csvFor("lib")).toMatch(/,"Retain 7 years from issued, then destroy",$/); // csvCell quotes the comma; no walkdown, no cadence
    expect(csvFor("none").endsWith(",,")).toBe(true);
    const unknown = registerToCsv([{ ...rows[0], retentionScheduleUnknown: true, retentionSchedule: null }]).split("\n")[1];
    expect(unknown).toContain("unknown (the retention policy could not be read)");
  });

  it("the register page renders the schedule beside the records pill ('then destroy', titled with the full schedule) and 'schedule unknown'", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/register/page.tsx"), "utf8");
    expect(page).toContain("title={r.retentionSchedule ?? undefined}>then {r.scheduledActionLabel}</span>");
    expect(page).toContain(">schedule unknown</span>");
    // the pill is still there for a hold / an eligible record (unchanged)
    expect(page).toContain('<RetentionPill retentionUntil={r.retentionUntil} dispositionState={r.dispositionEligible ? "eligible" : null} legalHold={r.legalHold} compact />');
  });
});
