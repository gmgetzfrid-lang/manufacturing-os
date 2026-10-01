// public-surfaces Round F PS-VERIFY — what the three scan-landing pages
// paint (lib/verifyPresent.ts): GREEN only when the endpoint KNOWS the paper
// is good; every other verdict — and any verdict this build does not know —
// is not green. (VFY-1 / VFY-3 / VFY-8 / VFY-9 / VFY-10 / VFY-11; PHYS-10.)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  presentDocVerdict, presentPackVerdict, presentHoldVerdict, sheetLabel, formatEffectiveDay, notPrintableText,
  type DocVerifyResult, type PackVerifyResult, type HoldVerifyResult, type DocVerdict, type PackVerdict,
} from "@/lib/verifyPresent";
import { isRecognisedStatus } from "@/lib/verifyVerdict";

const doc = (over: Partial<DocVerifyResult> = {}): DocVerifyResult => ({
  docNumber: "P-101", title: "P&ID", printedRev: "5", printedAt: null, currentRev: "5", currentIssuedAt: null,
  effectiveDate: null, notYetEffective: false, docStatus: "Issued", isCurrent: true, checkedAt: "2026-10-01T00:00:00Z", ...over,
});
const GREEN = "bg-emerald-600";

describe("presentDocVerdict — /verify/[docId]", () => {
  it("green ONLY for 'current'", () => {
    const all: DocVerdict[] = ["current", "not_yet_effective", "held", "superseded", "void", "archived", "retired", "draft", "not_issued", "superseded_version", "unverifiable", "no_current_revision"];
    for (const v of all) {
      const view = presentDocVerdict(doc({ verdict: v }));
      expect(view.bg === GREEN, v).toBe(v === "current");
      expect(view.ok, v).toBe(v === "current");
    }
  });
  it("an unknown verdict string from a newer build is not green", () => {
    const view = presentDocVerdict(doc({ verdict: "something_new" as DocVerdict }));
    expect(view.bg).not.toBe(GREEN);
  });
  it("legacy payload (no verdict): isCurrent without a printed revision is NOT green (VFY-3)", () => {
    expect(presentDocVerdict(doc({ verdict: undefined, isCurrent: true, printedRev: null })).headline).toBe("CAN'T CONFIRM THIS REVISION");
    expect(presentDocVerdict(doc({ verdict: undefined, isCurrent: true, printedRev: "5" })).ok).toBe(true);
  });
  it("not_issued and draft say NOT ISSUED; unverifiable says it cannot confirm; no blurb prints 'Rev ?'", () => {
    expect(presentDocVerdict(doc({ verdict: "not_issued", docStatus: "In Review" })).blurb).toContain("(In Review)");
    expect(presentDocVerdict(doc({ verdict: "draft" })).headline).toBe("DRAFT — NOT ISSUED");
    expect(presentDocVerdict(doc({ verdict: "unverifiable" })).blurb).toMatch(/does not say which revision/);
    for (const v of ["superseded_version", "unverifiable", "no_current_revision", "current"] as DocVerdict[]) {
      expect(presentDocVerdict(doc({ verdict: v, printedRev: null, currentRev: null })).blurb).not.toContain("Rev ?");
    }
  });
  it("no_current_revision (the code named the printed version; the document has no current one) never claims the code did not say which revision was printed", () => {
    const named = presentDocVerdict(doc({ verdict: "no_current_revision", printedRev: "5", currentRev: null }));
    expect(named.ok).toBe(false);
    expect(named.bg).toBe("bg-slate-700");
    expect(named.headline).toBe("CAN'T CONFIRM THIS REVISION");
    expect(named.blurb).toBe("This document has no current revision on record, so the system cannot confirm this print is current. Do not assume it is — check with Document Control.");
    expect(named.blurb).not.toMatch(/does not say which revision/);
    // the doc-only QR keeps its own words
    const docOnly = presentDocVerdict(doc({ verdict: "unverifiable", printedRev: null }));
    expect(docOnly.blurb).toMatch(/does not say which revision was printed/);
    expect(docOnly.blurb).not.toBe(named.blurb);
    expect(named.advice).toBe(docOnly.advice);
  });
  it("a status the vocabulary does not know (IFC, a free value) is red but NEUTRAL — 'status not recognised', never 'not an approved revision' (VFY-20)", () => {
    for (const docStatus of ["IFC", "Pending", "SomeFutureStatus", " Issued"]) {
      const v = presentDocVerdict(doc({ verdict: "not_issued", docStatus }));
      expect(v.ok, docStatus).toBe(false);
      expect(v.bg, docStatus).toBe("bg-red-600");
      expect(v.headline, docStatus).toBe("STATUS NOT RECOGNISED");
      expect(v.blurb, docStatus).toContain(`(${docStatus})`);
      expect(v.blurb, docStatus).toContain("Check with Document Control");
      expect(`${v.blurb} ${v.advice}`, docStatus).not.toMatch(/not an approved revision|not an issued, controlled revision/);
    }
    // a recognised not-issued status keeps VFY-9's wording
    for (const docStatus of ["In Review", null, ""]) {
      const v = presentDocVerdict(doc({ verdict: "not_issued", docStatus }));
      expect(v.headline, String(docStatus)).toBe("NOT ISSUED — DO NOT USE");
      expect(v.advice, String(docStatus)).toMatch(/This is not an approved revision/);
    }
    expect(["Issued", "Locked", "Draft", "In Review", "Superseded", "Void", "Archived", null, "", "  "].every(isRecognisedStatus)).toBe(true);
    expect(["IFC", "Pending", " Issued", "issued"].some(isRecognisedStatus)).toBe(false);
  });
  it("held names the hold categories and the count", () => {
    const view = presentDocVerdict(doc({ verdict: "held", activeHolds: 2, holdReasons: ["Client Review", "On hold"] }));
    expect(view.blurb).toContain("2 active holds (Client Review, On hold)");
  });
  it("formatEffectiveDay shows the stored calendar day, never the day before west of UTC", () => {
    const s = formatEffectiveDay("2026-03-02")!;
    expect(s).toContain("2026");
    expect(s).toMatch(/\b2\b/);
    expect(s).not.toMatch(/\b1\b/);
    expect(formatEffectiveDay(null)).toBeNull();
    expect(formatEffectiveDay("soon")).toBeNull();
  });
  it("the page shows the document status in every branch and never 'Rev ?' beside green", () => {
    const src = readFileSync(join(process.cwd(), "app/verify/[docId]/page.tsx"), "utf8");
    expect(src).toContain('Document status');
    expect(src).toContain('{result.docStatus ?? "Not recorded"}');
    expect(src).toContain('Rev {result.printedRev ?? (view.ok ? result.currentRev : null) ?? "—"}');
    expect(src).not.toContain('Rev {result.printedRev ?? "?"}');
    expect(src).toContain('fetch(`/api/verify?${qs.toString()}`, { cache: "no-store" })');
  });
});

