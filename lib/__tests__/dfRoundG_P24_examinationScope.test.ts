// drafting-flow Round G, DF-P24 EXAMINATION SCOPE DATA AND ISSUE GATE — the
// pure rules (lib/examinationScope.ts), the editor's pure helpers
// (components/requests/ExaminationScopeSection.tsx), and the records-only
// limbs pinned in code:
//   * ruling (1): a workspace's own fields and values; requirements per work
//     class and/or library; an unconfigured workspace is no configuration;
//   * ruling (2): a requirement binds a request filed at least 15 minutes
//     after its `since` (merge-time fix pass: the clock-skew grace) — an
//     in-flight request only warns; a waiver covers the fields it names for
//     the revision it was recorded for;
//   * merge-time fix pass: who fills / changes / clears a field by where the
//     request stands (rulings 1 and 4), the after-issue mark, the history
//     line, and the editor's check — the parser's own rule (ruling 3);
//   * fail-safe readings (ruling (6)): no `since`, an unfillable field, a
//     retired value — never a refusal;
//   * ruling (4) (notify-only limb, NOT built — recorded with an owner): the
//     parser still drops `records_examination` on a notify-only slot, and the
//     editor's hint never steers toward a blocking assurance slot;
//   * ruling (5) (sheets limb): the roster's files carry no sheet data, so
//     the examination record keeps carrying sheets in its note.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseExaminationScopeConfig, examinationScopeConfigured, applicableRequirements, examinationScopeStatus, parseScopeValues, parseScopeWaiver,
  waiverCovers, examinationScopeRefusal, examinationScopeWarning, examinationScopeAuditFields, checkScopeValuesInput, applyScopeChanges,
  scopeEditorBasis, isMissingScopeTable, EXAMINATION_SCOPE_KEY,
  hasBindingRequirement, scopeGateOutcome, examinationScopeHasRequirements, SCOPE_REQUESTER_STATUSES, SCOPE_ISSUED_STATUSES,
  SCOPE_CLOCK_SKEW_GRACE_MS, scopeBindsFrom, scopePhase, scopeFieldRight, checkScopeWrite, scopeValuesAsIssued, examinationScopeHistoryEntry,
  examinationScopeProblems, FIELD_KEY_RE, SCOPE_REVIEW_STATUSES,
} from "@/lib/examinationScope";
import { editorScopeProblems } from "@/components/requests/ExaminationScopeSection";
import { WorkflowEngine, ISSUING_APPROVALS } from "@/lib/workflow";
import { consentHeldAction } from "@/lib/consentWindow";
import { editableScope, optionsToText, textToOptions, editRequirement } from "@/components/requests/ExaminationScopeSection";
import { parseRoutingControl } from "@/lib/routingControl";
import { ASSURANCE_OPT_IN_HINT } from "@/components/documents/RoutingControlSection";
import { buildExaminationRecord } from "@/lib/assuranceExamination";
import type { Ticket } from "@/types/schema";

const LIB = "1b000000-0000-4000-8000-000000000001";
const SINCE = "2026-10-01T00:00:00.000Z";
const CFG = {
  workClasses: { options: [{ value: "code", label: "Code piping" }, { value: "lik", label: "Like in kind" }] },
  [EXAMINATION_SCOPE_KEY]: {
    fields: [
      { key: "exam", label: "Examination scope", options: [{ value: "rt5", label: "5% RT" }, { value: "rt100", label: "100% RT" }] },
      { key: "gov", label: "Governing code", options: [{ value: "c1", label: "Code one" }] },
      { key: "empty", label: "Nothing to pick", options: [] },
    ],
    requirements: [
      { field: "exam", workClass: "code", since: SINCE },
      { field: "gov", libraryId: LIB, since: SINCE },
      { field: "empty", workClass: "code", since: SINCE },
      { field: "missingfield", workClass: "code", since: SINCE },
    ],
  },
};
const ticket = (over: Partial<Ticket> = {}) => ({ workClass: "code", libraryId: LIB, createdAt: "2026-10-05T00:00:00.000Z", ...over }) as Ticket;

