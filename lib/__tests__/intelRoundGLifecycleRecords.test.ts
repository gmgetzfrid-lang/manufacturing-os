// lib/__tests__/intelRoundGLifecycleRecords.test.ts
//
// intelligence Round G, package I-01 phase B — record pins for two closures
// this package verified on the merged tree and found unpinned:
//
//   DACL-7 criterion 3  the export role list and the ACL controller tier
//                       cannot drift apart: every role the data-export
//                       surface admits is a controller (lib/permissions.ts
//                       isControllerRole), so no export can carry a row its
//                       exporter could not read in the app.
//   IRLS-12 criterion 3 the skill libraries tell "not installed" (a missing
//                       table: null) from "nothing here yet" (an empty
//                       shelf: []), as lib/processFlows.ts does (I-09's
//                       limb, pinned in processFlowsLib.test.ts). A missing
//                       COLUMN is still read as "not installed" there: an
//                       expected-fail tripwire pins that open residual.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "@/types/schema";

type Answer = { data: unknown[] | null; error: { code?: string; message?: string } | null };
const state = vi.hoisted(() => ({ answer: null as null | ((table: string) => Answer) }));
vi.mock("@/lib/supabase", () => {
  const chainFor = (table: string): unknown => {
    const chain: unknown = new Proxy({}, {
      get: (_t, key: string) => {
        if (key === "then") {
          return (res: (v: unknown) => void, rej: (e: unknown) => void) => {
            try { res(state.answer!(table)); } catch (e) { rej(e); }
          };
        }
        return () => chain;
      },
    });
    return chain;
  };
  return { supabase: { from: (table: string) => chainFor(table) } };
});

import { adminSurface } from "@/lib/adminSurfaces";
import { isControllerRole } from "@/lib/permissions";
import { listLinkRules } from "@/lib/linkRules";
import { listAnswerSkills } from "@/lib/answerSkills";

beforeEach(() => { state.answer = null; });

describe("DACL-7 criterion 3 — the export role list and the ACL controller tier cannot drift apart", () => {
  it("every role the data-export surface admits is an ACL controller (isControllerRole)", () => {
    const entry = adminSurface("data-export")!.entry;
    expect(entry).not.toBe("*");
    expect((entry as Role[]).length).toBeGreaterThan(0);
    for (const role of entry as Role[]) expect(isControllerRole(role), `${role} may export but is not an ACL controller`).toBe(true);
  });

  it("Manager — the role the finding named — is not admitted, and is not a controller", () => {
    expect(adminSurface("data-export")!.entry).not.toContain("Manager");
    expect(isControllerRole("Manager" as Role)).toBe(false);
  });
});

describe("IRLS-12 criterion 3 — the skill libraries tell a missing table from an empty shelf", () => {
  const missingTable = (): Answer => ({ data: null, error: { code: "42P01", message: 'relation "public.x" does not exist' } });
  const empty = (): Answer => ({ data: [], error: null });

  it.each([
    ["link_rules", () => listLinkRules("org-1", "u-1")],
    ["answer_skills", () => listAnswerSkills("org-1", "u-1")],
  ] as const)("%s: a missing table is null ('not installed'); an empty shelf is []", async (_table, list) => {
    state.answer = missingTable;
    expect(await list()).toBeNull();
    state.answer = empty;
    expect(await list()).toEqual([]);
  });

  it.each([
    ["link_rules", () => listLinkRules("org-1", "u-1")],
    ["answer_skills", () => listAnswerSkills("org-1", "u-1")],
  ] as const)("%s: any other read failure is thrown, never shown as empty or 'not installed'", async (_table, list) => {
    state.answer = () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    await expect(list()).rejects.toThrow(/statement timeout/);
  });

  // Residual (review fix pass), owned on the IRLS-12 record: the skill
  // libraries' `missing` test is `/does not exist/`, which a missing COLUMN
  // (42703, e.g. an order column) also matches, so such a read would say
  // "not installed" instead of the error. lib/processFlows.ts was tightened
  // against exactly this. Expected to fail until the owner tightens
  // `missing` in lib/linkRules.ts and lib/answerSkills.ts; then flip to `it`.
  it.fails.each([
    ["link_rules", () => listLinkRules("org-1", "u-1")],
    ["answer_skills", () => listAnswerSkills("org-1", "u-1")],
  ] as const)("%s: a missing COLUMN (42703) is thrown, never shown as 'not installed' (open residual)", async (table, list) => {
    state.answer = () => ({ data: null, error: { code: "42703", message: `column ${table}.builtin_key does not exist` } });
    await expect(list()).rejects.toThrow(/builtin_key does not exist/);
  });
});
