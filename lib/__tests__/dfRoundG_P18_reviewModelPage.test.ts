// drafting-flow Round G, DF-P18 REVIEW-MODEL REQUEST-PAGE FOLLOW-UPS — the
// pure rules and the source pins (DEC-90 rulings (1)–(6) for DF-P18):
//   (1) every new control appears ONLY where configuration asks for it — an
//       unconfigured workspace sees today's screens and gets today's outcomes;
//   (2) the source-drift acknowledgement only where an action carries
//       requiresSourceDriftAck;
//   (3) "needs MOC" and "minor correction" change nothing for a request with
//       no class or an unflagged class;
//   (5) issue-as-is at submit defaults off, shown only where the ticket's
//       toggle is;
//   (6) a failed consent-window open is said on the page and in history.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  reviewClassOptions, workClassNeedingMoc, minorCorrectionClassOf, withMinorCorrectionClass, minorCorrectionClassNote,
} from "@/lib/reviewModel";
import { editableClasses, withFlag } from "@/components/requests/ReviewClassesSection";
import { mocRequirementFor, publishMocRequired, checkInCardsFor, type CheckInContext } from "@/lib/checkinOutcomes";
import {
  triageClassSelects, classTriagePayload, sourceDriftLabels, sourceDriftConfirmation, issueReadyAtSubmitOffered,
  consentBlockReason, consentBlockHistoryEntries,
} from "@/lib/requestPageReview";
import { keptNote, workClassChoices, windowSettingsFromInput, draftToControl, controlToDraft } from "@/components/documents/RoutingControlSection";
import { parseRoutingControl } from "@/lib/routingControl";
import { rosterDriftNote } from "@/components/requests/TicketRosterPanel";
import { rosterHasConsent } from "@/components/requests/ConsentBlockNotice";
import { cleanEquipmentTag, equipmentEditAllowed, isMissingEquipmentTable, isTicketParticipant, EQUIPMENT_NOT_AVAILABLE } from "@/lib/ticketEquipment";
import { WorkflowEngine } from "@/lib/workflow";
import type { OrgDraftingSettings, Ticket } from "@/types/schema";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const CFG = {
  workClasses: { options: [
    { value: "mc", label: "Minor correction", minorCorrection: true },
    { value: "pipe", label: "Piping change", engineering: true, moc: true },
    { value: "plain", label: "Plain" },
  ] },
  codeClasses: { options: [{ value: "c1", label: "Code one", minorCorrection: true, moc: true }] },
} as unknown as OrgDraftingSettings;