describe("ruling (1) — the configuration, in the workspace's own words", () => {
  it("an absent or malformed key is no configuration (today's path)", () => {
    for (const cfg of [null, undefined, {}, { [EXAMINATION_SCOPE_KEY]: null }, { [EXAMINATION_SCOPE_KEY]: [] }, { [EXAMINATION_SCOPE_KEY]: "x" }]) {
      const c = parseExaminationScopeConfig(cfg as never);
      expect(c).toEqual({ fields: [], requirements: [] });
      expect(examinationScopeConfigured(c)).toBe(false);
    }
  });
  it("fields keep their own values; malformed entries are left out, never widened", () => {
    const c = parseExaminationScopeConfig({ [EXAMINATION_SCOPE_KEY]: {
      fields: [{ key: "a", label: "A", options: [{ value: "x" }, { value: "x" }, { value: "" }, 7] }, { key: "a" }, { key: "" }, null],
      requirements: [{ field: "a" }, { field: "a", workClass: "w" }, { workClass: "w" }, "x"],
    } } as never);
    expect(c.fields).toEqual([{ key: "a", label: "A", options: [{ value: "x", label: "x" }] }]);
    // a requirement naming neither a class nor a library applies to nothing
    expect(c.requirements).toEqual([{ field: "a", workClass: "w" }]);
  });
  it("a field with nothing to pick is configured but unfillable — never required", () => {
    const c = parseExaminationScopeConfig(CFG);
    expect(examinationScopeConfigured(c)).toBe(true);
    expect(applicableRequirements(c, ticket()).map((r) => r.field)).toEqual(["exam", "gov"]);
    expect(applicableRequirements(c, ticket({ workClass: "lik" })).map((r) => r.field)).toEqual(["gov"]);
    expect(applicableRequirements(c, ticket({ workClass: null, libraryId: null }))).toEqual([]);
  });
});

describe("ruling (2) — the gate's reading: filed after `since` refuses, in flight warns", () => {
  const c = parseExaminationScopeConfig(CFG);
  it("filed after the requirement: what is missing blocks", () => {
    const s = examinationScopeStatus(c, ticket(), {}, CFG);
    expect(s.blocking.map((b) => b.key)).toEqual(["exam", "gov"]);
    expect(s.warnOnly).toEqual([]);
    expect(examinationScopeRefusal(s.blocking)).toBe("This request can't issue yet: Examination scope and Governing code must be recorded for it first (this workspace requires them for work class \"Code piping\" and its library). The drafter or the engineer records them under \"Examination data\" on the request; someone who can issue it may instead record why it issues without them.");
  });
  it("filed before the requirement (in flight when it was configured): warned, never refused", () => {
    const s = examinationScopeStatus(c, ticket({ createdAt: "2026-09-30T23:59:59.000Z" }), {}, CFG);
    expect(s.blocking).toEqual([]);
    expect(s.warnOnly.map((w) => w.key)).toEqual(["exam", "gov"]);
    expect(examinationScopeWarning(s.warnOnly)).toMatch(/filed before the requirement was set, so it can still issue/);
  });
  it("a requirement with no readable `since`, or a request with no filing time, never refuses", () => {
    const noSince = parseExaminationScopeConfig({ [EXAMINATION_SCOPE_KEY]: { fields: CFG[EXAMINATION_SCOPE_KEY].fields, requirements: [{ field: "exam", workClass: "code" }, { field: "gov", workClass: "code", since: "not a date" }] } });
    expect(examinationScopeStatus(noSince, ticket(), {}).blocking).toEqual([]);
    expect(examinationScopeStatus(c, ticket({ createdAt: undefined as never }), {}).blocking).toEqual([]);
  });
  it("recorded values satisfy it; a value the list has since lost still counts as recorded (it was valid when picked)", () => {
    const vals = parseScopeValues({ exam: { value: "rt5", by: "d-1", at: SINCE }, gov: { value: "retired-code", by: "d-1", at: SINCE } });
    const s = examinationScopeStatus(c, ticket(), vals, CFG);
    expect(s.missing).toEqual([]);
    expect(s.required.find((r) => r.key === "gov")!.valueRetired).toBe(true);
  });
  it("a waiver covers only the fields it names, for the revision it was recorded for", () => {
    const s = examinationScopeStatus(c, ticket(), {}, CFG);
    const w = parseScopeWaiver({ reason: "vendor data due", by: "a-1", at: SINCE, fields: ["exam", "gov"], rev: "1A" });
    expect(waiverCovers(w, s.blocking, "1A")).toBe(true);
    expect(waiverCovers(w, s.blocking, "1B")).toBe(false);
    expect(waiverCovers(parseScopeWaiver({ ...w, fields: ["exam"] }), s.blocking, "1A")).toBe(false);
    expect(waiverCovers(null, s.blocking, "1A")).toBe(false);
    expect(parseScopeWaiver({ reason: "", fields: ["exam"] })).toBeNull();
    expect(parseScopeWaiver({ reason: "x", fields: [] })).toBeNull();
    expect(examinationScopeAuditFields(s, w, true)).toMatchObject({ missing: ["exam", "gov"], waiver: { reason: "vendor data due", rev: "1A" } });
  });
});

