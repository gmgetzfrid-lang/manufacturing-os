import { describe, it, expect } from "vitest";
import { blankMaterial, specIncomplete, statusAllowed, settle, questionAgeH, late, attention, summarize, ageWord, type MaterialFields } from "@/lib/materials";

const now = Date.parse("2026-10-20T12:00:00Z");
const row = (x: Partial<MaterialFields>): MaterialFields => ({ ...blankMaterial(null), item: "Flange", spec: "6 in 300# RF", owner: "Planner", needBy: "2026-10-24", status: "ready", ...x });

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
    expect(late(row({ needBy: "2026-10-24", eta: "2026-10-23", status: "ordered" }), now)).toBe(false);
  });
  it("says why a row needs someone, and counts the register", () => {
    expect(attention(row({ owner: "", needBy: null }), now)).toEqual(["No owner", "No need-by date"]);
    expect(attention(row({ status: "checked" }), now)).toEqual([]);
    const s = summarize([row({ specMissing: "length" }), row({ kind: "offsite", status: "at_vendor", needBy: "2026-10-19" }), row({ status: "checked" }), row({ status: "cancelled", specMissing: "x" })], now);
    expect(s).toMatchObject({ lines: 3, materials: 2, offsite: 1, specIncomplete: 1, late: 1, received: 1, needAttention: 2 });
  });
});