describe("TIER-7 / TIER-6 — what a configured work class carries (lib/reviewModel.ts)", () => {
  it("the flags ride a WORK class only; a code class carries none; an absent list is no list", () => {
    expect(reviewClassOptions(CFG, "workClasses")).toEqual([
      { value: "mc", label: "Minor correction", minorCorrection: true },
      { value: "pipe", label: "Piping change", engineering: true, moc: true },
      { value: "plain", label: "Plain" },
    ]);
    expect(reviewClassOptions(CFG, "codeClasses")).toEqual([{ value: "c1", label: "Code one" }]);
    expect(reviewClassOptions(null, "workClasses")).toEqual([]);
    expect(reviewClassOptions({} as OrgDraftingSettings, "workClasses")).toEqual([]);
  });
  it("needs-MOC and minor-correction answer only for a request OF a flagged class (ruling (3))", () => {
    expect(workClassNeedingMoc(CFG, "pipe")?.label).toBe("Piping change");
    for (const wc of [null, undefined, "", "plain", "mc", "gone"]) expect(workClassNeedingMoc(CFG, wc as string | null)).toBeNull();
    expect(workClassNeedingMoc(null, "pipe")).toBeNull();
    expect(minorCorrectionClassOf(CFG, "mc")?.value).toBe("mc");
    for (const wc of [null, undefined, "", "plain", "pipe", "gone"]) expect(minorCorrectionClassOf(CFG, wc as string | null)).toBeNull();
  });
  it("REGRESSION (ruling (3)): withMinorCorrectionClass returns the SAME array for no class, an unflagged class, no config, or no minor-correction action", () => {
    const actions = [{ action: "approve_draft_ifc", description: "Accepts" }, { action: "approve_minor_correction", description: "Minor" }];
    expect(withMinorCorrectionClass(actions, CFG, null)).toBe(actions);
    expect(withMinorCorrectionClass(actions, CFG, "plain")).toBe(actions);
    expect(withMinorCorrectionClass(actions, CFG, "pipe")).toBe(actions);
    expect(withMinorCorrectionClass(actions, null, "mc")).toBe(actions);
    const noMinor = [{ action: "approve_draft_ifc" }];
    expect(withMinorCorrectionClass(noMinor, CFG, "mc")).toBe(noMinor);
  });
  it("on a request of the minor-correction class the approval NAMES the class; nothing is enabled, disabled or removed", () => {
    const actions = [{ action: "approve_draft_ifc", description: "Accepts" }, { action: "approve_minor_correction", description: "Minor", disabledReason: "SoD" }];
    const out = withMinorCorrectionClass(actions, CFG, "mc");
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(actions[0]);
    expect(out[1]).toEqual({ action: "approve_minor_correction", description: `Minor ${minorCorrectionClassNote({ label: "Minor correction" })}`, disabledReason: "SoD" });
  });
  it("the admin editor keeps every flag through an edit, and a code class gets no flag", () => {
    expect(editableClasses(CFG, "workClasses").options).toEqual(reviewClassOptions(CFG, "workClasses"));
    expect(editableClasses(CFG, "codeClasses").options).toEqual([{ label: "Code one", value: "c1" }]);
    const o = { label: "A", value: "a", moc: true as const };
    expect(withFlag(o, "engineering", true)).toEqual({ label: "A", value: "a", moc: true, engineering: true });
    expect(withFlag({ ...o, engineering: true }, "engineering", false)).toEqual(o);
    expect(withFlag(o, "minorCorrection", true)).toEqual({ ...o, minorCorrection: true });
    expect(withFlag(o, "moc", false)).toEqual({ label: "A", value: "a" });
  });
  it("the request page says the class beside the buttons only for a request of a minor-correction class; its action list is the engine's (source)", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    expect(page).toContain("const minorClass = minorCorrectionClassOf(draftingCfg, ticket.workClass);");
    expect(page).toContain("{minorClass && buttonActions.some((a) => a.action === 'approve_minor_correction' && !a.disabledReason) && (");
    expect(page).toContain("const liveActions = policyFault ? [] : availableActions;");
    expect(src("app/api/tickets/workflow-action/route.ts")).toContain("const offeredActions = withMinorCorrectionClass(allowed, draftingCfg, ticket.workClass);");
  });
  it("the editor shows the two flags on work classes only (source)", () => {
    const s = src("components/requests/ReviewClassesSection.tsx");
    expect(s).toContain('{key === "workClasses" && (');
    expect(s).toContain('data-testid="review-class-minor-correction"');
    expect(s).toContain('data-testid="review-class-moc"');
  });
});

