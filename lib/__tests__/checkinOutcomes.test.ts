import { describe, it, expect } from "vitest";
import {
  checkInCardsFor,
  mocRequirementFor,
  purposeGroup,
  validateCheckIn,
  type CheckInCard,
  type CheckInContext,
} from "@/lib/checkinOutcomes";
import { resolveEffectiveDocClass, suggestDocClass } from "@/lib/docClass";

const ctx = (over: Partial<CheckInContext> = {}): CheckInContext => ({
  purpose: "Revision / Update",
  docClass: null,
  canPublishEff: false,
  othersRemain: false,
  ...over,
});

const ids = (cards: CheckInCard[]) => cards.map((c) => c.id);
const recommendedOf = (cards: CheckInCard[]) => cards.filter((c) => c.recommended).map((c) => c.id);

describe("purposeGroup", () => {
  it("maps every checkout purpose to its group", () => {
    expect(purposeGroup("As-Built Verification")).toBe("asbuilt");
    expect(purposeGroup("Field Reference")).toBe("field");
    expect(purposeGroup("Review / Approval")).toBe("review");
    expect(purposeGroup("Revision / Update")).toBe("change");
    expect(purposeGroup("Redline / Markup")).toBe("change");
    expect(purposeGroup("Other")).toBe("generic");
    expect(purposeGroup("Quick Hold")).toBe("generic");
    expect(purposeGroup(null)).toBe("generic");
  });
});

describe("mocRequirementFor — the PSM gate", () => {
  it("requires an MOC position only for real changes to declared drawings", () => {
    expect(mocRequirementFor("drawing", "discrepancy")).toBe("required");
    expect(mocRequirementFor("drawing", "revision_requested")).toBe("required");
  });
  it("exempts minor corrections (replacement-in-kind)", () => {
    expect(mocRequirementFor("drawing", "correction_requested")).toBe("none");
  });
  it("never demands MOC from procedures or unclassified documents", () => {
    expect(mocRequirementFor("procedure", "revision_requested")).toBe("none");
    expect(mocRequirementFor(null, "revision_requested")).toBe("none");
    expect(mocRequirementFor(null, "discrepancy")).toBe("none");
  });
});

describe("checkInCardsFor — purpose-tuned card sets", () => {
  it("as-built walkdown gets exactly the walkdown question, attestation recommended", () => {
    const cards = checkInCardsFor(ctx({ purpose: "As-Built Verification", docClass: "drawing" }));
    expect(ids(cards)).toEqual(["field_verified", "discrepancy"]);
    expect(recommendedOf(cards)).toEqual(["field_verified"]);
    const disc = cards.find((c) => c.id === "discrepancy")!;
    expect(disc.moc).toBe("required");
    expect(disc.allowUploads).toBe(true);
    expect(disc.allowHoldOffer).toBe(true);
    expect(disc.ticketKind).toBe("asbuilt");
  });

  it("field reference defaults to done; attestation stays a deliberate act", () => {
    const cards = checkInCardsFor(ctx({ purpose: "Field Reference" }));
    expect(ids(cards)).toEqual(["all_clear", "field_verified", "discrepancy"]);
    expect(recommendedOf(cards)).toEqual(["all_clear"]);
  });

  it("review purpose offers pass / minor correction / real revision", () => {
    const cards = checkInCardsFor(ctx({ purpose: "Review / Approval", docClass: "drawing" }));
    expect(ids(cards)).toEqual(["all_clear", "correction", "revision"]);
    expect(cards.find((c) => c.id === "correction")!.moc).toBe("none");
    expect(cards.find((c) => c.id === "revision")!.moc).toBe("required");
  });

  it("drawing publisher sees publish first, but drafting stays a door", () => {
    const cards = checkInCardsFor(ctx({ docClass: "drawing", canPublishEff: true }));
    expect(ids(cards)).toEqual(["publish", "revision", "correction", "all_clear"]);
    expect(recommendedOf(cards)).toEqual(["publish"]);
    // MOC for a direct publish is enforced inside RevUpModal where changeType
    // is known — the card itself carries no MOC fields.
    expect(cards.find((c) => c.id === "publish")!.moc).toBe("none");
  });

  it("drawing non-publisher routes redlines to drafting with the MOC gate", () => {
    const cards = checkInCardsFor(ctx({ docClass: "drawing" }));
    expect(ids(cards)).toEqual(["revision", "correction", "all_clear"]);
    expect(recommendedOf(cards)).toEqual(["revision"]);
    const rev = cards.find((c) => c.id === "revision")!;
    expect(rev.moc).toBe("required");
    expect(rev.label).toContain("redlines");
  });

  it("procedure owner publishes directly; procedure non-owner routes to the owner", () => {
    const owner = checkInCardsFor(ctx({ docClass: "procedure", canPublishEff: true }));
    expect(ids(owner)).toEqual(["publish", "revision", "correction", "all_clear"]);
    const nonOwner = checkInCardsFor(ctx({ docClass: "procedure" }));
    expect(ids(nonOwner)).toEqual(["sent_to_owner", "all_clear"]);
    expect(recommendedOf(nonOwner)).toEqual(["sent_to_owner"]);
  });

  it("redline purpose reminds about attaching the markup file", () => {
    const cards = checkInCardsFor(ctx({ purpose: "Redline / Markup", docClass: "drawing" }));
    expect(cards.find((c) => c.id === "revision")!.hint).toContain("Download w/ Markup");
  });

  it("generic (quick hold / legacy) stays two cards, three for publishers", () => {
    expect(ids(checkInCardsFor(ctx({ purpose: "Quick Hold" })))).toEqual(["all_clear", "revision"]);
    expect(ids(checkInCardsFor(ctx({ purpose: null, canPublishEff: true }))))
      .toEqual(["all_clear", "revision", "publish"]);
  });

  it("handoff appears for every purpose when others remain, never otherwise", () => {
    for (const purpose of ["As-Built Verification", "Review / Approval", "Revision / Update", null]) {
      const with_ = checkInCardsFor(ctx({ purpose, othersRemain: true }));
      const without = checkInCardsFor(ctx({ purpose, othersRemain: false }));
      expect(ids(with_)).toContain("handoff");
      expect(ids(without)).not.toContain("handoff");
    }
  });

  it("every set is 2–5 cards with exactly one recommended", () => {
    const purposes = ["As-Built Verification", "Field Reference", "Review / Approval", "Revision / Update", "Redline / Markup", "Other", null];
    const classes = ["drawing", "procedure", null] as const;
    for (const purpose of purposes) for (const docClass of classes) for (const canPublishEff of [true, false]) for (const othersRemain of [true, false]) {
      const cards = checkInCardsFor(ctx({ purpose, docClass, canPublishEff, othersRemain }));
      expect(cards.length).toBeGreaterThanOrEqual(2);
      expect(cards.length).toBeLessThanOrEqual(5);
      expect(recommendedOf(cards)).toHaveLength(1);
      // Ids stay unique — duplicate cards would double-record outcomes.
      expect(new Set(ids(cards)).size).toBe(cards.length);
    }
  });

  it("no card ever offers canned text — claim branches all demand a typed note", () => {
    const purposes = ["As-Built Verification", "Field Reference", "Review / Approval", "Revision / Update", "Other"];
    for (const purpose of purposes) {
      for (const card of checkInCardsFor(ctx({ purpose, docClass: "drawing", othersRemain: true }))) {
        if (["discrepancy", "correction_requested", "revision_requested", "sent_to_owner", "handoff"].includes(card.outcome)) {
          expect(card.requiresNote).toBe(true);
        }
      }
    }
  });
});

