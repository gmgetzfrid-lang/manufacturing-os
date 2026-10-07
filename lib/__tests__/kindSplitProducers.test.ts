// notifications Round G, N9 — the producers behind the kind split, the visit
// trail, and the library page's one notice path.
//
//   PROD-13 / TAX-13: one name per meaning. doc_superseded carried eight
//     meanings and checkout_released three; review_requested also carried the
//     contractor-intake notices (DEC-81 §3, DEC-90 A13). Each producer now
//     writes its own kind, and the overloaded names keep ONE meaning — pinned
//     here by a census of who writes them.
//   TRAIL-4: visiting the thing a notification is about marks it read
//     (lib/notificationTrail.ts) — a document opened through ?doc=, a project.
//   PROD-5 dw2: the library page's staged upload tells the library's followers
//     through the same helper the CSV import uses (lib/libraryNotify.ts).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
function files(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "__tests__" && !n.startsWith(".")) walk(p); }
      else if (/\.tsx?$/.test(n) && !n.endsWith(".d.ts")) out.push(relative(ROOT, p));
    }
  };
  for (const d of ["app", "lib", "components", "hooks"]) walk(join(ROOT, d));
  return out;
}
/** Files whose CODE (comments stripped) writes `kind: "<k>"`, or names it as a typed kind literal. */
const writersOf = (k: string) => files().filter((f) => {
  if (f === "lib/inAppNotifications.ts" || f === "lib/notificationKinds.ts") return false;
  return new RegExp(`kind: "${k}"|"${k}" as const|\\| "${k}"|"${k}" \\|`).test(code(f));
});

describe("PROD-13 / TAX-13 — each producer writes its own kind", () => {
  it.each([
    ["lib/staleCopies.ts", "doc_recalled", 2],
    ["lib/revisionImpact.ts", "doc_upstream_changed", 1],
    ["lib/workPackages.ts", "package_doc_stale", 1],
    ["lib/postPublish.ts", "package_doc_retired", 1],
    ["lib/checkoutEpisodes.ts", "checkout_force_released", 1],
    ["lib/projects.ts", "checkout_auto_released", 1],
    ["lib/distributionAcks.ts", "ack_requested", 3],
    ["app/api/intake/upload/route.ts", "intake_quote", 1],
    ["app/api/intake/upload/route.ts", "intake_submission", 1],
    ["lib/transmittals.ts", "transmittal_issued", 1],
  ])("%s writes %s", (file, kind, n) => {
    const c = code(file);
    const hits = (c.match(new RegExp(`kind: "${kind}"`, "g")) ?? []).length + (c.match(new RegExp(`kind: "${kind}" as const`, "g")) ?? []).length;
    expect(hits, `${file} → ${kind}`).toBeGreaterThanOrEqual(n as number);
  });

  it("doc_superseded keeps one meaning — a revision was published — written only by the post-publish signal and the intake door's publish (and its folded digest)", () => {
    expect(writersOf("doc_superseded").sort()).toEqual([
      "app/api/intake/upload/route.ts", "lib/intakeRateLimit.ts", "lib/postPublish.ts",
    ]);
    // the intake door's publish notice is the one doc_superseded there
    expect((code("app/api/intake/upload/route.ts").match(/kind: "doc_superseded"/g) ?? []).length).toBe(1);
    expect((code("lib/postPublish.ts").match(/kind: "doc_superseded"/g) ?? []).length).toBe(1);
  });

  it("checkout_released keeps one meaning — the stale-checkout escalation to the controllers (the maintenance cron)", () => {
    expect(writersOf("checkout_released")).toEqual(["app/api/cron/maintenance/route.ts"]);
  });

  it("review_requested keeps one meaning — a document's sign-off request", () => {
    expect(writersOf("review_requested").sort()).toEqual(["components/documents/CheckInPanel.tsx", "lib/reviewControl.ts"]);
  });

  it("the force-release notice names who did it, and the thread says it plainly (TAX-3 dw2: no 'SYSTEM ALERT')", () => {
    const c = src("lib/checkoutEpisodes.ts");
    expect(c).toContain("`Checkout force-released by ${input.actorName}. All sessions ended.`");
    expect(c).toContain("title: `Checkout force-released by ${input.actorName}`");
    expect(code("lib/checkoutEpisodes.ts")).not.toMatch(/SYSTEM ALERT/);
  });

  it("the distribution-ack read-back reads the kinds the requests are written as now", () => {
    const c = code("lib/distributionAcks.ts");
    expect(c).toContain('.in("kind", ["ack_requested", "ack_overdue"])');
    expect(c).not.toMatch(/kind: "doc_superseded"/);
  });
});