describe("TIER-6 — MOC applicability through the class (lib/checkinOutcomes.ts, RevUpModal)", () => {
  it("REGRESSION: with no class flag, mocRequirementFor and publishMocRequired are today's rules, for every combination", () => {
    const outcomes = ["all_clear", "field_verified", "discrepancy", "correction_requested", "revision_requested", "published"] as const;
    for (const dc of ["drawing", "procedure", null] as const) {
      for (const o of outcomes) {
        const today = dc === "drawing" && (o === "discrepancy" || o === "revision_requested") ? "required" : "none";
        expect(mocRequirementFor(dc, o)).toBe(today);
        expect(mocRequirementFor(dc, o, false)).toBe(today);
      }
      for (const unknown of [false, true]) for (const ct of ["Major", "Minor", "Correction", "", null]) {
        const today = (dc === "drawing" || unknown) && !(ct === "Minor" || ct === "Correction");
        expect(publishMocRequired({ docClass: dc, docClassUnknown: unknown, changeType: ct })).toBe(today);
        expect(publishMocRequired({ docClass: dc, docClassUnknown: unknown, changeType: ct, classNeedsMoc: false })).toBe(today);
      }
    }
  });
  it("a class that needs MOC raises it — a real change on any document at check-in, and every change type at publish; never a correction card", () => {
    expect(mocRequirementFor("procedure", "revision_requested", true)).toBe("required");
    expect(mocRequirementFor(null, "discrepancy", true)).toBe("required");
    expect(mocRequirementFor("procedure", "correction_requested", true)).toBe("none");
    for (const ct of ["Major", "Minor", "Correction"]) expect(publishMocRequired({ docClass: "procedure", docClassUnknown: false, changeType: ct, classNeedsMoc: true })).toBe(true);
  });
  it("REGRESSION: the check-in cards with classNeedsMoc absent or false are exactly today's", () => {
    const purposes = ["As-Built Verification", "Field Reference", "Review / Approval", "Revision / Update", "Redline / Markup", "Other", null];
    for (const purpose of purposes) for (const docClass of ["drawing", "procedure", null] as const) for (const canPublishEff of [false, true]) for (const othersRemain of [false, true]) {
      const ctx: CheckInContext = { purpose, docClass, canPublishEff, othersRemain };
      expect(checkInCardsFor({ ...ctx, classNeedsMoc: false })).toEqual(checkInCardsFor(ctx));
    }
    const withClass = checkInCardsFor({ purpose: "Revision / Update", docClass: "procedure", canPublishEff: true, othersRemain: false, classNeedsMoc: true });
    expect(withClass.find((c) => c.id === "revision")?.moc).toBe("required");
    expect(withClass.find((c) => c.id === "correction")?.moc).toBe("none");
  });
  it("RevUpModal reads the one rule; the request page passes the class only when it needs MOC", () => {
    const modal = src("components/documents/RevUpModal.tsx");
    expect(modal).toContain("const mocRequired = publishMocRequired({ docClass, docClassUnknown, changeType, classNeedsMoc: !!classMoc });");
    const page = src("app/(protected)/requests/[id]/page.tsx");
    expect(page).toContain("const classNeedingMoc = workClassNeedingMoc(draftingCfg, ticket.workClass);");
    expect(page).toContain("classMoc={classNeedingMoc ? { label: classNeedingMoc.label } : null}");
  });
});

describe("TIER-2 dw2 / TIER-4 dw1 / GAP-101 — the class at triage (ruling (1))", () => {
  const wo = reviewClassOptions(CFG, "workClasses");
  const co = reviewClassOptions(CFG, "codeClasses");
  const t = (over: Partial<Ticket> = {}) => ({ status: "PENDING_ASSIGNMENT", engineeringRequired: true, ...over }) as Pick<Ticket, "status" | "engineeringRequired">;
  it("REGRESSION: no select for an unconfigured workspace, outside triage, or before 20261250 (column unread)", () => {
    expect(triageClassSelects(t(), [], [])).toEqual({ work: false, code: false });
    expect(triageClassSelects(t({ status: "DRAFTING" as Ticket["status"] }), wo, co)).toEqual({ work: false, code: false });
    expect(triageClassSelects(t({ engineeringRequired: undefined }), wo, co)).toEqual({ work: false, code: false });
  });
  it("one select per configured list", () => {
    expect(triageClassSelects(t(), wo, [])).toEqual({ work: true, code: false });
    expect(triageClassSelects(t({ engineeringRequired: false }), [], co)).toEqual({ work: false, code: true });
  });
  it("only a pick is sent, only for an offered list; 'No change' sends nothing", () => {
    expect(classTriagePayload({ workClass: "", codeClass: "" }, { work: true, code: true })).toEqual({});
    expect(classTriagePayload({ workClass: "pipe", codeClass: "c1" }, { work: true, code: false })).toEqual({ workClass: "pipe" });
    expect(classTriagePayload({ workClass: " pipe ", codeClass: "c1" }, { work: true, code: true })).toEqual({ workClass: "pipe", codeClass: "c1" });
  });
  it("the page sends workClass / codeClass with assign (the triage modal) and request_eng_review (the engineer picker) — never otherwise (source)", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    expect(page).toContain("...(triage?.workClass ? { workClass: triage.workClass } : {}),");
    expect(page).toContain("...(triage?.codeClass ? { codeClass: triage.codeClass } : {}),");
    expect(page).toContain("onSubmit(drafter.uid, drafter.name, reason, triage ? { ...triagePayload(ticket, { libraryId, unit }), ...classTriagePayload(classChoice, classOffered) } : undefined);");
    expect(page).toContain("extra={pendingAction.action === 'request_eng_review' ? (");
    expect(page).toContain("workClassOptions={workClassOptions}");
  });
});

