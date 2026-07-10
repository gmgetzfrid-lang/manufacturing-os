// lib/__tests__/restoreRemapDeep.test.ts
//
// The restore uid remap must reach EVERYWHERE a user id can hide: top-level
// columns of any name (owner_user_id, supervisor_user_id, checked_out_by, …),
// uid arrays (unread_by), and deep inside JSONB policies (ack rosters'
// assigneeIds, review-control reviewer lists, draft viewers). The old
// implementation used a 14-column allowlist and silently missed the rest —
// restored ownership and rosters pointed at dead uids.

import { describe, it, expect } from "vitest";
import { remapRow } from "@/lib/dataRestore";

const OLD_A = "11111111-1111-4111-8111-111111111111";
const NEW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OLD_B = "22222222-2222-4222-8222-222222222222";
const NEW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const remap = {
  orgId: { "org-old": "org-new" },
  uid: { [OLD_A]: NEW_A, [OLD_B]: NEW_B },
};

describe("remapRow deep uid remapping", () => {
  it("remaps org_id and classic uid columns", () => {
    const out = remapRow({ org_id: "org-old", created_by: OLD_A, user_id: OLD_B }, remap);
    expect(out).toEqual({ org_id: "org-new", created_by: NEW_A, user_id: NEW_B });
  });

  it("remaps columns that were missing from the old allowlist", () => {
    const out = remapRow(
      { owner_user_id: OLD_A, supervisor_user_id: OLD_B, checked_out_by: OLD_A, signer_user_id: OLD_B },
      remap,
    );
    expect(out).toEqual({
      owner_user_id: NEW_A, supervisor_user_id: NEW_B, checked_out_by: NEW_A, signer_user_id: NEW_B,
    });
  });

  it("remaps uids inside JSONB policies (ack rosters, review control)", () => {
    const out = remapRow(
      {
        ack_policy: { mode: "hard", assigneeIds: [OLD_A, OLD_B], assigneeRoles: ["Operator"] },
        review_control: { reviewers: [{ userId: OLD_A, slot: "primary" }], alternates: [OLD_B] },
      },
      remap,
    );
    expect(out.ack_policy).toEqual({ mode: "hard", assigneeIds: [NEW_A, NEW_B], assigneeRoles: ["Operator"] });
    expect(out.review_control).toEqual({ reviewers: [{ userId: NEW_A, slot: "primary" }], alternates: [NEW_B] });
  });

  it("remaps uid arrays (unread_by)", () => {
    const out = remapRow({ unread_by: [OLD_A, OLD_B, "someone-else"] }, remap);
    expect(out.unread_by).toEqual([NEW_A, NEW_B, "someone-else"]);
  });

  it("leaves unmapped uids and ordinary values untouched", () => {
    const row = {
      created_by: "33333333-3333-4333-8333-333333333333", // unknown uid → new-user, resolved later
      title: "P&ID sheet 12",
      size: 12345,
      flag: true,
      nothing: null,
      meta: { note: "unchanged", count: 2 },
    };
    const out = remapRow(row, remap);
    expect(out).toEqual(row);
  });

  it("never mutates the input row", () => {
    const row = { org_id: "org-old", ack_policy: { assigneeIds: [OLD_A] } };
    const copy = JSON.parse(JSON.stringify(row));
    remapRow(row, remap);
    expect(row).toEqual(copy);
  });

  it("org_id value inside JSONB is not org-remapped (only the column is), but uids inside are", () => {
    const out = remapRow({ org_id: "org-old", details: { org_id: "org-old", by: OLD_A } }, remap);
    expect(out.org_id).toBe("org-new");
    expect((out.details as { org_id: string; by: string }).org_id).toBe("org-old");
    expect((out.details as { org_id: string; by: string }).by).toBe(NEW_A);
  });
});
