// document-control Round F wave 3 — P14 RECORDS & REVIEW REMAINDERS:
// roles-and-permissions GAP-9's remainder, field-verification CURRENCY.
//
//   LIFE-10 already shows when a document was last field-verified, against
//   which revision, and that a later discrepancy superseded it (the banner in
//   CheckoutHistoryPanel). The remainder: "a staleness state derived from a
//   configurable interval", reusing the review-cycle pattern, rendered beside
//   AckPill / ReviewPill / EffectivePill — and no third currency
//   implementation. The cadence rides the review policies
//   (`fieldVerifyIntervalCount` / `fieldVerifyIntervalUnit`), resolved ON ITS
//   OWN by resolveVerificationPolicy — the most specific level that DEFINES
//   one (P14 review fix: a document's own review cycle no longer drops its
//   folder's cadence) — the verdict is reviewStatusFor's, and every read is
//   checked: a failed read is `unknown`, never "never verified".

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
          for (const m of ["select", "eq", "in", "is", "or", "order", "limit", "range"]) chain[m] = () => chain;
          chain.maybeSingle = async () => answer;
          chain.then = (res: (v: unknown) => unknown) => Promise.resolve(answer).then(res);
          return chain;
        }
        return base.from(t);
      },
    };
  },
}));
vi.mock("@/lib/acknowledgments", () => ({ getAckSummaries: vi.fn(async () => new Map()), ackStatusFor: () => "none" }));
vi.mock("@/lib/reviewControl", () => ({ getReviewSummaries: vi.fn(async () => new Map()) }));
vi.mock("@/lib/ownership", () => ({
  resolveEffectiveOwner: () => ({ userId: null, name: null, source: null }),
  teamSupervisorMap: vi.fn(async () => new Map()),
}));
vi.mock("@/lib/inAppNotifications", () => ({ notify: vi.fn() }));

import {
  summarizeFieldVerification, loadFieldVerification, computeNextVerificationDate, verificationPillText, verificationPillTitle,
  resolveVerificationPolicy, decidesVerificationCadence,
  type FieldOutcomeRow,
} from "@/lib/reviewCycles";
import { loadDocControlRegister, registerToCsv, fieldVerificationCsv } from "@/lib/docControlRegister";
import type { ReviewPolicy } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const T = (t: string) => (state.db.tables[t] ??= []);
const ORG = "o1";
/** An ISO timestamp `days` days ago (noon, so the calendar day is unambiguous). */
const daysAgo = (days: number) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - days); return d.toISOString(); };
const EVERY_3Y: ReviewPolicy = { enabled: true, intervalCount: 12, intervalUnit: "months", leadDays: 30, fieldVerifyIntervalCount: 3, fieldVerifyIntervalUnit: "years" };
const verified = (at: string, rev = "2", by = "Walt Walker"): FieldOutcomeRow => ({ outcome: "field_verified", ended_at: at, user_name: by, outcome_ref: { rev } });
const discrepancy = (at: string, by = "Dee Discrepancy"): FieldOutcomeRow => ({ outcome: "discrepancy", ended_at: at, user_name: by, outcome_ref: null });

beforeEach(() => {
  state.db = newFakeDb();
  state.failRead = null;
});

