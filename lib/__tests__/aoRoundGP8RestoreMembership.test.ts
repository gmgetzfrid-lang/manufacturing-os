// notifications NEDGE-16 (admin-and-org Round G, P8) — a restore ENDS with an
// explicit membership check. Restored people are created "inactive" by
// /api/admin/restore/begin; since NEDGE-3 / 20261161 an inactive member hears
// nothing and reads an empty bell. The completion step
// (/api/admin/restore/complete) says how many members are not active, shows
// it on the restore page and writes RESTORE_MEMBERSHIP_CHECK; a workspace
// left with no active Admin is reported (409), never shown as fine — a
// defensive report, since the restoring Admin is an active Admin by
// construction. The check runs whenever the run started, whether it
// returned or threw.
//
// Driven to completion through the page's own driver (runChunkedRestore) and
// the completion helper, against the in-memory PostgREST the restore routes
// already run on in restoreApplyRoute.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, type Row } from "./helpers/restoreMemoryDb";

vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  return {
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
      userId: "admin-1", email: "admin@x.io", orgId, role: "Admin", roles: ["Admin"], admin: { from: mem.from },
    })),
  };
});

import { POST as applyTable } from "@/app/api/admin/restore/apply-table/route";
import { POST as beginRoute } from "@/app/api/admin/restore/begin/route";
import { POST as completeRoute } from "@/app/api/admin/restore/complete/route";
import { planRestore, runChunkedRestore, type RestorePost, type RestoreEnvelopeLike } from "@/lib/dataRestore";
import { completeRestoreMembership, restoreMembershipSentence, withRestoreMembershipCheck, type RestoreMembershipCheck } from "@/lib/restoreMembership";

