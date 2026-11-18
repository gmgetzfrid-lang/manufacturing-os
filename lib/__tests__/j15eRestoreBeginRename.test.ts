// projects-joint J15e (projects-tab SAF-22) — /api/admin/restore/begin's
// workspace-name choice is the person's decision (class a): a rename that
// matched no row is refused before anything is written, never applied as if
// it landed. Against the in-memory PostgREST the restore routes already run
// on (helpers/restoreMemoryDb), with the orgs UPDATE answered as zero rows
// when `refuseRename` is set.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { db } from "./helpers/restoreMemoryDb";

const h = vi.hoisted(() => ({ refuseRename: false }));

vi.mock("@/lib/serverAuth", async () => {
  const mem = await import("./helpers/restoreMemoryDb");
  const from = (t: string) => {
    const b = mem.from(t) as Record<string, (...a: unknown[]) => unknown>;
    if (t !== "orgs") return b;
    return new Proxy(b, {
      get(target, prop: string) {
        if (prop === "update" && h.refuseRename) {
          // row-level security, or the row gone: no error, no row
          const z: Record<string, unknown> = {};
          z.eq = () => z; z.select = () => z;
          z.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
          return () => z;
        }
        return target[prop];
      },
    });
  };
  return {
    authorizeOrgRole: vi.fn(async (_req: unknown, orgId: string) => ({
      userId: "admin-1", email: "admin@x.io", orgId, role: "Admin", roles: ["Admin"], admin: { from },
    })),
  };
});

import { POST as beginRoute } from "@/app/api/admin/restore/begin/route";

const ORG = "org-1";
const begin = (orgNameChoice: "backup" | "current") => beginRoute(new NextRequest(`https://app/api/admin/restore/begin?orgId=${ORG}`, {
  method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
  body: JSON.stringify({
    manifest: { orgId: "backup-org", orgName: "Acme Backup" }, orgNameChoice,
    orgMembers: [{ org_id: "backup-org", uid: "old-1", email: "pat@x.io", role: "Engineer-1", status: "active" }],
  }),
}));

beforeEach(() => {
  db.rows = {
    orgs: [{ id: ORG, name: "Acme" }],
    org_members: [{ id: "m-admin", org_id: ORG, uid: "admin-1", email: "admin@x.io", role: "Admin", roles: ["Admin"], status: "active" }],
  };
  db.keys = {}; db.writeError = null; db.readError = {}; db.writes = []; db.attempts = [];
  db.countless = false; db.fks = {}; db.maxRows = 1000; db.generated = {}; db.authUsers = null;
  h.refuseRename = false;
});

describe("restore/begin — the backup's workspace name (SAF-22, class a)", () => {
  it("regression: choosing the backup's name renames the workspace and the run begins", async () => {
    const res = await begin("backup");
    expect(res.status).toBe(200);
    expect(db.rows.orgs[0].name).toBe("Acme Backup");
    expect(db.rows.org_members.some((m) => m.email === "pat@x.io")).toBe(true);
  });
  it("a rename that matched no row: 409, nothing written (no placeholder member), the name unchanged", async () => {
    h.refuseRename = true;
    const res = await begin("backup");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Could not apply the backup's workspace name (the workspace row was not found, or you can't change it) — nothing was written.");
    expect(db.rows.orgs[0].name).toBe("Acme");
    expect(db.rows.org_members.some((m) => m.email === "pat@x.io")).toBe(false);
  });
  it("a database error answers 500 with its own words, as before", async () => {
    db.writeError = (table, op) => (table === "orgs" && op === "update" ? { code: "42501", message: "permission denied for table orgs" } : null);
    const res = await begin("backup");
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Could not apply the backup's workspace name (permission denied for table orgs) — nothing was written.");
  });
  it("keeping the current name writes no rename at all (unchanged)", async () => {
    h.refuseRename = true;
    expect((await begin("current")).status).toBe(200);
    expect(db.rows.orgs[0].name).toBe("Acme");
  });
});
