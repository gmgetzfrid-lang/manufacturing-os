// lib/__tests__/roleCapabilities.test.ts
//
// Freezes the additive-role capability model: the headline (primary) role
// ranking that RLS and legacy checks depend on, and the smart-picker guarantee
// that a role is only offered if it grants something new.

import { describe, it, expect } from "vitest";
import {
  capabilitiesFor,
  capabilitiesAdded,
  addableRoles,
  primaryRole,
  normalizeRoles,
  ROLE_CAPABILITIES,
} from "@/lib/roleCapabilities";
import { ALL_ROLES } from "@/types/schema";

describe("primaryRole — the headline that RLS reads", () => {
  it("picks the highest-ranked role in the collection", () => {
    expect(primaryRole(["Drafter", "Admin"])).toBe("Admin");
    expect(primaryRole(["Viewer", "Engineer-2", "Drafter"])).toBe("Engineer-2");
    expect(primaryRole(["Requester", "DraftingSupervisor"])).toBe("DraftingSupervisor");
  });

  it("falls back to Viewer for an empty collection", () => {
    expect(primaryRole([])).toBe("Viewer");
  });

  it("higher engineer levels outrank lower ones", () => {
    expect(primaryRole(["Engineer-1", "Engineer-4"])).toBe("Engineer-4");
  });
});

describe("capabilities union", () => {
  it("a Drafter+Engineer stack can draft AND sign off engineering", () => {
    const caps = capabilitiesFor(["Drafter", "Engineer-2"]);
    expect(caps.has("draft_work")).toBe(true);
    expect(caps.has("approve_engineering")).toBe(true);
  });

  it("capabilitiesAdded reports only NEW capabilities", () => {
    expect(capabilitiesAdded("Engineer-1", ["Admin"])).toEqual(["approve_engineering"]);
    // Engineer-2 adds nothing on top of Engineer-1 (same capability set).
    expect(capabilitiesAdded("Engineer-2", ["Engineer-1"])).toEqual([]);
  });
});

describe("addableRoles — the smart-picker guarantee", () => {
  it("never offers a role already held", () => {
    for (const r of ALL_ROLES) {
      expect(addableRoles([r])).not.toContain(r);
    }
  });

  it("never offers a role that adds zero capabilities", () => {
    for (const r of ALL_ROLES) {
      const current = [r];
      for (const candidate of addableRoles(current)) {
        expect(capabilitiesAdded(candidate, current).length).toBeGreaterThan(0);
      }
    }
  });

  it("an Admin is still offered the genuinely-different hats", () => {
    const offered = addableRoles(["Admin"]);
    expect(offered).toContain("Drafter");      // adds draft_work
    expect(offered).toContain("DocCtrl");      // adds doc_control
    expect(offered).toContain("Engineer-1");   // adds approve_engineering
    expect(offered).not.toContain("Requester"); // adds nothing over Admin
    expect(offered).not.toContain("Viewer");    // adds nothing at all
  });

  it("every role in the capability map is a known role", () => {
    for (const r of Object.keys(ROLE_CAPABILITIES)) {
      expect(ALL_ROLES).toContain(r);
    }
  });
});

describe("normalizeRoles — tolerant of pre-migration rows", () => {
  it("merges the roles[] collection with the legacy single role, deduped", () => {
    expect(normalizeRoles(["Drafter", "Admin"], "Admin")).toEqual(["Drafter", "Admin"]);
    expect(normalizeRoles(null, "Drafter")).toEqual(["Drafter"]);
    expect(normalizeRoles([], "Drafter")).toEqual(["Drafter"]);
  });

  it("drops unknown junk instead of crashing", () => {
    expect(normalizeRoles(["NotARole", "Drafter", 42], "AlsoNotARole")).toEqual(["Drafter"]);
    expect(normalizeRoles(undefined, undefined)).toEqual([]);
  });
});