const ORG = "org-1";
const routePost: RestorePost = async (path, body) => {
  const req = new NextRequest(`https://app${path}`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const handler = path.startsWith("/api/admin/restore/begin") ? beginRoute
    : path.startsWith("/api/admin/restore/complete") ? completeRoute : applyTable;
  const res = await handler(req);
  return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
const rowsOf = (t: string): Row[] => db.rows[t] ?? [];

beforeEach(() => {
  // A fresh workspace: only the restoring Admin is a member.
  db.rows = {
    orgs: [{ id: ORG, name: "Acme" }],
    org_members: [{ id: "m-admin", org_id: ORG, uid: "admin-1", email: "admin@x.io", role: "Admin", roles: ["Admin"], status: "active" }],
  };
  db.keys = {}; db.writeError = null; db.readError = {}; db.writes = []; db.attempts = [];
  db.countless = false; db.fks = {}; db.maxRows = 1000; db.generated = {}; db.authUsers = null;
});

const envelope = (): RestoreEnvelopeLike => ({
  manifest: { orgId: "backup-org", orgName: "Acme" },
  tables: {
    org_members: [
      { org_id: "backup-org", uid: "old-admin", email: "admin@x.io", role: "Admin", status: "active" },
      { org_id: "backup-org", uid: "old-1", email: "pat@x.io", role: "Engineer-1", status: "active" },
      { org_id: "backup-org", uid: "old-2", email: "sam@x.io", role: "DocCtrl", status: "active" },
    ],
    notes: [{ id: "n1", org_id: "backup-org", body: "kept" }],
  },
});

describe("NEDGE-16 — the restore ends with an explicit membership assertion", () => {
  it("driven to completion: N inactive members are named on the page's sentence and in the audit row; the restoring Admin stays active", async () => {
    const env = envelope();
    const plan = planRestore(env, { orgId: ORG, orgName: "Acme", members: [{ uid: "admin-1", email: "admin@x.io", status: "active" }] });
    const run = await runChunkedRestore({ orgId: ORG, envelope: env, plan, orgNameChoice: "current", post: routePost });
    expect(run.stoppedAt).toBeNull();
    expect(run.createdUsers).toBe(2);

    const check = await completeRestoreMembership(ORG, routePost);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.summary).toEqual({ activeMembers: 1, inactiveMembers: 2, activeAdmins: 1, actorActive: true });
    expect(check.auditError).toBeNull();
    const sentence = restoreMembershipSentence(check.summary);
    expect(sentence).toMatch(/^2 member\(s\) of this workspace are not active/);
    expect(sentence).toMatch(/will receive no notifications, and cannot read their notification bell, until an Admin reactivates them/);

    const rows = rowsOf("audit_logs").filter((r) => r.action === "RESTORE_MEMBERSHIP_CHECK");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: ORG, user_id: "admin-1", resource_type: "org", resource_id: ORG });
    expect(rows[0].details).toMatchObject({ activeMembers: 1, inactiveMembers: 2, activeAdmins: 1, receiveNoNotifications: 2 });
    // nothing in the restore changed an existing member's status
    expect(rowsOf("org_members").find((m) => m.uid === "admin-1")?.status).toBe("active");
  });

  it("defensive: a workspace with no active Admin is reported (409), never shown as fine (reachable only with the gate mocked — the gate admits only an active Admin)", async () => {
    db.rows.org_members = [{ id: "m-admin", org_id: ORG, uid: "admin-1", email: "admin@x.io", role: "Viewer", roles: ["Viewer"], status: "active" }];
    const check = await completeRestoreMembership(ORG, routePost);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error).toMatch(/no active Admin/);
    expect(check.error).not.toMatch(/audit log/);
  });

  it("the 409 carries a refused audit row too (auditError), never dropped", async () => {
    db.rows.org_members = [{ id: "m-admin", org_id: ORG, uid: "admin-1", email: "admin@x.io", role: "Viewer", roles: ["Viewer"], status: "active" }];
    db.writeError = (table) => table === "audit_logs" ? { code: "42501", message: "audit insert refused" } : null;
    const res = await routePost(`/api/admin/restore/complete?orgId=${ORG}`, {});
    expect(res.status).toBe(409);
    expect(res.body?.auditError).toBe("audit insert refused");
    const check = await completeRestoreMembership(ORG, routePost);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error).toMatch(/no active Admin.*could not be written to the audit log: audit insert refused/);
  });

  it("a run that throws after /begin created inactive placeholders still ends with the membership check, then rethrows", async () => {
    const env = envelope();
    const plan = planRestore(env, { orgId: ORG, orgName: "Acme", members: [{ uid: "admin-1", email: "admin@x.io", status: "active" }] });
    // /begin runs for real (2 inactive placeholders are created), then its
    // answer is lost on the way back: runChunkedRestore throws.
    const lossyPost: RestorePost = async (path, body) => {
      if (path.startsWith("/api/admin/restore/begin")) {
        await routePost(path, body);
        throw new Error("connection reset");
      }
      return routePost(path, body);
    };
    const seen: RestoreMembershipCheck[] = [];
    await expect(withRestoreMembershipCheck(ORG, lossyPost,
      () => runChunkedRestore({ orgId: ORG, envelope: env, plan, orgNameChoice: "current", post: lossyPost }),
      (c) => seen.push(c))).rejects.toThrow(/connection reset/);
    expect(rowsOf("org_members").filter((m) => m.status === "inactive")).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ok: true, summary: { activeMembers: 1, inactiveMembers: 2, activeAdmins: 1, actorActive: true } });
    expect(rowsOf("audit_logs").filter((r) => r.action === "RESTORE_MEMBERSHIP_CHECK")).toHaveLength(1);
  });

  it("a member list that cannot be read is said, never shown as zero inactive", async () => {
    db.readError = { org_members: "upstream timeout" };
    const check = await completeRestoreMembership(ORG, routePost);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error).toMatch(/Couldn't read this workspace's members after the restore \(upstream timeout\)/);
  });

  it("all active: the sentence says so", () => {
    expect(restoreMembershipSentence({ activeMembers: 3, inactiveMembers: 0, activeAdmins: 1, actorActive: true })).toBe("All 3 member(s) of this workspace are active.");
  });

  it("the restore page wraps the run in the completion step and renders its sentence outside the result branch (source pin)", () => {
    const page = readFileSync(join(process.cwd(), "app/(protected)/admin/restore/page.tsx"), "utf8");
    expect(page).toMatch(/await withRestoreMembershipCheck\(activeOrgId, post,\s*async \(\) => await runChunkedRestore\(/);
    expect(page.match(/runChunkedRestore\(/g)).toHaveLength(1);
    expect(page).toMatch(/restoreMembershipSentence\(membershipCheck\.summary\)/);
    expect(page).toMatch(/data-testid="restore-membership-check"/);
    // the panel is not nested in the applyResult branch: a thrown run shows it too
    expect(page.indexOf("<RestoreResultPanel result={applyResult} />\n          ) : !applying")).toBeGreaterThan(0);
  });
});