const pack = (over: Partial<PackVerifyResult> = {}): PackVerifyResult => ({
  name: "TA-2026", packageStatus: "open", closed: false, sheetCount: 1, staleCount: 0, allFresh: true,
  sheets: [{ label: "P-101", printedRev: "4", currentRev: "4", fresh: true, retired: false, state: "fresh" }],
  checkedAt: "2026-10-01T00:00:00Z", ...over,
});

describe("presentPackVerdict — /verify-package/[packageId]", () => {
  it("green ONLY for 'current'", () => {
    const all: PackVerdict[] = ["current", "not_yet_effective", "incomplete", "stale", "held", "closed", "empty", "unconfirmed_print", "unverifiable"];
    for (const v of all) expect(presentPackVerdict(pack({ verdict: v })).bg === GREEN, v).toBe(v === "current");
    expect(presentPackVerdict(pack({ verdict: "brand_new" as PackVerdict })).bg).not.toBe(GREEN);
  });
  it("VFY-11: an empty pack has its own headline — the '0 of 0' sentence is unreachable", () => {
    const view = presentPackVerdict(pack({ verdict: "empty", sheetCount: 0, staleCount: 0, sheets: [], allFresh: false }));
    expect(view.headline).toBe("NO SHEETS IN THIS PACK");
    expect(view.bg).not.toBe("bg-red-600");
    expect(view.blurb).not.toMatch(/0 of 0/);
    // and a stale pack never says "0 of N" either: the count is only printed when non-zero
    expect(presentPackVerdict(pack({ verdict: "stale", staleCount: 0, notInPack: [{ label: "P-102" }] })).blurb).not.toMatch(/\b0 of\b/);
  });
  it("VFY-8: a closed pack says so in the headline and is not green", () => {
    const view = presentPackVerdict(pack({ verdict: "closed", closed: true }));
    expect(view.headline).toBe("PACKAGE CLOSED — DO NOT WORK FROM IT");
    expect(view.advice).toMatch(/no longer watched/);
  });
  it("VFY-2: a legacy cover QR says it cannot confirm which printing", () => {
    expect(presentPackVerdict(pack({ verdict: "unconfirmed_print" })).headline).toBe("CAN'T CONFIRM WHICH PRINTING");
  });
  it("stale names both the changed sheets and the package's sheets not in this pack — never 'added since printing'", () => {
    const view = presentPackVerdict(pack({ verdict: "stale", staleCount: 1, sheetCount: 3, notInPack: [{ label: "P-9" }, { label: "P-10" }] }));
    expect(view.headline).toBe("PACK IS STALE");
    expect(view.blurb).toContain("1 of 3 sheets changed or withdrawn since this pack was printed");
    expect(view.blurb).toContain("2 sheets in the package are not in this pack");
    expect(view.blurb).not.toMatch(/added/i);
    // only missing sheets: its own headline, a re-print advice, "get the missing sheets"
    const only = presentPackVerdict(pack({ verdict: "stale", staleCount: 0, notInPack: [{ label: "P-9" }] }));
    expect(only.headline).toBe("PACK IS MISSING SHEETS");
    expect(only.bg).toBe("bg-red-600");
    expect(only.blurb).toBe("1 sheet in the package is not in this pack — get the missing sheets before starting work.");
    expect(only.advice).toMatch(/re-printed pack/);
    expect(`${only.headline} ${only.blurb} ${only.advice}`).not.toMatch(/added|outdated/i);
  });
  it("incomplete (the package holds sheets that cannot be printed now) is AMBER, never green, never 'stale', and says why", () => {
    const view = presentPackVerdict(pack({
      verdict: "incomplete",
      notPrintable: [{ label: "P-102", reason: "not_issued" }, { label: "P-103", reason: "on_hold" }, { label: "P-104", reason: "on_hold" }],
    }));
    expect(view.bg).toBe("bg-amber-500");
    expect(view.ok).toBe(false);
    expect(view.headline).toBe("PACK INCOMPLETE");
    expect(view.blurb).toBe("Every sheet in this pack is current, but 3 sheets in the package are not in it and cannot be printed now (not issued, on hold) — listed below.");
    expect(view.advice).toMatch(/Work only from the sheets in this pack/);
    // the advice fits every reason — a DWG or a file-less sheet is not waiting to be "issued or released"
    expect(view.advice).toContain("until Document Control supplies them");
    expect(view.advice).not.toMatch(/issues or releases/);
    expect(`${view.headline} ${view.blurb} ${view.advice}`).not.toMatch(/added|stale/i);
    // a payload with no list still never prints "0 sheets"
    expect(presentPackVerdict(pack({ verdict: "incomplete" })).blurb).not.toMatch(/\b0 sheet/);
  });
  it("notPrintableText names every reason; an unknown one reads 'cannot be printed'", () => {
    expect(["not_issued", "status_unrecognised", "withdrawn", "on_hold", "hold_unknown", "unavailable", "no_file", "not_pdf"].map(notPrintableText)).toEqual([
      "not issued", "status not recognised", "withdrawn", "on hold", "hold status unknown", "no longer available", "no current file", "not a printable PDF",
    ]);
    expect(notPrintableText("brand_new")).toBe("cannot be printed");
    expect(notPrintableText(null)).toBe("cannot be printed");
  });
  it("VFY-1 / VFY-11: a sheet that is not an issued revision is NOT reported as 'changed since this pack was printed'", () => {
    // a just-printed pack whose one legacy no-status sheet verifies not_issued
    const only = presentPackVerdict(pack({ verdict: "stale", staleCount: 1, notIssuedCount: 1, sheetCount: 3 }));
    expect(only.headline).toBe("PACK HAS UNISSUED SHEETS");
    expect(only.bg).toBe("bg-red-600");
    expect(only.blurb).toContain("1 of 3 sheets is not an issued, controlled revision");
    expect(only.blurb).not.toMatch(/changed or withdrawn|since this pack was printed/);
    expect(only.advice).toMatch(/not issued revisions/);
    // mixed: each kind counted for what it is
    const mixed = presentPackVerdict(pack({ verdict: "stale", staleCount: 3, notIssuedCount: 2, sheetCount: 4 })).blurb;
    expect(mixed).toContain("1 of 4 sheets changed or withdrawn since this pack was printed");
    expect(mixed).toContain("2 of 4 sheets are not an issued, controlled revision");
    expect(presentPackVerdict(pack({ verdict: "stale", staleCount: 3, notIssuedCount: 2, sheetCount: 4 })).headline).toBe("PACK IS STALE");
    // an older API build that sends no notIssuedCount keeps the old wording
    expect(presentPackVerdict(pack({ verdict: "stale", staleCount: 1, sheetCount: 3 })).blurb).toContain("1 of 3 sheets changed or withdrawn");
    // a nonsensical count can never print a negative or "0 of N"
    expect(presentPackVerdict(pack({ verdict: "stale", staleCount: 1, notIssuedCount: 5, sheetCount: 3 })).blurb).not.toMatch(/\b0 of\b|-\d/);
  });
  it("sheetLabel: only a fresh sheet is ok; held names its categories; a legacy row says the printing is unknown", () => {
    expect(sheetLabel({ label: "x", printedRev: "4", currentRev: "4", fresh: true, retired: false, state: "fresh" })).toEqual({ text: "Rev 4 ✓", ok: true });
    expect(sheetLabel({ label: "x", printedRev: "4", currentRev: "4", fresh: false, retired: false, state: "held", holdReasons: ["Client Review"] }).text).toBe("ON HOLD · Client Review");
    expect(sheetLabel({ label: "x", printedRev: null, currentRev: "4", fresh: false, retired: false, state: "unconfirmed" }).text).toBe("now Rev 4 · printing unknown");
    for (const st of ["void", "draft", "not_issued", "status_unrecognised", "removed", "missing", "stale", "not_yet_effective"] as const) {
      expect(sheetLabel({ label: "x", printedRev: "3", currentRev: "4", fresh: false, retired: false, state: st }).ok, st).toBe(false);
    }
  });
  it("integration fix — a sheet whose status the vocabulary does not know reads 'STATUS NOT RECOGNISED', as /verify says, never 'NOT ISSUED' (VFY-20); the pack verdict and its colour are unchanged", () => {
    const row = { label: "x", printedRev: "3", currentRev: "3", fresh: false, retired: false };
    expect(sheetLabel({ ...row, state: "status_unrecognised" })).toEqual({ text: "STATUS NOT RECOGNISED", ok: false });
    // the same words the single-sheet page uses for that status
    expect(presentDocVerdict(doc({ verdict: "not_issued", isCurrent: false, docStatus: "IFC" })).headline).toBe("STATUS NOT RECOGNISED");
    // a status the vocabulary names keeps its own label
    expect(sheetLabel({ ...row, state: "not_issued" }).text).toBe("NOT ISSUED");
    expect(sheetLabel({ ...row, state: "draft" }).text).toBe("DRAFT — NOT ISSUED");
    // the pack around it: still red, still counted with the not-issued sheets
    const view = presentPackVerdict(pack({ verdict: "stale", staleCount: 1, notIssuedCount: 1, sheetCount: 2, sheets: [{ ...row, state: "status_unrecognised" }] }));
    expect(view.bg).toBe("bg-red-600");
    expect(view.headline).toBe("PACK HAS UNISSUED SHEETS");
  });
});