describe("GAP-9 — the currency is the review-cycle rule applied to the walkdown cadence", () => {
  it("current / due soon / overdue from the last verification + the policy's cadence and lead days; the facts ride along", () => {
    const cur = summarizeFieldVerification([verified(daysAgo(365), "3", "Ann")], EVERY_3Y);
    expect(cur).toMatchObject({ status: "current", rev: "3", by: "Ann", supersededBy: null, cadence: "Every 3 years" });
    expect(cur?.nextVerificationDate).toBe(computeNextVerificationDate(cur!.verifiedAt, EVERY_3Y));
    const threeYears = Math.round((Date.now() - new Date(new Date().setFullYear(new Date().getFullYear() - 3)).getTime()) / 86_400_000);
    expect(summarizeFieldVerification([verified(daysAgo(threeYears - 10))], EVERY_3Y)?.status).toBe("due_soon");
    expect(summarizeFieldVerification([verified(daysAgo(threeYears + 10))], EVERY_3Y)?.status).toBe("overdue");
    // the policy's own lead window decides "due soon"
    expect(summarizeFieldVerification([verified(daysAgo(threeYears - 10))], { ...EVERY_3Y, leadDays: 5 })?.status).toBe("current");
  });

  it("a cadence and no walkdown ever is 'never verified'; no cadence and no walkdown says nothing; a walkdown without a cadence is just 'verified'", () => {
    expect(summarizeFieldVerification([], EVERY_3Y)).toMatchObject({ status: "never", verifiedAt: null, nextVerificationDate: null });
    expect(summarizeFieldVerification([], null)).toBeNull();
    expect(summarizeFieldVerification([], { enabled: true, intervalCount: 12, intervalUnit: "months" })).toBeNull();
    expect(summarizeFieldVerification([verified(daysAgo(2000))], null)).toMatchObject({ status: "verified", cadence: null, nextVerificationDate: null });
    // an opted-out policy carries no cadence
    expect(summarizeFieldVerification([verified(daysAgo(10))], { ...EVERY_3Y, enabled: false })?.status).toBe("verified");
  });

  it("a discrepancy AFTER the last verification supersedes it (acceptance 2), whatever the cadence; a later walkdown supersedes the discrepancy", () => {
    const rows = [verified(daysAgo(30), "2", "Ann"), discrepancy(daysAgo(10), "Dee")];
    expect(summarizeFieldVerification(rows, EVERY_3Y)).toMatchObject({ status: "discrepancy", by: "Ann", supersededBy: { by: "Dee" } });
    expect(summarizeFieldVerification(rows, null)?.status).toBe("discrepancy");
    expect(summarizeFieldVerification([discrepancy(daysAgo(10))], null)).toMatchObject({ status: "discrepancy", verifiedAt: null });
    // an older discrepancy, then a fresh walkdown: current again
    expect(summarizeFieldVerification([discrepancy(daysAgo(40)), verified(daysAgo(5))], EVERY_3Y)?.status).toBe("current");
    // other outcomes are not walkdowns
    expect(summarizeFieldVerification([{ outcome: "all_clear", ended_at: daysAgo(1) }], null)).toBeNull();
  });

  it("P14 review fix — the cadence is resolved ON ITS OWN: the most specific level that DEFINES one wins; a level with only a review cycle defers; enabled:false stops inheritance", () => {
    const ownCycle: ReviewPolicy = { enabled: true, intervalCount: 12, intervalUnit: "months" };
    const folder3y: ReviewPolicy = { enabled: true, intervalCount: 24, intervalUnit: "months", leadDays: 60, fieldVerifyIntervalCount: 3, fieldVerifyIntervalUnit: "years" };
    const lib1y: ReviewPolicy = { enabled: true, fieldVerifyIntervalCount: 1, fieldVerifyIntervalUnit: "years" };
    // the drawing given its own 12-month review cycle in the inspector keeps the folder's walkdown cadence (and its lead days)
    expect(resolveVerificationPolicy(ownCycle, folder3y, lib1y)).toBe(folder3y);
    expect(resolveVerificationPolicy(ownCycle, { enabled: true, intervalCount: 6, intervalUnit: "months" }, lib1y)).toBe(lib1y);
    expect(resolveVerificationPolicy({ ...ownCycle, fieldVerifyIntervalCount: 90, fieldVerifyIntervalUnit: "days" }, folder3y, lib1y)?.fieldVerifyIntervalCount).toBe(90);
    // an explicit opt-out at a more specific level stops inheritance, as for the cycle
    expect(resolveVerificationPolicy({ enabled: false }, folder3y, lib1y)).toBeNull();
    expect(resolveVerificationPolicy(null, { enabled: false }, lib1y)).toBeNull();
    expect(resolveVerificationPolicy(null, null, null)).toBeNull();
    expect(decidesVerificationCadence(ownCycle)).toBe(false);
    expect(decidesVerificationCadence({ enabled: false })).toBe(true);
    expect(decidesVerificationCadence(folder3y)).toBe(true);
    // the reviewer's case: a 2019 walkdown under the folder's 3-year rule is OVERDUE, not plain "Field-verified"
    const v = summarizeFieldVerification([verified("2019-05-01T12:00:00.000Z")], resolveVerificationPolicy(ownCycle, folder3y, null));
    expect(v).toMatchObject({ status: "overdue", cadence: "Every 3 years" });
    expect(verificationPillText(v!).tone).toBe("bad");
  });

  it("no third currency implementation: the verdict is reviewStatusFor's, the due date addInterval's, the cadence words describeInterval's", () => {
    const lib = src("lib/reviewCycles.ts");
    const fn = lib.slice(lib.indexOf("export function summarizeFieldVerification("), lib.indexOf("/** The currency when it could not be read"));
    expect(fn).toContain("else status = reviewStatusFor(next, policy?.leadDays ?? 30) as FieldVerificationStatus;");
    expect(fn).not.toMatch(/86_400_000|getTime\(\)/);
    expect(lib).toContain("return addInterval(lastVerifiedISO, policy.fieldVerifyIntervalCount!, policy.fieldVerifyIntervalUnit!);");
    expect(lib).toContain("return describeInterval({ enabled: true, intervalCount: p.fieldVerifyIntervalCount, intervalUnit: p.fieldVerifyIntervalUnit });");
  });

  it("the words: every state says what it is, and the hover names who, when and against which revision", () => {
    const v = summarizeFieldVerification([verified(daysAgo(30), "4", "Ann"), discrepancy(daysAgo(3), "Dee")], EVERY_3Y)!;
    expect(verificationPillText(v)).toMatchObject({ short: "Discrepancy", tone: "bad" });
    expect(verificationPillTitle(v)).toMatch(/^Last field-verified against Rev 4 on \d{4}-\d{2}-\d{2} by Ann\. Superseded by a field discrepancy reported by Dee on /);
    expect(verificationPillText(summarizeFieldVerification([], EVERY_3Y)!)).toMatchObject({ full: "Never field-verified", tone: "warn" });
    expect(verificationPillText({ ...v, status: "unknown" })).toMatchObject({ full: "Field verification unknown", tone: "neutral" });
  });
});