describe("HAND-7 dw3 — the page passes the drift into getActions (ruling (2))", () => {
  const ref = { id: "d1", documentNumber: "P-101", title: null, rev: "3", versionId: "v3", path: null } as never;
  it("the labels are the route's words for the same move", () => {
    expect(sourceDriftLabels([{ ref, currentRev: "4" }])).toEqual(["P-101 raised on Rev 3, now Rev 4"]);
    expect(sourceDriftLabels([])).toEqual([]);
    expect(sourceDriftConfirmation(["P-101 raised on Rev 3, now Rev 4"])).toMatch(/P-101 raised on Rev 3, now Rev 4/);
  });
  it("with labels the issuing approvals carry requiresSourceDriftAck; without them NO action carries it (REGRESSION)", () => {
    const ticket = {
      id: "t1", orgId: "o1", ticketId: "R-1", title: "x", status: "PENDING_REVIEW", requestType: "ISO", unit: null,
      requesterId: "req", requesterRole: "Manager", assignedDrafterId: "d", attachments: [], history: [], deliverableRev: "1A", metadata: {},
    } as unknown as Ticket;
    const plain = WorkflowEngine.getActions(ticket, "Manager", "req", undefined, { userRoles: ["Manager"], activeMemberCount: 2 });
    expect(plain.some((a) => a.requiresSourceDriftAck)).toBe(false);
    const moved = WorkflowEngine.getActions(ticket, "Manager", "req", undefined, { userRoles: ["Manager"], activeMemberCount: 2, sourceDrift: ["P-101 raised on Rev 3, now Rev 4"] });
    const approve = moved.find((a) => a.action === "approve_draft_ifc");
    expect(approve?.requiresSourceDriftAck).toBe(true);
    expect(moved.filter((a) => a.requiresSourceDriftAck).every((a) => ["approve_draft_ifc", "approve_minor_correction", "engineer_approve_final", "override_engineer_final", "sign_slot"].includes(a.action))).toBe(true);
  });
  it("the page asks only for a flagged action and sends sourceDriftAcknowledged only for the approval it asked about (source)", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    expect(page).toContain("if (action.requiresSourceDriftAck) {");
    expect(page).toContain("...(driftAckRef.current === action.action ? { sourceDriftAcknowledged: true } : {}),");
    expect(page).toContain("...(driftLabelsForEngine.length > 0 ? { sourceDrift: driftLabelsForEngine } : {}),");
    expect(page).toContain("<SourceDriftBanner metadata={ticket.metadata} orgId={ticket.orgId} onDrift={setSourceDrifts} />");
    expect(page.indexOf("driftAckRef.current = null;")).toBeLessThan(page.indexOf("driftAckRef.current = action.action;"));
  });
  it("the roster panel asks only when there is a move", () => {
    expect(rosterDriftNote(undefined)).toBeNull();
    expect(rosterDriftNote([])).toBeNull();
    expect(rosterDriftNote(["P-101 raised on Rev 3, now Rev 4"])).toMatch(/Signing off asks you to acknowledge it/);
  });
});

describe("FRIC-5 — issue as-is at submit (ruling (5))", () => {
  const submit = [{ action: "submit_draft" }];
  it("offered only to the assigned drafter, beside an offered (enabled) Submit", () => {
    expect(issueReadyAtSubmitOffered({ assignedDrafterId: "d" }, "d", submit)).toBe(true);
    expect(issueReadyAtSubmitOffered({ assignedDrafterId: "d" }, "mgr", submit)).toBe(false);
    expect(issueReadyAtSubmitOffered({ assignedDrafterId: null }, "d", submit)).toBe(false);
    expect(issueReadyAtSubmitOffered({ assignedDrafterId: "d" }, null, submit)).toBe(false);
    expect(issueReadyAtSubmitOffered({ assignedDrafterId: "d" }, "d", [])).toBe(false);
    expect(issueReadyAtSubmitOffered({ assignedDrafterId: "d" }, "d", [{ action: "submit_draft", disabledReason: "x" }])).toBe(false);
  });
  it("default off; issueReady is sent only for submit_draft, only when ticked, only by the assigned drafter; reset after the submit (source)", () => {
    const page = src("app/(protected)/requests/[id]/page.tsx");
    expect(page).toContain("const [issueReadyAtSubmit, setIssueReadyAtSubmit] = useState(false);");
    expect(page).toContain("...(action.action === 'submit_draft' && issueReadyAtSubmit && ticket.assignedDrafterId === uid ? { issueReady: true } : {}),");
    expect(page).toContain("if (action.action === 'submit_draft') setIssueReadyAtSubmit(false);");
    expect(page).toContain("{issueReadyOffered && (");
  });
});