const hold = (over: Partial<HoldVerifyResult> = {}): HoldVerifyResult => ({
  active: false, reason: "Missing Vendor Data", openedAt: null, releasedAt: null, docLabel: "V-101", docRev: "5", checkedAt: "x", ...over,
});

describe("presentHoldVerdict — /verify-hold/[holdId] (VFY-10 / PHYS-10)", () => {
  it("green and 'this tag can come down' ONLY when released with zero other holds", () => {
    const released = presentHoldVerdict(hold({ verdict: "released" }));
    expect(released.bg).toBe(GREEN);
    expect(released.blurb).toContain("this tag can come down");
    for (const v of ["active", "released_others_active", "released_others_unknown"] as const) {
      const view = presentHoldVerdict(hold({ verdict: v, otherActiveHolds: 1 }));
      expect(view.bg, v).not.toBe(GREEN);
      expect(view.blurb, v).not.toContain("this tag can come down");
    }
  });
  it("released with siblings is amber, counts them and says to leave the equipment tagged", () => {
    const view = presentHoldVerdict(hold({ verdict: "released_others_active", otherActiveHolds: 2, otherHoldReasons: ["Field Verification Needed"] }));
    expect(view.bg).toBe("bg-amber-500");
    expect(view.blurb).toContain("2 other holds are still active");
    expect(view.blurb).toContain("(Field Verification Needed)");
    expect(view.blurb).toContain("leave the equipment tagged");
  });
  it("released over a document held only by its (unnamed) legal hold — counted as one other hold, never '0 other holds'", () => {
    const one = presentHoldVerdict(hold({ verdict: "released_others_active", otherActiveHolds: 1, otherHoldReasons: [] }));
    expect(one.bg).toBe("bg-amber-500");
    expect(one.blurb).toContain("1 other hold is still active on this document.");
    expect(one.blurb).not.toContain("this tag can come down");
    const zero = presentHoldVerdict(hold({ verdict: "released_others_active", otherActiveHolds: 0 }));
    expect(zero.blurb).toContain("another hold is still active");
    expect(zero.blurb).not.toMatch(/\b0 other/);
  });
  it("a legacy payload with no verdict, or an unknown verdict, is never green", () => {
    expect(presentHoldVerdict(hold({ verdict: undefined, active: false })).bg).not.toBe(GREEN);
    expect(presentHoldVerdict(hold({ verdict: "brand_new" as HoldVerifyResult["verdict"] })).bg).not.toBe(GREEN);
    expect(presentHoldVerdict(hold({ verdict: undefined, active: true })).headline).toBe("HOLD ACTIVE");
  });
  it("the hold page renders the withheld reason as 'read it on the tag' and the held-vs-current rev", () => {
    const src = readFileSync(join(process.cwd(), "app/verify-hold/[holdId]/page.tsx"), "utf8");
    expect(src).toContain('result.reasonWithheld ? "Not shown online — read it on the printed tag"');
    expect(src).toContain("Held at Rev {result.heldRev}");
    expect(src).toContain("presentHoldVerdict(result)");
    expect(src).not.toMatch(/result\?\.active \? "bg-red-600" : "bg-emerald-600"/);
  });
});
