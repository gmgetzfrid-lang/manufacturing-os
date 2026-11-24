import { describe, it, expect } from "vitest";
import { reminderFor, daysTo, REMIND_DAYS } from "@/lib/materialReminders";
import { verifyDate, unverified, attention, blankMaterial, VERIFY_LEAD_DAYS, type MaterialFields } from "@/lib/materials";

const now = Date.parse("2026-11-24T15:00:00Z");

describe("verify-by date", () => {
  it("is the line's own, else the need-by date less the lead days", () => {
    expect(verifyDate({ verifyBy: "2026-12-01", needBy: "2026-12-20" })).toBe("2026-12-01");
    expect(VERIFY_LEAD_DAYS).toBe(14);
    expect(verifyDate({ verifyBy: null, needBy: "2026-12-20" })).toBe("2026-12-06");
    expect(verifyDate({ verifyBy: null, needBy: null })).toBeNull();
  });
  it("past it and not checked needs someone; checked does not", () => {
    const row = (x: Partial<MaterialFields>): MaterialFields => ({ ...blankMaterial(null), item: "Seal rings", spec: "Per task sheet", owner: "Pat", crewOwner: "Lee", needBy: "2026-12-20", status: "ordered", ...x });
    expect(unverified(row({ verifyBy: "2026-11-20" }), now)).toBe(true);
    expect(attention(row({ verifyBy: "2026-11-20" }), now)).toContain("Not checked by 2026-11-20");
    expect(unverified(row({ verifyBy: "2026-11-20", status: "checked" }), now)).toBe(false);
    expect(unverified(row({ verifyBy: "2026-11-30" }), now)).toBe(false);
  });
});

describe("the warehouse owner's reminder", () => {
  it("starts REMIND_DAYS before the date and goes on after it", () => {
    expect(REMIND_DAYS).toBe(3);
    expect(daysTo("2026-11-27", now)).toBe(3);
    expect(reminderFor({ item: "Seal rings", status: "ordered", need_by: null, verify_by: "2026-11-28" }, now)).toBeNull();
    expect(reminderFor({ item: "Seal rings", status: "ordered", need_by: null, verify_by: "2026-11-27" }, now)?.title).toBe("Seal rings: to be checked by Fri, Nov 27");
    expect(reminderFor({ item: "Seal rings", status: "ordered", need_by: null, verify_by: "2026-11-24" }, now)?.title).toBe("Seal rings: to be checked today");
    expect(reminderFor({ item: "Seal rings", status: "ordered", need_by: null, verify_by: "2026-11-22" }, now)?.body).toMatch(/2 days ago/);
  });
  it("none once it is checked, used or cancelled, or with no date at all", () => {
    for (const status of ["checked", "used", "cancelled"] as const) expect(reminderFor({ item: "X", status, need_by: null, verify_by: "2026-11-20" }, now)).toBeNull();
    expect(reminderFor({ item: "X", status: "ordered", need_by: null, verify_by: null }, now)).toBeNull();
  });
  it("works from the need-by date when no verify-by date is set", () => {
    // Need-by Dec 7: verify by Nov 23, a day past.
    expect(reminderFor({ item: "Studs", status: "ready", need_by: "2026-12-07" }, now)?.title).toBe("Studs: not checked, due Mon, Nov 23");
  });
});