describe("GAP-9 — one document's currency is read CHECKED (the inspector's pill)", () => {
  const seedDoc = (extra: Row = {}) => {
    T("checkout_sessions").push({ id: "s1", org_id: ORG, document_id: "d1", outcome: "field_verified", ended_at: daysAgo(100), user_name: "Ann", outcome_ref: { rev: "2" } });
    T("checkout_sessions").push({ id: "s2", org_id: ORG, document_id: "d1", outcome: "all_clear", ended_at: daysAgo(5), user_name: "Bob", outcome_ref: null });
    T("libraries").push({ id: "L1", org_id: ORG, review_policy: EVERY_3Y, ...extra });
    T("collections").push({ id: "C1", org_id: ORG, review_policy: { enabled: true, fieldVerifyIntervalCount: 30, fieldVerifyIntervalUnit: "days" } });
  };

  it("the library's cadence applies through an empty folder; a folder's own policy wins without reading the library; the document's own wins outright", async () => {
    seedDoc();
    expect(await loadFieldVerification({ id: "d1", libraryId: "L1" })).toMatchObject({ status: "current", rev: "2", by: "Ann", cadence: "Every 3 years" });
    expect(await loadFieldVerification({ id: "d1", collectionId: "C1", libraryId: "L1" })).toMatchObject({ status: "overdue", cadence: "Every 30 days" });
    state.failRead = "libraries";
    expect((await loadFieldVerification({ id: "d1", collectionId: "C1", libraryId: "L1" }))?.status).toBe("overdue");
    expect(await loadFieldVerification({ id: "d1", reviewPolicy: { enabled: false }, libraryId: "L1" })).toMatchObject({ status: "verified", cadence: null });
  });

  it("P14 review fix — a document with its OWN review cycle (no cadence) still reads and applies the inherited cadence; an unreadable inherited level is unknown for it too", async () => {
    seedDoc();
    T("checkout_sessions").push({ id: "s0", org_id: ORG, document_id: "d2", outcome: "field_verified", ended_at: "2019-05-01T12:00:00.000Z", user_name: "Ann", outcome_ref: { rev: "1" } });
    const own: ReviewPolicy = { enabled: true, intervalCount: 12, intervalUnit: "months" };
    expect(await loadFieldVerification({ id: "d2", reviewPolicy: own, libraryId: "L1" })).toMatchObject({ status: "overdue", cadence: "Every 3 years", rev: "1" });
    expect(await loadFieldVerification({ id: "d2", reviewPolicy: own, collectionId: "C1", libraryId: "L1" })).toMatchObject({ status: "overdue", cadence: "Every 30 days" });
    state.failRead = "libraries";
    expect(await loadFieldVerification({ id: "d2", reviewPolicy: own, libraryId: "L1" })).toMatchObject({ status: "unknown", rev: "1" });
    // a document whose own policy sets a cadence reads nothing above it
    expect(await loadFieldVerification({ id: "d2", reviewPolicy: { ...own, fieldVerifyIntervalCount: 10, fieldVerifyIntervalUnit: "years" }, libraryId: "L1" })).toMatchObject({ status: "current", cadence: "Every 10 years" });
  });

  it("a failed register read is UNKNOWN (never 'never verified'); a failed inherited policy read is unknown with the facts it did read", async () => {
    seedDoc();
    state.failRead = "checkout_sessions";
    expect(await loadFieldVerification({ id: "d1", libraryId: "L1" })).toMatchObject({ status: "unknown", unknownReason: "the check-in register could not be read (statement timeout)", verifiedAt: null });
    state.failRead = "libraries";
    expect(await loadFieldVerification({ id: "d1", libraryId: "L1" })).toMatchObject({ status: "unknown", rev: "2", by: "Ann", unknownReason: "the library's review policy could not be read (statement timeout)" });
    state.failRead = "collections";
    expect((await loadFieldVerification({ id: "d1", collectionId: "C1", libraryId: "L1" }))?.status).toBe("unknown");
  });
});