describe("GAP-113 acceptance 1 — a consent window that was not opened (ruling (6))", () => {
  it("each recorded reason is said in words, from the row alone", () => {
    expect(consentBlockReason({ created_at: "2026-10-21T09:00:00Z", slot_kind: "ops", details: { reason: "window_not_opened", error: "insert failed", retriedByMaintenance: true } }, "Operations"))
      .toBe('"Operations": the consent window could not be opened — the people it asks could not all be told (insert failed). Nothing advances on silence; it waits for a sign-off and is tried again at the next maintenance run.');
    expect(consentBlockReason({ created_at: "x", slot_kind: "ops", details: { reason: "window_never_opened", why: "nobody may be asked" } })).toMatch(/^"ops": the planned consent window was never opened — nobody may be asked\.$/);
    expect(consentBlockReason({ created_at: "x", slot_kind: null, details: { reason: "no_longer_member" } })).toMatch(/nobody who could object is still a member/);
    expect(consentBlockReason({ created_at: "x", slot_kind: "ops", details: null })).toMatch(/waits for a sign-off/);
  });
  it("the history entries are read-only additions, one per row", () => {
    const rows = [{ created_at: "2026-10-21T09:00:00Z", slot_kind: "ops", actor_name: null, details: { reason: "window_not_opened" } }];
    const h = consentBlockHistoryEntries(rows, () => "Operations");
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ action: "Consent window not opened", user: "System", date: "2026-10-21T09:00:00Z" });
    expect(h[0].details).toMatch(/^"Operations": the consent window could not be opened/);
  });
  it("REGRESSION (ruling (1)): the notice reads nothing unless the roster has a consent plan or slot", () => {
    expect(rosterHasConsent(null)).toBe(false);
    expect(rosterHasConsent({ slots: [{ mode: "blocking" }] } as never)).toBe(false);
    expect(rosterHasConsent({ slots: [{ mode: "consent_window" }] } as never)).toBe(true);
    expect(rosterHasConsent({ slots: [], consentPlan: { kind: "blocked" } } as never)).toBe(true);
    const page = src("app/(protected)/requests/[id]/page.tsx");
    expect(page).toContain("const historyShown = consentBlockRows.length === 0\n    ? (ticket.history ?? [])");
  });
});

describe("TIER-3 dw1 and the DF-P7 editor residual — the routing editor", () => {
  it("work class chips list the workspace's classes plus a stored value the list no longer names", () => {
    expect(workClassChoices(reviewClassOptions(CFG, "workClasses"), ["gone"])).toEqual([
      { value: "mc", label: "Minor correction" }, { value: "pipe", label: "Piping change" }, { value: "plain", label: "Plain" },
      { value: "gone", label: "gone", unlisted: true },
    ]);
    expect(workClassChoices([], undefined)).toEqual([]);
  });
  it("window inputs: blank stores nothing (the defaults); a percent becomes a fraction; out of range is kept for the validator", () => {
    expect(windowSettingsFromInput("", "")).toEqual({});
    expect(windowSettingsFromInput("5", "50")).toEqual({ windowDays: 5, warnFraction: 0.5 });
    expect(windowSettingsFromInput("0", "")).toEqual({ windowDays: 0 });
  });
  it("a notify-only slot limited to classes and a consent slot with its window round-trip through the editor and parse", () => {
    const stored = { slots: [
      { kind: "check", mode: "blocking", fill: { roles: ["Engineer"] } },
      { kind: "told", mode: "notify_only", fill: { roles: ["Supervisor"] }, work_classes: ["pipe"] },
      { kind: "ops", mode: "consent_window", fill: { users: ["o-1"] }, window_days: 5, warn_fraction: 0.5 },
    ] };
    const parsed = parseRoutingControl(stored);
    if (!parsed || !parsed.ok) throw new Error("bad");
    const drafts = controlToDraft(parsed.control);
    const back = draftToControl(drafts);
    expect(back.slots[1]).toMatchObject({ work_classes: ["pipe"] });
    expect(back.slots[2]).toMatchObject({ window_days: 5, warn_fraction: 0.5 });
    expect(parseRoutingControl(back)).toMatchObject({ ok: true });
    // what the editor now shows is no longer "settings this editor does not show"
    expect(keptNote(drafts[1], { workClasses: true })).toBeNull();
    expect(keptNote(drafts[2], { window: true })).toBeNull();
    // REGRESSION: without `shown` the note is as before
    expect(keptNote(drafts[1])).toMatch(/told only for the work classes pipe/);
    expect(keptNote(drafts[2])).toMatch(/a consent window of 5 working days/);
  });
  it("a class limit on a blocking slot is still refused by the validator (never a condition on a sign-off)", () => {
    expect(parseRoutingControl({ slots: [{ kind: "check", mode: "blocking", fill: { roles: ["Engineer"] }, work_classes: ["pipe"] }] })).toMatchObject({ ok: false });
  });
  it("the chips show only on a notify-only slot when the workspace has work classes; the window only on a consent slot (source)", () => {
    const s = src("components/documents/RoutingControlSection.tsx");
    expect(s).toContain('{s.mode === "notify_only" && workClassOptions.length > 0 && (');
    expect(s).toContain('{s.mode === "consent_window" && (');
  });
});

