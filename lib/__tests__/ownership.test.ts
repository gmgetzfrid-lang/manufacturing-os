// Owner resolution + ownership register CSV (GAP-12, DEL-8 regression class).
//
// resolveOwnerForNode is the pure resolver behind the permissions console's
// owner columns and the ownership export. Its contract encodes the DEL-8
// lesson: owner EXISTENCE comes from owner_user_id (and the team rung from
// owner_team_id + a supervisor), never from the owner_name snapshot — the
// exact inversion RoleModelTree used to render ("ownerName || team").

import { describe, it, expect } from "vitest";
import {
  resolveOwnerForNode,
  resolveEffectiveOwner,
  ownershipRegisterToCsv,
  type OwnershipRegisterRow,
} from "@/lib/ownership";

describe("resolveOwnerForNode", () => {
  it("walks document > folder > library > team supervisor", () => {
    const lib = { owner_user_id: "u-lib", owner_team_id: "t1" };
    expect(resolveOwnerForNode({ owner_user_id: "u-doc" }, { owner_user_id: "u-folder" }, lib, "u-sup"))
      .toEqual({ userId: "u-doc", source: "document" });
    expect(resolveOwnerForNode(null, { owner_user_id: "u-folder" }, lib, "u-sup"))
      .toEqual({ userId: "u-folder", source: "collection" });
    expect(resolveOwnerForNode(null, null, lib, "u-sup"))
      .toEqual({ userId: "u-lib", source: "library" });
    expect(resolveOwnerForNode(null, null, { owner_team_id: "t1" }, "u-sup"))
      .toEqual({ userId: "u-sup", source: "team" });
    expect(resolveOwnerForNode(null, null, null)).toEqual({ userId: null, source: null });
  });

  it("owner_user_id set with owner_name null still resolves as owned (DEL-8)", () => {
    const r = resolveOwnerForNode(null, null, { owner_user_id: "u-lib", owner_name: null } as never);
    expect(r).toEqual({ userId: "u-lib", source: "library" });
  });

  it("a team-owned library with NO supervisor is unowned — never a phantom owner", () => {
    expect(resolveOwnerForNode(null, null, { owner_team_id: "t1" }, null))
      .toEqual({ userId: null, source: null });
  });

  it("a folder under an owned library inherits (source 'library'), a folder with its own owner wins", () => {
    expect(resolveOwnerForNode(null, null, { owner_user_id: "u-lib" }))
      .toEqual({ userId: "u-lib", source: "library" });
    expect(resolveOwnerForNode(null, { owner_user_id: "u-folder" }, { owner_user_id: null }))
      .toEqual({ userId: "u-folder", source: "collection" });
  });
});

describe("resolveEffectiveOwner (existing resolver, previously untested)", () => {
  it("most specific set owner wins and carries its snapshot name", () => {
    const r = resolveEffectiveOwner(null, { owner_user_id: "u-f", owner_name: "Fol Der" }, { owner_user_id: "u-l" });
    expect(r).toEqual({ userId: "u-f", name: "Fol Der", source: "collection" });
  });
  it("no owner anywhere → null/null/null (falls to Admin/DocCtrl)", () => {
    expect(resolveEffectiveOwner(null, null, null)).toEqual({ userId: null, name: null, source: null });
  });
});

describe("ownershipRegisterToCsv", () => {
  const rows: OwnershipRegisterRow[] = [
    { nodeType: "library", name: "Drawings", ownerUserId: "u1", ownerName: "Ann Chen", source: "library" },
    { nodeType: "folder", name: 'North "Flare", Unit 2', libraryName: "Drawings", ownerUserId: null, ownerName: null, source: null },
    { nodeType: "document", name: "P-200-301", documentNumber: "P-200-301", libraryName: "Drawings", ownerUserId: "u2", ownerName: null, source: "team" },
  ];

  it("emits a header and one line per row", () => {
    const csv = ownershipRegisterToCsv(rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Type,Name,Document #,Library,Owner,Owner source");
    expect(lines).toHaveLength(4);
  });

  it("escapes quotes and commas", () => {
    const csv = ownershipRegisterToCsv(rows);
    expect(csv).toContain('"North ""Flare"", Unit 2"');
  });

  it("unowned rows print the Admin/DocCtrl fallback; owned-but-unnamed rows never look unowned", () => {
    const csv = ownershipRegisterToCsv(rows);
    const lines = csv.split("\n");
    expect(lines[2]).toContain("— (falls to Admin/DocCtrl)");
    expect(lines[2]).toContain("unowned");
    expect(lines[3]).toContain("assigned member");
    expect(lines[3]).toContain("team");
  });
});
