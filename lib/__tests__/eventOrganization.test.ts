import { describe, it, expect } from "vitest";
import { cleanOrg, defaultRoles, orgStanding } from "@/lib/eventOrganization";

describe("event organization", () => {
  it("nothing counts until one is saved", () => {
    expect(cleanOrg(undefined)).toBe(null);
    expect(orgStanding(null)).toMatchObject({ recorded: false, required: 0, filled: 0, missing: [] });
  });
  it("counts the required roles and names the ones with no person", () => {
    const roles = defaultRoles().map((r) => (r.id === "manager" ? { ...r, person: "G. Getzfrid" } : r.id === "logistics" ? { ...r, person: " " } : r));
    const st = orgStanding(roles);
    expect(st.recorded).toBe(true);
    expect([st.required, st.filled]).toEqual([7, 1]);
    expect(st.missing).toContain("Logistics and materials coordinator");
    expect(st.missing).not.toContain("Turnaround manager");
    // A role that isn't required is never missing.
    expect(st.missing).not.toContain("Cleaning supervisor");
  });
  it("reads back only what belongs in one", () => {
    const back = cleanOrg({ roles: [{ id: "a", role: " Planner ", does: "Schedule", person: "Sam", required: true }, { id: "b", role: "" }, "junk", { role: "No id" }] });
    expect(back).toEqual([{ id: "a", role: "Planner", does: "Schedule", person: "Sam", required: true }]);
  });
});