describe("intelligence GAP-312 — equipment after filing (ruling (4)), the pure rules", () => {
  it("a tag is trimmed and bounded by the column's CHECK", () => {
    expect(cleanEquipmentTag("  P-101  ")).toBe("P-101");
    expect(cleanEquipmentTag("")).toBeNull();
    expect(cleanEquipmentTag("x".repeat(81))).toBeNull();
    expect(cleanEquipmentTag(42)).toBeNull();
  });
  it("participants and the queue only; never a closed, canceled or archived request", () => {
    expect(isTicketParticipant({ requesterId: "r", assignedDrafterId: "d", assignedEngineerId: "e" }, "d")).toBe(true);
    expect(isTicketParticipant({ requesterId: "r" }, "x")).toBe(false);
    expect(isTicketParticipant({ requesterId: "r" }, null)).toBe(false);
    expect(equipmentEditAllowed({ participant: true, queue: false, status: "DRAFTING", archived: false })).toBe(true);
    expect(equipmentEditAllowed({ participant: false, queue: true, status: "PENDING_ASSIGNMENT", archived: false })).toBe(true);
    expect(equipmentEditAllowed({ participant: false, queue: false, status: "DRAFTING", archived: false })).toBe(false);
    expect(equipmentEditAllowed({ participant: true, queue: true, status: "CLOSED", archived: false })).toBe(false);
    expect(equipmentEditAllowed({ participant: true, queue: true, status: "CANCELED", archived: false })).toBe(false);
    expect(equipmentEditAllowed({ participant: true, queue: true, status: "DRAFTING", archived: true })).toBe(false);
  });
  it("before 20261251 the table is missing — and only that reads as missing", () => {
    expect(isMissingEquipmentTable({ code: "42P01", message: 'relation "ticket_equipment" does not exist' })).toBe(true);
    expect(isMissingEquipmentTable({ code: "PGRST205", message: "Could not find the table 'public.ticket_equipment' in the schema cache" })).toBe(true);
    expect(isMissingEquipmentTable({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingEquipmentTable({ code: "57014", message: "timeout" })).toBe(false);
    expect(isMissingEquipmentTable(null)).toBe(false);
    expect(EQUIPMENT_NOT_AVAILABLE).toMatch(/not available/);
  });
});

describe("DF-P6's must-carry request-page hunks are still there (99-fix-sequencing 'Expected conflicts at merge (DF-P6 → DF-P9)')", () => {
  const page = src("app/(protected)/requests/[id]/page.tsx");
  it("the mount, the mappers, the engine context and the roster's checked ticket", () => {
    expect(page).toContain("...reviewModelFieldsFromRow(r),");
    expect(page).toContain("WorkflowEngine.getActions(ticketAsDeclarationChecked(ticket, declarationCheck), activeRole");
    expect(page).toContain("engineerPickQuestionApplies(ticketAsDeclarationChecked(ticket, declarationCheck), uid");
    expect(page).toContain("<TicketRosterPanel ticket={ticketAsDeclarationChecked(ticket, declarationCheck)}");
    expect(page).toContain("onDeclarationCheck={setDeclarationCheck}");
    expect(page).toContain("engineeringOverrideOf(ticket)");
    expect(page).toContain("engineeringSignOffNotRequiredOf(ticket)");
  });
});