describe("filling — picked from the list, never typed free", () => {
  const c = parseExaminationScopeConfig(CFG);
  it("an unknown field or a value not in the list is refused with the reason; null clears", () => {
    expect(checkScopeValuesInput(c, { exam: "rt5" })).toEqual({ ok: true, changes: { exam: "rt5" } });
    expect(checkScopeValuesInput(c, { exam: null })).toEqual({ ok: true, changes: { exam: null } });
    expect(checkScopeValuesInput(c, { exam: "N/A" })).toMatchObject({ ok: false });
    expect(checkScopeValuesInput(c, { nope: "x" })).toMatchObject({ ok: false });
    expect(checkScopeValuesInput(c, {})).toMatchObject({ ok: false });
    expect(checkScopeValuesInput(c, ["exam"])).toMatchObject({ ok: false });
  });
  it("each change carries who and when; an unchanged value keeps its first record", () => {
    const cur = parseScopeValues({ exam: { value: "rt5", by: "e-1", at: "2026-10-02T00:00:00.000Z" } });
    const a = applyScopeChanges(cur, { exam: "rt5", gov: "c1" }, { uid: "d-1", name: "Dee" }, "2026-10-06T00:00:00.000Z");
    expect(a.changed).toEqual(["gov"]);
    expect(a.values.exam.by).toBe("e-1");
    expect(a.values.gov).toEqual({ value: "c1", by: "d-1", byName: "Dee", at: "2026-10-06T00:00:00.000Z" });
    expect(applyScopeChanges(a.values, { gov: null }, { uid: "d-1", name: null }, "x").values.gov).toBeUndefined();
  });
  it("the drafter or engineer already in the flow (or the assignment queue) — the requester only while it is with the drafter", () => {
    const t = { assignedDrafterId: "d-1", assignedEngineerId: "e-1", requesterId: "req-1", status: "PENDING_REVIEW", metadata: { review_roster: { slots: [{ engineering: true, primaries: ["e-2"], alternates: ["e-3"] }, { engineering: false, primaries: ["q-1"] }] } } } as unknown as Ticket;
    expect(scopeEditorBasis(t, "d-1", false)).toBe("drafter");
    expect(scopeEditorBasis(t, "e-1", false)).toBe("engineer");
    expect(scopeEditorBasis(t, "e-2", false)).toBe("roster_engineer");
    expect(scopeEditorBasis(t, "e-3", false)).toBe("roster_engineer");
    expect(scopeEditorBasis(t, "q-1", false)).toBeNull();
    expect(scopeEditorBasis(t, "req-1", false)).toBeNull();
    expect(scopeEditorBasis(t, "sup-1", true)).toBe("assignment_queue");
    expect(scopeEditorBasis(t, null, true)).toBeNull();
    // second fix pass (GAP-102 acceptance 1): the requester records what they
    // already specified while the request is still with the drafter — never
    // once it is under review, issued or closed
    for (const status of ["PENDING_ENG_TEAM", "PENDING_ASSIGNMENT", "DRAFTING", "REVISION_REQ"]) {
      expect(scopeEditorBasis({ ...t, status } as Ticket, "req-1", false), status).toBe("requester");
    }
    for (const status of ["PENDING_REVIEW", "PENDING_FINAL_APPROVAL", "PENDING_IFC", "FINAL_DRAFT", "CLOSED", "CANCELED"]) {
      expect(scopeEditorBasis({ ...t, status } as Ticket, "req-1", false), status).toBeNull();
    }
    expect([...SCOPE_REQUESTER_STATUSES].sort()).toEqual(["DRAFTING", "PENDING_ASSIGNMENT", "PENDING_ENG_TEAM", "REVISION_REQ"]);
    // an assigned role still reads as itself (the requester who also drafts)
    expect(scopeEditorBasis({ ...t, status: "DRAFTING", assignedDrafterId: "req-1" } as Ticket, "req-1", false)).toBe("drafter");
  });
  it("second fix pass: the issued statuses offer no issuing action, so freezing the data there can never block an issue", () => {
    expect([...SCOPE_ISSUED_STATUSES].sort()).toEqual(["FINAL_DRAFT", "PENDING_IFC"]);
    for (const status of SCOPE_ISSUED_STATUSES) {
      for (const role of ["Admin", "Manager", "Engineer-3", "Drafter", "Requester"]) {
        const t = { id: "t1", orgId: "o1", status, requesterId: "u1", assignedDrafterId: "u1", assignedEngineerId: "u1", attachments: [], history: [], comments: [], watchers: [], metadata: {} } as unknown as Ticket;
        const offered = WorkflowEngine.getActions(t, role as never, "u1", undefined, { userRoles: [role as never] }).map((a) => a.action);
        expect(offered.filter((a) => ISSUING_APPROVALS.has(a) || a === "sign_slot"), `${status} ${role}`).toEqual([]);
      }
    }
  });
  it("the table not there yet reads as not migrated; anything else is a real error", () => {
    expect(isMissingScopeTable({ code: "42P01", message: "x" })).toBe(true);
    expect(isMissingScopeTable({ code: "PGRST205", message: "x" })).toBe(true);
    expect(isMissingScopeTable({ message: "Could not find the table 'public.ticket_examination_scopes' in the schema cache" })).toBe(true);
    expect(isMissingScopeTable({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingScopeTable(null)).toBe(false);
  });
});

describe("the editor — a requirement binds from the save that stores it (the database stamps it: 20261266)", () => {
  it("examinationScopeHasRequirements: only settings carrying a requirement make the page read the row back", () => {
    expect(examinationScopeHasRequirements({ requestTypes: { options: [] } })).toBe(false);
    expect(examinationScopeHasRequirements(null)).toBe(false);
    expect(examinationScopeHasRequirements({ [EXAMINATION_SCOPE_KEY]: { fields: [{ key: "a", options: [] }], requirements: [] } })).toBe(false);
    expect(examinationScopeHasRequirements({ [EXAMINATION_SCOPE_KEY]: { fields: [], requirements: [{ field: "a", workClass: "w" }] } })).toBe(true);
  });
  it("editing a requirement to name another field, class or library makes it new (its time dropped)", () => {
    const r = { field: "a", workClass: "w", since: SINCE };
    expect(editRequirement(r, { workClass: "w" })).toEqual(r);
    expect(editRequirement(r, { workClass: "x" })).toEqual({ field: "a", workClass: "x" });
    expect(editRequirement(r, { libraryId: LIB })).toEqual({ field: "a", workClass: "w", libraryId: LIB });
    expect(editRequirement(r, { workClass: "" })).toEqual({ field: "a" });
  });
  it("choices round-trip as lines ('value | label' when they differ)", () => {
    const opts = [{ value: "rt5", label: "5% RT" }, { value: "VT", label: "VT" }];
    expect(optionsToText(opts)).toBe("rt5 | 5% RT\nVT");
    expect(textToOptions("rt5 | 5% RT\nVT\n\n  ")).toEqual(opts);
    expect(editableScope(CFG).fields[0].options).toEqual(CFG[EXAMINATION_SCOPE_KEY].fields[0].options);
    expect(editableScope({} as never)).toEqual({ fields: [], requirements: [] });
  });
});

describe("fix pass — ruling (2): never newly block a request already in flight (the since stamp itself: lib/__tests__/rls/dfP24ExaminationScope.test.ts)", () => {
  const req = (field: string, since?: string) => ({ field, workClass: "code", ...(since ? { since } : {}) });
  const cfgOf = (options: Array<{ value: string; label: string }> | null, requirements: Array<Record<string, unknown>>) => ({
    [EXAMINATION_SCOPE_KEY]: { fields: options === null ? [] : [{ key: "exam", label: "Exam", options }], requirements },
  });
  it("hasBindingRequirement: only a readable since at or before the filing binds; known before the row is read", () => {
    const config = parseExaminationScopeConfig(CFG);
    expect(hasBindingRequirement(config, ticket())).toBe(true);
    expect(hasBindingRequirement(config, ticket({ createdAt: "2026-09-01T00:00:00.000Z" }))).toBe(false);
    expect(hasBindingRequirement(config, ticket({ createdAt: undefined }))).toBe(false);
    expect(hasBindingRequirement(parseExaminationScopeConfig(cfgOf([{ value: "a", label: "A" }], [req("exam")])), ticket())).toBe(false);
  });
  it("scopeGateOutcome: an unreadable row refuses only where a requirement binds; not migrated never refuses", () => {
    const config = parseExaminationScopeConfig(CFG);
    const err = { code: "PGRST000", message: "upstream timeout" };
    expect(scopeGateOutcome(config, ticket(), { data: null, error: err }).kind).toBe("unreadable");
    expect(scopeGateOutcome(config, ticket({ createdAt: "2026-09-01T00:00:00.000Z" }), { data: null, error: err })).toEqual({ kind: "pass", audit: { unchecked: true, required: ["exam", "gov"] }, warning: null });
    expect(scopeGateOutcome(config, ticket(), { data: null, error: { code: "42P01", message: "x" } })).toEqual({ kind: "pass", audit: { notMigrated: true, required: ["exam", "gov"] }, warning: null });
    const blocked = scopeGateOutcome(config, ticket(), { data: null, error: null });
    expect(blocked.kind).toBe("blocked");
    const warned = scopeGateOutcome(config, ticket({ createdAt: "2026-09-01T00:00:00.000Z" }), { data: null, error: null });
    expect(warned).toMatchObject({ kind: "pass", warning: expect.stringMatching(/filed before the requirement/) });
  });
  it("a consent close held by the gate says why in its history headline", () => {
    expect(consentHeldAction("Operations", "examination_scope_missing")).toMatch(/examination data this workspace requires is not recorded/);
  });
});

describe("ruling (4) — the notify-only limb is NOT built; nothing about it changed", () => {
  it("the parser still drops records_examination on a notify-only slot (never refuses the table)", () => {
    const p = parseRoutingControl({ slots: [
      { kind: "sign", mode: "blocking", fill: { roles: ["Viewer"] } },
      { kind: "told", mode: "notify_only", fill: { users: ["q-1"] }, records_examination: true },
    ] });
    expect(p && p.ok).toBe(true);
    expect((p as unknown as { ok: true; control: { slots: Array<Record<string, unknown>> } }).control.slots[1]).not.toHaveProperty("records_examination");
  });
  it("the editor's hint never steers a facility toward a blocking assurance slot", () => {
    expect(ASSURANCE_OPT_IN_HINT).toMatch(/adds no sign-off/);
    expect(ASSURANCE_OPT_IN_HINT).toMatch(/stays "Told, no sign-off"/);
    expect(ASSURANCE_OPT_IN_HINT).not.toMatch(/make it|switch|convert|change it to|should be "Must sign off"/i);
  });
});

describe("ruling (5) — the sheets limb: the roster's files carry no sheet data, so the note carries it", () => {
  it("a record's file entries name files only; sheets ride the note", () => {
    const built = buildExaminationRecord(
      { contentHash: "h", cycle: "1A", files: [{ id: "f1", name: "iso.pdf", url: "k", sha256: "s" }] },
      { files: ["f1"], note: "Examined sheets 3–5 only" }, { act: "sign_off" },
    );
    expect(built.ok).toBe(true);
    const rec = (built as { ok: true; record: { files: Array<Record<string, unknown>>; note: string } }).record;
    expect(Object.keys(rec.files[0]).sort()).toEqual(["id", "name", "sha256"]);
    expect(rec.note).toBe("Examined sheets 3–5 only");
    const rosterType = readFileSync(join(process.cwd(), "types", "schema.ts"), "utf8").match(/files: Array<\{ id: string \| null; name: string \| null; url: string \| null; sha256: string \| null;[^}]*\}>/);
    expect(rosterType?.[0]).not.toMatch(/sheet/i);
  });
});

describe("DEC-35 — no facility vocabulary in the new code", () => {
  it("no QAQC / B31 / NDE / radiograph literal in DF-P24's files", () => {
    for (const f of ["lib/examinationScope.ts", "app/api/tickets/examination-scope/route.ts", "components/requests/ExaminationScopePanel.tsx", "components/requests/ExaminationScopeSection.tsx"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toMatch(/QAQC|QA\/QC|B31|\bNDE\b|radiograph/i);
    }
  });
});

describe("merge-time fix pass, item 6 — clock skew: a request filed less than 15 minutes after `since` is in flight (warned, never refused)", () => {
  const c = parseExaminationScopeConfig(CFG);
  const at = (ms: number) => new Date(Date.parse(SINCE) + ms).toISOString();
  it("the grace is 15 minutes; scopeBindsFrom names when a requirement starts to bind", () => {
    expect(SCOPE_CLOCK_SKEW_GRACE_MS).toBe(15 * 60 * 1000);
    expect(scopeBindsFrom(SINCE)).toBe("2026-10-01T00:15:00.000Z");
    expect(scopeBindsFrom(undefined)).toBeNull();
    expect(scopeBindsFrom("not a date")).toBeNull();
  });
  it("filed at since, or up to a millisecond short of 15 minutes after: warned only — and an unreadable row never refuses it; from 15 minutes on: binds", () => {
    for (const ms of [-60_000, 0, 60_000, SCOPE_CLOCK_SKEW_GRACE_MS - 1]) {
      const t = ticket({ createdAt: at(ms) });
      const s = examinationScopeStatus(c, t, {}, CFG);
      expect(s.blocking, String(ms)).toEqual([]);
      expect(s.warnOnly.map((w) => w.key), String(ms)).toEqual(["exam", "gov"]);
      expect(hasBindingRequirement(c, t), String(ms)).toBe(false);
      expect(scopeGateOutcome(c, { ...t, deliverableRev: "1A" }, { data: null, error: { code: "PGRST000", message: "timeout" } }).kind, String(ms)).toBe("pass");
    }
    for (const ms of [SCOPE_CLOCK_SKEW_GRACE_MS, SCOPE_CLOCK_SKEW_GRACE_MS + 1]) {
      const t = ticket({ createdAt: at(ms) });
      expect(examinationScopeStatus(c, t, {}, CFG).blocking.map((b) => b.key), String(ms)).toEqual(["exam", "gov"]);
      expect(hasBindingRequirement(c, t), String(ms)).toBe(true);
    }
  });
});

describe("merge-time fix pass, rulings 1 and 4 — who may fill, change or clear a field, by where the request stands", () => {
  const base = { assignedDrafterId: "d-1", assignedEngineerId: "e-1", requesterId: "req-1", metadata: { review_roster: { slots: [{ engineering: true, primaries: ["e-2"] }] } } };
  const t = (status: string, over: Record<string, unknown> = {}) => ({ ...base, status, ...over }) as unknown as Ticket;
  const mine = { by: "req-1" };
  const theirs = { by: "d-1" };
  it("phases: before review (the four with-the-drafter statuses), in review (PENDING_REVIEW, PENDING_FINAL_APPROVAL), after issue, closed (and an unknown status reads closed)", () => {
    for (const st of SCOPE_REQUESTER_STATUSES) expect(scopePhase(st)).toBe("before_review");
    expect([...SCOPE_REVIEW_STATUSES].sort()).toEqual(["PENDING_FINAL_APPROVAL", "PENDING_REVIEW"]);
    for (const st of SCOPE_REVIEW_STATUSES) expect(scopePhase(st)).toBe("in_review");
    for (const st of SCOPE_ISSUED_STATUSES) expect(scopePhase(st)).toBe("after_issue");
    for (const st of ["CLOSED", "CANCELED", "NEW", "", null]) expect(scopePhase(st as never)).toBe("closed");
  });
  it("before review: the drafter, the engineers and the queue fill and change; the requester fills an empty field and changes only their own value", () => {
    for (const st of SCOPE_REQUESTER_STATUSES) {
      for (const [uid, q] of [["d-1", false], ["e-1", false], ["e-2", false], ["sup", true]] as const) {
        expect(scopeFieldRight(t(st), uid, q, theirs), `${st} ${uid}`).toEqual({ fill: true, change: true });
      }
      expect(scopeFieldRight(t(st), "req-1", false, null), st).toEqual({ fill: true, change: false });
      expect(scopeFieldRight(t(st), "req-1", false, theirs), st).toEqual({ fill: true, change: false });
      expect(scopeFieldRight(t(st), "req-1", false, mine), st).toEqual({ fill: true, change: true });
      expect(scopeFieldRight(t(st), "q-1", false, null), st).toEqual({ fill: false, change: false });
    }
  });
  it("in review: only the assigned engineer of record — not the drafter, the roster engineer, the queue or the requester", () => {
    for (const st of SCOPE_REVIEW_STATUSES) {
      expect(scopeFieldRight(t(st), "e-1", false, theirs), st).toEqual({ fill: true, change: true });
      for (const [uid, q] of [["d-1", false], ["e-2", false], ["sup", true], ["req-1", false]] as const) {
        expect(scopeFieldRight(t(st), uid, q, theirs), `${st} ${uid}`).toEqual({ fill: false, change: false });
        expect(scopeFieldRight(t(st), uid, q, null), `${st} ${uid}`).toEqual({ fill: false, change: false });
      }
      expect(scopeFieldRight(t(st, { assignedEngineerId: null }), "d-1", false, null), st).toEqual({ fill: false, change: false });
    }
  });
  it("after issue: the drafter, the engineers and the queue FILL only; nobody changes or clears; not the requester", () => {
    for (const st of SCOPE_ISSUED_STATUSES) {
      for (const [uid, q] of [["d-1", false], ["e-1", false], ["e-2", false], ["sup", true]] as const) {
        expect(scopeFieldRight(t(st), uid, q, null), `${st} ${uid}`).toEqual({ fill: true, change: false });
      }
      expect(scopeFieldRight(t(st), "req-1", false, null), st).toEqual({ fill: false, change: false });
    }
    for (const st of ["CLOSED", "CANCELED"]) expect(scopeFieldRight(t(st), "e-1", true, null), st).toEqual({ fill: false, change: false });
  });
  it("checkScopeWrite: per field; the same value again is no change; a mixed fill-and-change after issue is refused whole", () => {
    const config = parseExaminationScopeConfig(CFG);
    const cur = { exam: { value: "rt5", by: "d-1", at: SINCE } };
    expect(checkScopeWrite(t("DRAFTING"), "req-1", false, config, cur, { gov: "c1" })).toMatchObject({ ok: true, basis: "requester" });
    expect(checkScopeWrite(t("DRAFTING"), "req-1", false, config, cur, { exam: "rt100" })).toMatchObject({ ok: false, status: 403, code: "recorded_by_someone_else" });
    expect(checkScopeWrite(t("DRAFTING"), "req-1", false, config, cur, { exam: null })).toMatchObject({ ok: false, status: 403 });
    expect(checkScopeWrite(t("DRAFTING"), "req-1", false, config, cur, { exam: "rt5" })).toMatchObject({ ok: true });
    expect(checkScopeWrite(t("PENDING_REVIEW"), "e-1", false, config, cur, { exam: null })).toMatchObject({ ok: true, phase: "in_review", basis: "engineer_of_record" });
    expect(checkScopeWrite(t("PENDING_REVIEW"), "d-1", false, config, cur, { gov: "c1" })).toMatchObject({ ok: false, status: 403, code: "in_review" });
    expect(checkScopeWrite(t("PENDING_IFC"), "d-1", false, config, cur, { gov: "c1" })).toMatchObject({ ok: true, phase: "after_issue", basis: "drafter" });
    expect(checkScopeWrite(t("PENDING_IFC"), "d-1", false, config, cur, { gov: "c1", exam: "rt100" })).toMatchObject({ ok: false, status: 409, code: "issued" });
    expect(checkScopeWrite(t("PENDING_IFC"), "req-1", false, config, cur, { gov: "c1" })).toMatchObject({ ok: false, status: 403 });
    expect(checkScopeWrite(t("CLOSED"), "e-1", true, config, cur, { gov: "c1" })).toMatchObject({ ok: false, status: 409, code: "closed" });
  });
  it("ruling 4: a fill after issue is marked for the revision issued; what it issued with is the values less those marks (a later revision's issue reads them as its own)", () => {
    const now = "2026-10-22T08:00:00.000Z";
    const { values } = applyScopeChanges({ exam: { value: "rt5", by: "e-1", at: SINCE } }, { gov: "c1" }, { uid: "d-1", name: "D" }, now, { afterIssue: { rev: "1A" } });
    expect(values.gov).toEqual({ value: "c1", by: "d-1", byName: "D", at: now, afterIssue: { rev: "1A" } });
    expect(parseScopeValues(JSON.parse(JSON.stringify(values)))).toEqual(values);
    expect(Object.keys(scopeValuesAsIssued(values, "1A"))).toEqual(["exam"]);
    expect(Object.keys(scopeValuesAsIssued(values, "2A")).sort()).toEqual(["exam", "gov"]);
    expect(applyScopeChanges({}, { gov: "c1" }, { uid: "d-1", name: null }, now).values.gov).not.toHaveProperty("afterIssue");
  });
  it("the history line names the change by the workspace's own labels, old → new", () => {
    const config = parseExaminationScopeConfig(CFG);
    const e = examinationScopeHistoryEntry({ phase: "in_review", config, changed: [{ field: "exam", from: "rt5", to: "rt100" }, { field: "gov", from: "c1", to: null }], user: "e@x.io", role: "Engineer-2", now: SINCE, attempt: "a1", actorId: "e-1" });
    expect(e).toEqual({ action: "Examination data changed in review", user: "e@x.io", role: "Engineer-2", date: SINCE, attempt: "a1", actorId: "e-1",
      details: "Examination scope: 5% RT → 100% RT; Governing code: Code one → — (changed by the engineer of record while the request was in review)" });
    expect(examinationScopeHistoryEntry({ phase: "after_issue", config, changed: [{ field: "gov", from: null, to: "c1" }], user: null, role: null, now: SINCE, attempt: "a2", actorId: "d-1" }))
      .toMatchObject({ action: "Examination data completed after issue", details: "Governing code: — → Code one (completed after issue — not part of what the request issued with)" });
  });
});

describe("merge-time fix pass, item 3 — the editor's check is the parser's own rule", () => {
  it("each kind of entry the parser drops is named; none without the key", () => {
    const opts = [{ value: "a", label: "A" }];
    const probs = examinationScopeProblems({ [EXAMINATION_SCOPE_KEY]: {
      fields: [{ key: " ok ", options: opts }, { key: "_x", options: opts }, { key: "k".repeat(61), options: opts }, { key: "ok", options: opts }, { key: "", options: opts }, 7, { key: "many", options: Array.from({ length: 201 }, (_, i) => ({ value: `v${i}` })) }],
      requirements: [{ field: "ok", workClass: "c" }, { field: "_x", workClass: "c" }, { field: "", workClass: "c" }, { field: "ok" }, null],
    } });
    expect(probs.map((p) => `${p.where}${p.index}`)).toEqual(["field1", "field2", "field3", "field4", "field5", "field6", "requirement1", "requirement2", "requirement3", "requirement4"]);
    expect(examinationScopeProblems({})).toEqual([]);
    expect(examinationScopeProblems(null)).toEqual([]);
    expect(editorScopeProblems({} as never)).toEqual([]);
    expect(FIELD_KEY_RE.test("Exam scope_1.a-b")).toBe(true);
  });
  it("PARITY: over many generated configurations, no problem ⇔ the parser keeps every field and every requirement", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const keyPool = ["exam", "gov", " exam ", "_bad", "a b", "x".repeat(60), "y".repeat(61), "", "Z-9.q", "é"];
    let clean = 0;
    for (let n = 0; n < 2000; n++) {
      const fields = Array.from({ length: Math.floor(rnd() * 4) }, () => ({ key: keyPool[Math.floor(rnd() * keyPool.length)], label: "L", options: [{ value: "a" }] }));
      const requirements = Array.from({ length: Math.floor(rnd() * 3) }, () => ({ field: keyPool[Math.floor(rnd() * keyPool.length)].trim(), ...(rnd() < 0.8 ? { workClass: "c" } : {}) }));
      const settings = { [EXAMINATION_SCOPE_KEY]: { fields, requirements } };
      const parsed = parseExaminationScopeConfig(settings);
      const keptAll = parsed.fields.length === fields.length && parsed.requirements.length === requirements.length
        && parsed.requirements.every((r) => parsed.fields.some((f) => f.key === r.field));
      const problems = examinationScopeProblems(settings);
      expect(problems.length === 0, JSON.stringify(settings)).toBe(keptAll);
      if (keptAll) clean++;
    }
    expect(clean).toBeGreaterThan(50);
  });
});
