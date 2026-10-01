// public-surfaces Round F PS-VERIFY — what the three scan-landing pages
// paint (lib/verifyPresent.ts): GREEN only when the endpoint KNOWS the paper
// is good; every other verdict — and any verdict this build does not know —
// is not green. (VFY-1 / VFY-3 / VFY-8 / VFY-9 / VFY-10 / VFY-11; PHYS-10.)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  presentDocVerdict, presentPackVerdict, presentHoldVerdict, sheetLabel, formatEffectiveDay,
  type DocVerifyResult, type PackVerifyResult, type HoldVerifyResult, type DocVerdict, type PackVerdict,
} from "@/lib/verifyPresent";

const doc = (over: Partial<DocVerifyResult> = {}): DocVerifyResult => ({
  docNumber: "P-101", title: "P&ID", printedRev: "5", printedAt: null, currentRev: "5", currentIssuedAt: null,
  effectiveDate: null, notYetEffective: false, docStatus: "Issued", isCurrent: true, checkedAt: "2026-10-01T00:00:00Z", ...over,
});
const GREEN = "bg-emerald-600";

describe("presentDocVerdict — /verify/[docId]", () => {
  it("green ONLY for 'current'", () => {
    const all: DocVerdict[] = ["current", "not_yet_effective", "held", "superseded", "void", "archived", "retired", "draft", "not_issued", "superseded_version", "unverifiable"];
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
    for (const v of ["superseded_version", "unverifiable", "current"] as DocVerdict[]) {
      expect(presentDocVerdict(doc({ verdict: v, printedRev: null, currentRev: null })).blurb).not.toContain("Rev ?");
    }
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
    const all: PackVerdict[] = ["current", "not_yet_effective", "stale", "held", "closed", "empty", "unconfirmed_print", "unverifiable"];
    for (const v of all) expect(presentPackVerdict(pack({ verdict: v })).bg === GREEN, v).toBe(v === "current");
    expect(presentPackVerdict(pack({ verdict: "brand_new" as PackVerdict })).bg).not.toBe(GREEN);
  });
  it("VFY-11: an empty pack has its own headline — the '0 of 0' sentence is unreachable", () => {
    const view = presentPackVerdict(pack({ verdict: "empty", sheetCount: 0, staleCount: 0, sheets: [], allFresh: false }));
    expect(view.headline).toBe("NO SHEETS IN THIS PACK");
    expect(view.bg).not.toBe("bg-red-600");
    expect(view.blurb).not.toMatch(/0 of 0/);
    // and a stale pack never says "0 of N" either: the count is only printed when non-zero
    expect(presentPackVerdict(pack({ verdict: "stale", staleCount: 0, addedSincePrint: [{ label: "P-102" }] })).blurb).not.toMatch(/\b0 of\b/);
  });
  it("VFY-8: a closed pack says so in the headline and is not green", () => {
    const view = presentPackVerdict(pack({ verdict: "closed", closed: true }));
    expect(view.headline).toBe("PACKAGE CLOSED — DO NOT WORK FROM IT");
    expect(view.advice).toMatch(/no longer watched/);
  });
  it("VFY-2: a legacy cover QR says it cannot confirm which printing", () => {
    expect(presentPackVerdict(pack({ verdict: "unconfirmed_print" })).headline).toBe("CAN'T CONFIRM WHICH PRINTING");
  });
  it("stale names both the changed sheets and the sheets added since printing", () => {
    const b = presentPackVerdict(pack({ verdict: "stale", staleCount: 1, sheetCount: 3, addedSincePrint: [{ label: "P-9" }, { label: "P-10" }] })).blurb;
    expect(b).toContain("1 of 3 sheets changed or withdrawn since this pack was printed");
    expect(b).toContain("2 sheets added to the package since printing are not in this pack");
  });
  it("sheetLabel: only a fresh sheet is ok; held names its categories; a legacy row says the printing is unknown", () => {
    expect(sheetLabel({ label: "x", printedRev: "4", currentRev: "4", fresh: true, retired: false, state: "fresh" })).toEqual({ text: "Rev 4 ✓", ok: true });
    expect(sheetLabel({ label: "x", printedRev: "4", currentRev: "4", fresh: false, retired: false, state: "held", holdReasons: ["Client Review"] }).text).toBe("ON HOLD · Client Review");
    expect(sheetLabel({ label: "x", printedRev: null, currentRev: "4", fresh: false, retired: false, state: "unconfirmed" }).text).toBe("now Rev 4 · printing unknown");
    for (const st of ["void", "draft", "not_issued", "removed", "missing", "stale", "not_yet_effective"] as const) {
      expect(sheetLabel({ label: "x", printedRev: "3", currentRev: "4", fresh: false, retired: false, state: st }).ok, st).toBe(false);
    }
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