describe("validateCheckIn — everything stated up front", () => {
  const drawingRevision = checkInCardsFor(ctx({ docClass: "drawing" }))
    .find((c) => c.id === "revision")!;

  it("demands the note before anything else", () => {
    expect(validateCheckIn(drawingRevision, { note: "no", mocStatus: "completed", mocNumber: "MOC-1" }))
      .toBeTruthy();
  });

  it("demands an MOC position on a drawing change", () => {
    const err = validateCheckIn(drawingRevision, { note: "reroute line 3 per field", mocStatus: null, mocNumber: "" });
    expect(err).toMatch(/MOC/);
  });

  it("demands the number when an MOC is claimed, but never blocks 'no MOC exists'", () => {
    expect(validateCheckIn(drawingRevision, { note: "reroute line 3 per field", mocStatus: "completed", mocNumber: "" }))
      .toMatch(/number/);
    expect(validateCheckIn(drawingRevision, { note: "reroute line 3 per field", mocStatus: "none", mocNumber: "" }))
      .toBeNull();
    expect(validateCheckIn(drawingRevision, { note: "reroute line 3 per field", mocStatus: "in_progress", mocNumber: "MOC-2026-014" }))
      .toBeNull();
  });

  it("passes clean branches with nothing typed", () => {
    const allClear = checkInCardsFor(ctx({ purpose: "Field Reference" })).find((c) => c.id === "all_clear")!;
    expect(validateCheckIn(allClear, { note: "", mocStatus: null, mocNumber: "" })).toBeNull();
  });
});

describe("docClass resolution + suggestion", () => {
  it("most specific defined level wins, like review_control", () => {
    expect(resolveEffectiveDocClass("procedure", "drawing", "drawing")).toBe("procedure");
    expect(resolveEffectiveDocClass(null, "drawing", "procedure")).toBe("drawing");
    expect(resolveEffectiveDocClass(null, null, "procedure")).toBe("procedure");
    expect(resolveEffectiveDocClass(null, null, null)).toBeNull();
    // Junk values never resolve to a class.
    expect(resolveEffectiveDocClass("p&id", null, null)).toBeNull();
  });

  it("suggests from CAD source custody and file type — evidence, not guesswork", () => {
    expect(suggestDocClass({ sourceFileName: "U300-PID-001.dwg" })).toBe("drawing");
    expect(suggestDocClass({ fileType: "dxf" })).toBe("drawing");
    expect(suggestDocClass({ fileType: ".docx" })).toBe("procedure");
    expect(suggestDocClass({ fileType: "pdf" })).toBeNull(); // a PDF proves nothing
    expect(suggestDocClass({})).toBeNull();
  });
});