const sb = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; payload: unknown; filters: Array<[string, string, unknown]>; selected?: string }>,
  result: { data: [{ id: "n1" }, { id: "n2" }] as unknown[] | null, error: null as null | { message: string } },
}));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const call = { table, payload: null as unknown, filters: [] as Array<[string, string, unknown]>, selected: undefined as string | undefined };
      sb.calls.push(call);
      const b: Record<string, unknown> = {};
      b.update = (p: unknown) => { call.payload = p; return b; };
      b.eq = (c: string, v: unknown) => { call.filters.push(["eq", c, v]); return b; };
      b.is = (c: string, v: unknown) => { call.filters.push(["is", c, v]); return b; };
      b.select = (cols: string) => { call.selected = cols; return Promise.resolve(sb.result); };
      return b;
    },
  },
}));

import { markResourceNotificationsRead } from "@/lib/notificationTrail";

describe("TRAIL-4 — visiting the resource marks its notifications read", () => {
  beforeEach(() => { sb.calls = []; sb.result = { data: [{ id: "n1" }, { id: "n2" }], error: null }; });

  it("marks only the member's OWN unread rows about that one resource — read_at and nothing else — and answers how many", async () => {
    expect(await markResourceNotificationsRead({ uid: "u1", resourceType: "document", resourceId: "d1" })).toBe(2);
    expect(sb.calls).toHaveLength(1);
    const c = sb.calls[0];
    expect(c.table).toBe("notifications");
    expect(Object.keys(c.payload as object)).toEqual(["read_at"]);
    expect(c.filters).toEqual([["eq", "user_id", "u1"], ["eq", "resource_type", "document"], ["eq", "resource_id", "d1"], ["is", "read_at", null]]);
    expect(c.selected).toBe("id");
  });

  it("no member or no resource: nothing is asked; a refusal answers 0 (logged), never a throw", async () => {
    expect(await markResourceNotificationsRead({ uid: null, resourceType: "project", resourceId: "p1" })).toBe(0);
    expect(await markResourceNotificationsRead({ uid: "u1", resourceType: "project", resourceId: "" })).toBe(0);
    expect(sb.calls).toHaveLength(0);
    sb.result = { data: null, error: { message: "permission denied" } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await markResourceNotificationsRead({ uid: "u1", resourceType: "project", resourceId: "p1" })).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("the library page marks a document's rows when its ?doc= link opens it; the project page marks the project's once it has loaded (source pins)", () => {
    const lib = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(lib).toContain('import { markResourceNotificationsRead } from "@/lib/notificationTrail";');
    expect(lib).toMatch(/if \(uid && trailMarkedDoc\.current !== docId\) \{\s*trailMarkedDoc\.current = docId;\s*void markResourceNotificationsRead\(\{ uid, resourceType: "document", resourceId: docId \}\);/);
    const proj = src("app/(protected)/projects/[id]/page.tsx");
    expect(proj).toMatch(/if \(!uid \|\| !project\?\.id \|\| project\.id !== projectId \|\| trailMarkedProject\.current === projectId\) return;/);
    expect(proj).toContain('void markResourceNotificationsRead({ uid, resourceType: "project", resourceId: projectId });');
  });
});

describe("PROD-5 dw2 — the library page's staged upload tells followers through the one helper", () => {
  it("calls lib/libraryNotify.ts notifyLibraryDocsAdded, never emit() directly; the CSV import gets the uploader's name too", () => {
    const lib = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(lib).toContain('import { notifyLibraryDocsAdded } from "@/lib/libraryNotify";');
    const fn = lib.slice(lib.indexOf("const notifyLibrarySubscribers = "), lib.indexOf("if (!activeOrgId || !uid || !library) return;", lib.indexOf("const notifyLibrarySubscribers = ")));
    expect(fn).toMatch(/void notifyLibraryDocsAdded\(\{\s*orgId: activeOrgId, libraryId, count, firstLabel: firstName,\s*actorUserId: uid, actorName: userEmail \?\? null,\s*\}\);/);
    expect(fn).not.toMatch(/emit\(|library_doc_added/);
    expect(lib).toMatch(/<CsvImportModal[\s\S]*?actorName=\{userEmail \?\? undefined\}/);
    // the helper is in-app only (PROD-7 dw3: a bulk upload is chatty — the bell carries it, the inbox does not)
    expect(src("lib/libraryNotify.ts")).toMatch(/kind: "library_doc_added",[\s\S]*?channels: \["inapp"\],/);
  });
});
