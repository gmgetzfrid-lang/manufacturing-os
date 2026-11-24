import { describe, it, expect } from "vitest";
import {
  blankMaterial, specIncomplete, statusAllowed, settle, questionAgeH, late, attention, summarize, ageWord, holder, nextStatus, closed, arrived,
  parseDay, pastedLines, STATUSES, STATUS_WORD, type MaterialFields,
} from "@/lib/materials";

const now = Date.parse("2026-10-20T12:00:00Z");
const row = (x: Partial<MaterialFields>): MaterialFields => ({ ...blankMaterial(null), item: "Flange", spec: "6 in 300# RF", owner: "Planner", crewOwner: "Crew lead", needBy: "2026-10-24", status: "ready", ...x });

describe("materials register rules", () => {
  it("a specification with something missing can't be ordered", () => {
    const flange = row({ specMissing: "length", status: "ordered" });
    expect(specIncomplete(flange)).toBe(true);
    expect(statusAllowed(flange, "ordered")).toBe(false);
    expect(statusAllowed(flange, "to_specify")).toBe(true);
    // Saved, it is held at Spec incomplete whatever was picked.
    expect(settle(flange).status).toBe("to_specify");
    // Completed, it moves on by itself.
    expect(settle(row({ status: "to_specify" })).status).toBe("ready");
    expect(settle(row({ kind: "offsite", spec: "", status: "to_specify" })).status).toBe("at_vendor");
    expect(specIncomplete(row({ spec: "" }))).toBe(true);
  });
  it("a question's clock runs until it is answered", () => {
    const asked = row({ question: "How long is the weld neck?", questionAt: now - 50 * 3_600_000 });
    expect(Math.round(questionAgeH(asked, now))).toBe(50);
    expect(attention(asked, now)).toContain("Question open 2 days");
    expect(questionAgeH({ ...asked, answer: "9 in" }, now)).toBe(0);
    expect(ageWord(30)).toBe("30 h");
  });
  it("late: past its need-by date, or due to arrive after it", () => {
    expect(late(row({ needBy: "2026-10-19", status: "ordered" }), now)).toBe(true);
    expect(late(row({ needBy: "2026-10-24", eta: "2026-10-26", status: "at_vendor" }), now)).toBe(true);
    expect(late(row({ needBy: "2026-10-19", status: "received" }), now)).toBe(false);
    expect(late(row({ needBy: "2026-10-19", status: "used" }), now)).toBe(false);
    expect(late(row({ needBy: "2026-10-24", eta: "2026-10-23", status: "ordered" }), now)).toBe(false);
  });
  it("two owners: a line missing either one needs someone", () => {
    expect(attention(row({ owner: "", needBy: null }), now)).toEqual(["No warehouse owner", "No need-by date"]);
    expect(attention(row({ crewOwner: "" }), now)).toEqual(["No crew owner"]);
    expect(attention(row({ owner: "", crewOwner: "" }), now)).toEqual(["No warehouse owner", "No crew owner"]);
    // Received and checked is not the end: it still needs its crew owner.
    expect(attention(row({ status: "checked", crewOwner: "" }), now)).toEqual(["No crew owner"]);
    expect(attention(row({ status: "checked" }), now)).toEqual([]);
  });
  it("closes the loop: the crew owner marks it used on the job after it is received and checked", () => {
    expect(STATUSES.indexOf("used")).toBe(STATUSES.indexOf("checked") + 1);
    expect(STATUS_WORD.used).toBe("Used on the job");
    expect(holder(row({ status: "ordered" }))).toBe("warehouse");
    expect(holder(row({ status: "received" }))).toBe("warehouse");
    expect(holder(row({ status: "checked" }))).toBe("crew");
    expect(holder(row({ status: "used" }))).toBeNull();
    expect(nextStatus(row({ status: "received" }))).toBe("checked");
    expect(nextStatus(row({ status: "checked" }))).toBe("used");
    expect(nextStatus(row({ status: "used" }))).toBeNull();
    expect(nextStatus(row({ status: "ordered" }))).toBeNull();
    // Only a line with a crew owner can be marked used.
    expect(statusAllowed(row({ crewOwner: "" }), "used")).toBe(false);
    expect(statusAllowed(row({}), "used")).toBe(true);
    // Used is in hand and done; it needs no one.
    expect(arrived("used")).toBe(true);
    expect(closed("used")).toBe(true);
    expect(closed("checked")).toBe(false);
    expect(attention(row({ status: "used", owner: "" }), now)).toEqual([]);
  });
  it("counts the register", () => {
    const s = summarize([
      row({ specMissing: "length" }),
      row({ kind: "offsite", status: "at_vendor", needBy: "2026-10-19" }),
      row({ status: "checked" }),
      row({ status: "used" }),
      row({ status: "ordered", crewOwner: "" }),
      row({ status: "cancelled", specMissing: "x" }),
    ], now);
    expect(s).toMatchObject({ lines: 5, materials: 4, offsite: 1, specIncomplete: 1, late: 1, received: 1, used: 1, noOwner: 1, needAttention: 3 });
  });
});

describe("lines typed or pasted like a spreadsheet", () => {
  const today = "2026-11-24";
  it("reads the dates people type in a spreadsheet", () => {
    expect(parseDay("2026-11-30", today)).toBe("2026-11-30");
    expect(parseDay("11/30/2026", today)).toBe("2026-11-30");
    expect(parseDay("11/30/26", today)).toBe("2026-11-30");
    expect(parseDay("12/3", today)).toBe("2026-12-03");
    expect(parseDay("Nov 30, 2026", today)).toBe("2026-11-30");
    expect(parseDay("Dec 3", today)).toBe("2026-12-03");
    expect(parseDay("30-Nov-26", today)).toBe("2026-11-30");
    expect(parseDay("3 December 2026", today)).toBe("2026-12-03");
    expect(parseDay("2/30/2027", today)).toBeNull();
    expect(parseDay("ASAP", today)).toBeNull();
    expect(parseDay("", today)).toBeNull();
  });
  it("adds pasted rows in the add row's order, skipping a header and blank items", () => {
    const got = pastedLines([
      ["Item", "Qty", "Work order", "Need-by"],
      ["Spiral wound gaskets", "24", "E-12", "11/30/2026"],
      ["Stud bolts", "48", "E-12", "next week"],
      ["", "3", "E-17", ""],
      ["Seal rings"],
    ], today);
    expect(got.header).toBe(true);
    expect(got.lines).toEqual([
      { item: "Spiral wound gaskets", qty: "24", workOrder: "E-12", needBy: "2026-11-30" },
      { item: "Stud bolts", qty: "48", workOrder: "E-12", needBy: null },
      { item: "Seal rings", qty: "", workOrder: "", needBy: null },
    ]);
    expect(got.badDates).toEqual(["next week"]);
    expect(got.noItem).toBe(1);
  });
});