describe("GAP-9 — the register shows it beside the other pills and hands it to the auditor", () => {
  const doc = (id: string, extra: Row = {}) => T("documents").push({
    id, org_id: ORG, library_id: "L1", collection_id: null, status: null, document_number: id.toUpperCase(), title: null, name: null,
    rev: "3", updated_at: "2026-09-01T00:00:00Z", owner_user_id: null, owner_name: null, next_review_date: null, pending_version_id: null,
    effective_date: null, retention_until: null, disposition_state: null, legal_hold: false, retention_policy: null, review_policy: null,
    origin: null, external_source: null, external_reference: null, current_version_id: `${id}-v`, ...extra,
  });
  const session = (id: string, documentId: string, outcome: string, at: string, rev: string | null = "3") =>
    T("checkout_sessions").push({ id, org_id: ORG, document_id: documentId, outcome, ended_at: at, user_name: "Ann", outcome_ref: rev ? { rev } : null });
  beforeEach(() => {
    T("libraries").push({ id: "L1", org_id: ORG, name: "P&IDs", retention_policy: null, review_policy: EVERY_3Y });
    T("collections");
    T("org_members");
    T("distribution_acks");
  });

  it("each row carries the currency from the EFFECTIVE review policy: current, never, a discrepancy, a document's own opt-out", async () => {
    doc("fresh"); session("s1", "fresh", "field_verified", daysAgo(20));
    doc("never");
    doc("flagged"); session("s2", "flagged", "field_verified", daysAgo(40)); session("s3", "flagged", "discrepancy", daysAgo(4));
    doc("own-off", { review_policy: { enabled: false } });
    // P14 review fix: its own 12-month review cycle (set in the inspector) keeps the library's 3-year walkdown cadence
    doc("own-cycle", { review_policy: { enabled: true, intervalCount: 12, intervalUnit: "months" } }); session("s4", "own-cycle", "field_verified", "2019-05-01T12:00:00.000Z");
    const byId = new Map((await loadDocControlRegister(ORG)).rows.map((r) => [r.id, r]));
    expect(byId.get("fresh")?.fieldVerification).toMatchObject({ status: "current", rev: "3" });
    expect(byId.get("never")?.fieldVerification).toMatchObject({ status: "never" });
    expect(byId.get("flagged")?.fieldVerification).toMatchObject({ status: "discrepancy" });
    expect(byId.get("own-off")?.fieldVerification).toBeNull();
    expect(byId.get("own-cycle")?.fieldVerification).toMatchObject({ status: "overdue", cadence: "Every 3 years" });
  });

  it("the register read is PAGED — a verification past PostgREST's row cap is still found (never 'never verified')", async () => {
    state.db.maxRows = 1000;
    doc("busy");
    for (let i = 0; i < 1000; i++) session(`b${i}`, "busy", "field_verified", daysAgo(1));
    doc("old"); session("o1", "old", "field_verified", daysAgo(400));
    const byId = new Map((await loadDocControlRegister(ORG)).rows.map((r) => [r.id, r]));
    expect(byId.get("old")?.fieldVerification).toMatchObject({ status: "current" });
    expect(state.db.calls.filter((c) => c.table === "checkout_sessions" && c.method === "range").length).toBe(2);
  });

  it("a failed register read or an unreadable inherited policy is UNKNOWN on every affected row — and says so in the CSV", async () => {
    doc("a"); session("s1", "a", "field_verified", daysAgo(20));
    state.failRead = "checkout_sessions";
    let rows = (await loadDocControlRegister(ORG)).rows;
    expect(rows[0].fieldVerification).toMatchObject({ status: "unknown" });
    expect(registerToCsv(rows).split("\n")[1]).toContain("Field verification unknown. No field verification on record. Currency unknown: the check-in register could not be read (statement timeout).");
    state.failRead = "libraries";
    rows = (await loadDocControlRegister(ORG)).rows;
    expect(rows[0].fieldVerification).toMatchObject({ status: "unknown", unknownReason: "the review policy could not be read" });
    // P14 review fix: a document's own review cycle without a cadence still inherits it — so an unreadable library is unknown for it too;
    // one whose own policy sets the cadence (or opts out) is decided without the library
    state.db.tables.documents = [];
    doc("own-cycle", { review_policy: { enabled: true, intervalCount: 12, intervalUnit: "months" } });
    doc("own-cadence", { review_policy: { enabled: true, fieldVerifyIntervalCount: 5, fieldVerifyIntervalUnit: "years" } });
    session("s5", "own-cadence", "field_verified", daysAgo(20));
    const byId = new Map((await loadDocControlRegister(ORG)).rows.map((r) => [r.id, r]));
    expect(byId.get("own-cycle")?.fieldVerification).toMatchObject({ status: "unknown" });
    expect(byId.get("own-cadence")?.fieldVerification).toMatchObject({ status: "current", cadence: "Every 5 years" });
  });

  it("the CSV's last column carries the pill's words and the facts", async () => {
    doc("fresh"); session("s1", "fresh", "field_verified", daysAgo(20));
    const { rows } = await loadDocControlRegister(ORG);
    const lines = registerToCsv(rows).split("\n");
    expect(lines[0].split(",").pop()).toBe("Field verification");
    expect(lines[1]).toContain(fieldVerificationCsv(rows[0].fieldVerification).split(",")[0]);
    expect(fieldVerificationCsv(rows[0].fieldVerification)).toMatch(/^Field-verified · current to \d{4}-\d{2}-\d{2}\. Last field-verified against Rev 3 on \d{4}-\d{2}-\d{2} by Ann\. Verification cadence: every 3 years — current to /);
    expect(fieldVerificationCsv(null)).toBe("");
  });
});

