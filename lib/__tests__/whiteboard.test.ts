// lib/__tests__/whiteboard.test.ts
//
// Pure-function test for the whiteboard state-advance cycle.
// nextState is what powers one-click state changes; a bug here
// would silently put equipment into the wrong column.

import { describe, it, expect } from "vitest";
import {
  nextState, ADVANCEABLE_STATES, ALL_STATES,
  STATE_LABEL, STATE_TONE,
} from "@/lib/whiteboard";

describe("nextState", () => {
  it("advances pending → drafting → executing → completed → pending", () => {
    expect(nextState("pending")).toBe("drafting");
    expect(nextState("drafting")).toBe("executing");
    expect(nextState("executing")).toBe("completed");
    expect(nextState("completed")).toBe("pending");
  });

  it("treats blocked as a sink — click cycles to pending", () => {
    expect(nextState("blocked")).toBe("pending");
  });

  it("only cycles through the advanceable states (blocked is excluded)", () => {
    let cur = nextState("pending");
    const visited: string[] = [cur];
    for (let i = 0; i < 10 && cur !== "pending"; i++) {
      cur = nextState(cur);
      visited.push(cur);
    }
    expect(visited).not.toContain("blocked");
  });
});

describe("state metadata", () => {
  it("every advanceable state has a label", () => {
    for (const s of ADVANCEABLE_STATES) {
      expect(STATE_LABEL[s]).toBeTruthy();
    }
  });

  it("every state has a tone", () => {
    for (const s of ALL_STATES) {
      expect(STATE_TONE[s]).toBeTruthy();
    }
  });

  it("ALL_STATES is a superset of ADVANCEABLE_STATES + blocked", () => {
    expect(new Set(ALL_STATES)).toEqual(new Set([...ADVANCEABLE_STATES, "blocked"]));
  });
});