describe("GAP-9 — rendered beside the other pills, set in the review policy, one derivation", () => {
  it("the inspector loads it CHECKED and renders VerificationPill beside ReviewPill; the register renders it beside AckPill", () => {
    const i = src("components/documents/InspectorPanel.tsx");
    expect(i).toContain("const v = await loadFieldVerification({ id: selectedDoc.id, reviewPolicy: selectedDoc.reviewPolicy ?? null, collectionId: selectedDoc.collectionId ?? null, libraryId: selectedDoc.libraryId });");
    expect(i).toMatch(/<ReviewPill nextReviewDate=\{selectedDoc\.nextReviewDate\} compact \/>\s*\n\s*<VerificationPill verification=\{fieldVerification\} compact \/>/);
    expect(i).toContain("setFieldVerification(unknownFieldVerification(");
    const r = src("app/(protected)/register/page.tsx");
    expect(r).toMatch(/<AckPill summary=\{r\.ack\} compact \/>[^\n]*\n\s*<td className="px-3 py-2">\{r\.fieldVerification \? <VerificationPill verification=\{r\.fieldVerification\} compact \/>/);
  });

  it("the banner and the pill share ONE derivation (the banner's own copy is gone); the policy editor sets the cadence", () => {
    const h = src("components/documents/CheckoutHistoryPanel.tsx");
    expect(h).toContain("const v = summarizeFieldVerification((data ?? []) as FieldOutcomeRow[], null);");
    expect(h).not.toMatch(/const later = rows\.find/);
    const m = src("components/documents/ReviewPolicyModal.tsx");
    expect(m).toContain("...(enabled && verifyOn ? { fieldVerifyIntervalCount: verifyCount, fieldVerifyIntervalUnit: verifyUnit } : {}),");
    expect(m).toContain("setVerifyOn(!!p.fieldVerifyIntervalCount && !!p.fieldVerifyIntervalUnit);");
    expect(src("types/schema.ts")).toMatch(/fieldVerifyIntervalCount\?: number;\n\s*fieldVerifyIntervalUnit\?: "days" \| "months" \| "years";/);
  });
});
