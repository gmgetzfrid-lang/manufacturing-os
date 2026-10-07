// @vitest-environment jsdom
//
// identity-and-session Round G — package IS-P1.
//
//   SESS-6  useRole().activeRole is `Role | null`: null until a membership
//           resolves (and after a failed lookup, for a non-member, after
//           sign-out). Every consumer reads null as the least-privileged
//           state — no actions, nothing readable by role — and an audit row
//           written while it is null OMITS the role (DEC-44 (IS-P1) §1),
//           never a placeholder "Viewer".
//   OFF-8   done-when 3 (public-surfaces): the client-storage inventory in
//           RoleContext — every localStorage / sessionStorage key and the
//           IndexedDB database classified; what the account READ is cleared
//           on SIGNED_OUT (the sign-in flow's own keys survive an expiry-
//           driven SIGNED_OUT); a session that evaporates drops the
//           rebuildable caches; a different identity on the tab ends the
//           last one's data.
//
// The provider is driven AS RENDERED against a mocked supabase client (its
// auth callback captured, the membership queries answered per scenario); the
// pages' role lenses are lifted from their source and run (a page module
// exports nothing else — the pattern prjRoundGJ12.test.ts uses).

import { describe, it, expect, vi, beforeEach, afterEach, expectTypeOf } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { Role } from "@/types/schema";
import type { Principal } from "@/lib/permissions";
import type { WorkflowEngine } from "@/lib/workflow";

const s = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string } },
  authCb: null as null | ((event: string, session: unknown) => Promise<void> | void),
  /** org_members row the candidate org answers (null = none). */
  member: null as null | Record<string, unknown>,
  /** Every org_members read fails (the lookup itself, not "no row"). */
  membersFail: false,
  activeMembers: [] as Array<Record<string, unknown>>,
  profileOrg: "o1" as string | null,
}));

vi.mock("@/lib/supabase", () => {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const answer = () => {
      if (table === "users") return { data: { default_org_id: s.profileOrg }, error: null };
      if (table === "org_members") {
        if (s.membersFail) return { data: null, error: { message: "connection reset" } };
        if (filters.status === "active") return { data: s.activeMembers, error: null };
        return { data: s.member, error: null };
      }
      return { data: null, error: null };
    };
    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.eq = (c: string, v: unknown) => { filters[c] = v; return api; };
    api.order = () => api;
    api.limit = () => api;
    api.maybeSingle = async () => answer();
    api.upsert = () => Promise.resolve({ error: null });
    api.insert = () => Promise.resolve({ error: null });
    api.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(answer()).then(res, rej);
    return api;
  };
  return {
    supabase: {
      from,
      auth: {
        getSession: async () => ({ data: { session: s.session } }),
        onAuthStateChange: (cb: (event: string, session: unknown) => Promise<void>) => {
          s.authCb = cb;
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
    },
  };
});
vi.mock("@/lib/audit", () => ({ logWorkspaceRelocation: vi.fn(async () => ({ error: null })) }));

import {
  RoleProvider, useRole,
  CLIENT_STORAGE_INVENTORY, CLIENT_INDEXED_DB_INVENTORY,
  purgeAccountStorage, purgeAccountClientStores, identityChangeEndsAccount,
} from "@/components/providers/RoleContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const ROLE_CONTEXT = "components/providers/RoleContext.tsx";

let host: HTMLDivElement;
let root: Root;
const replaceCalls: string[] = [];
beforeEach(() => {
  s.session = null; s.authCb = null; s.member = null; s.membersFail = false; s.activeMembers = []; s.profileOrg = "o1";
  window.localStorage.clear();
  window.sessionStorage.clear();
  replaceCalls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

function Probe() {
  const { activeRole, roles, membershipState, hasAnyRole } = useRole();
  return React.createElement("div", { id: "probe" },
    `${activeRole === null ? "NULL" : activeRole}|${roles.join(",")}|${membershipState}|${hasAnyRole(["Viewer", "Admin"]) ? "any" : "none"}`);
}
const probe = () => host.querySelector("#probe")?.textContent ?? "";
async function mount() {
  await act(async () => { root.render(React.createElement(RoleProvider, null, React.createElement(Probe))); });
  await tick();
}
const ADMIN = { org_id: "o1", uid: "u1", role: "Admin", roles: ["Admin"], status: "active", email: "a@x.io" };

// ── SESS-6: the type ──────────────────────────────────────────────────────
describe("SESS-6 — activeRole is Role | null at the type level, and Principal / getActions keep a real Role", () => {
  it("useRole().activeRole is Role | null; an unchecked Role-typed use does not compile", () => {
    type Ctx = ReturnType<typeof useRole>;
    expectTypeOf<Ctx["activeRole"]>().toEqualTypeOf<Role | null>();
    // @ts-expect-error — SESS-6: reading activeRole as a Role without a null branch fails tsc
    const unchecked: Role = (null as unknown as Ctx)?.activeRole;
    expect(unchecked).toBeUndefined();
  });
  it("Principal.role and WorkflowEngine.getActions(role) stay Role — the null branch is the consumer's", () => {
    expectTypeOf<Principal["role"]>().toEqualTypeOf<Role>();
    expectTypeOf<Parameters<typeof WorkflowEngine.getActions>[1]>().toEqualTypeOf<Role>();
  });
});

// ── SESS-6: the provider, rendered ────────────────────────────────────────
describe("SESS-6 — the provider publishes null whenever no role is known, never a placeholder Viewer", () => {
  it("signed out at boot: null, no roles, hasAnyRole false (was the literal \"Viewer\")", async () => {
    await mount();
    expect(probe()).toBe("NULL||resolving|none");
  });

  it("regression — an active Admin resolves to Admin exactly as before", async () => {
    s.session = { user: { id: "u1", email: "a@x.io" } };
    s.member = ADMIN;
    await mount();
    expect(probe()).toBe("Admin|Admin|member|any");
  });

  it("a signed-in account with no active membership: null and \"none\" (the hard-stop screen), never a Viewer", async () => {
    s.session = { user: { id: "u1", email: "a@x.io" } };
    s.member = { ...ADMIN, status: "suspended" };
    await mount();
    expect(probe()).toBe("NULL||none|none");
  });

  it("a lookup that fails after its retries: null and \"error\"", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    s.session = { user: { id: "u1", email: "a@x.io" } };
    s.membersFail = true;
    await act(async () => { root.render(React.createElement(RoleProvider, null, React.createElement(Probe))); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(probe()).toBe("NULL||error|none");
  });

  it("SIGNED_OUT: back to null (the redirect follows)", async () => {
    s.session = { user: { id: "u1", email: "a@x.io" } };
    s.member = ADMIN;
    await mount();
    expect(probe()).toMatch(/^Admin\|/);
    await act(async () => { await s.authCb!("SIGNED_OUT", null); });
    expect(probe()).toBe("NULL||resolving|none");
  });

  it("source: the seed and all five resets are null; no setActiveRole(\"Viewer\") remains", () => {
    const rc = src(ROLE_CONTEXT);
    expect(rc).toMatch(/const \[activeRole, setActiveRole\] = useState<Role \| null>\(null\);/);
    expect(rc).toMatch(/\n  activeRole: Role \| null;\n/);
    expect(rc).not.toMatch(/setActiveRole\("Viewer"\)/);
    expect(rc.match(/setActiveRole\(null\);/g)).toHaveLength(4);
    expect(rc).toMatch(/setActiveRole\(active \? headline : null\);/);
  });
});

// ── SESS-6: every consumer branches on null ───────────────────────────────
const CLIENT_ROOTS = ["app", "components", "hooks"];
const walk = (d: string): string[] => readdirSync(join(process.cwd(), d), { withFileTypes: true }).flatMap((e) => {
  const p = `${d}/${e.name}`;
  if (e.isDirectory()) return e.name === "__tests__" || e.name === "node_modules" ? [] : walk(p);
  return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
});

describe("SESS-6 — the consumers", () => {
  const files = CLIENT_ROOTS.flatMap(walk);
  it("no file calls a string method on the headline (the two crash sites are gone; HEADLINE_AUTHORITY shape)", () => {
    for (const f of files) {
      const t = src(f);
      expect(t, f).not.toMatch(/activeRole\??\.includes\(/);
      expect(t, f).not.toMatch(/activeRole\??\.startsWith\(/);
    }
  });

  it("no consumer turns a null role back into a fake \"Viewer\"", () => {
    for (const f of files) expect(src(f), f).not.toMatch(/activeRole\s*(\?\?|\|\|)\s*["']Viewer["']/);
  });

  const SESS6_FILES = [
    "app/(protected)/requests/page.tsx", "app/(protected)/requests/[id]/page.tsx", "app/(protected)/documents/page.tsx",
    "app/(protected)/documents/[libraryId]/page.tsx", "app/(protected)/projects/page.tsx", "app/(protected)/projects/[id]/page.tsx",
    "app/(protected)/admin/users/page.tsx", "components/viewers/SecureDocViewer.tsx",
  ];
  it("DEC-44 (IS-P1) §1: every audit role these files write from the headline omits it when null (activeRole ?? undefined)", () => {
    for (const f of SESS6_FILES) {
      const t = src(f);
      // a bare `userRole: activeRole,` / `actorRole: activeRole,` / `actorRole={activeRole}` would carry null
      expect(t, f).not.toMatch(/\b(?:userRole|actorRole):\s*activeRole\s*[,}\n]/);
      const bareProps = [...t.matchAll(/actorRole=\{activeRole\}/g)].length;
      // the one bare prop left is inside the `activeRole &&` guard of the bulk checkout modal (narrowed to Role)
      expect(bareProps, f).toBe(f.endsWith("[libraryId]/page.tsx") ? 1 : 0);
    }
    const page = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(page).toMatch(/\{showBulkCheckout && activeOrgId && uid && activeRole && \(/);
  });

  it("requests/[id]: no role known offers no action and no publish affordance; getActions is asked only with a real role", () => {
    const t = src("app/(protected)/requests/[id]/page.tsx");
    expect(t).toMatch(/const availableActions = activeRole === null \? \[\] : WorkflowEngine\.getActions\(ticket, activeRole, uid \?\? undefined, capPolicy, \{/);
    expect(t).toMatch(/if \(!docId \|\| !libId \|\| !uid \|\| activeRole === null\) \{ setCanPublishSource\(false\); return; \}/);
  });

  it("documents: no role known reads no library by role — not even an \"ALL\" one", () => {
    expect(src("app/(protected)/documents/page.tsx")).toMatch(/const _canRead = activeRole !== null && computeCanRead\(normalized, activeRole, roles\);/);
  });

  it("the library page: no role, no principal — nothing discoverable or readable, no publish, no permission management, no inspector, no collection controls", () => {
    const t = src("app/(protected)/documents/[libraryId]/page.tsx");
    expect(t).toMatch(/const principal = useMemo<Principal \| null>\(\(\) => \{\n    if \(activeRole === null\) return null;/);
    expect(t).toMatch(/const canPublish = useMemo\(\(\) => \{\n    if \(!principal\) return false;/);
    expect(t).toMatch(/const filteredFolders = useMemo\(\(\) => \{\n    if \(!principal\) return \[\];/);
    expect(t).toMatch(/const filteredDocs = useMemo\(\(\) => \{\n    if \(!principal\) return \[\];/);
    expect(t).toMatch(/const drawerDelegationAuthority = \(\(\) => \{\n    if \(!uid \|\| !principal\) return false;/);
    expect(t).toMatch(/\{selectedDoc && activeRole && \(\n\s*<InspectorPanel/);
    expect(t).toMatch(/\{activeRole && \(\n\s*<CollectionsStrip/);
  });

  it("the controller check reads the collection: no role known is never a controller; every real headline answers as before", async () => {
    const { isControllerPrincipal } = await import("@/lib/permissions");
    expect(isControllerPrincipal({ role: null, roles: [] })).toBe(false);
    expect(isControllerPrincipal({ role: "Admin", roles: [] })).toBe(true);
    expect(isControllerPrincipal({ role: "Manager", roles: ["Manager", "DocCtrl"] })).toBe(true);
    expect(isControllerPrincipal({ role: "Manager", roles: ["Manager"] })).toBe(false);
    expect(src("app/(protected)/transmittals/page.tsx")).toMatch(/isControllerPrincipal\(\{ role: activeRole, roles: \(roles \?\? \[\]\) as Role\[\] \}\)/);
  });
});

// ── SESS-6: the requests console's role lens, run as written ──────────────
describe("SESS-6 — the requests console's card lens (the :379 crash site), lifted from the page and run", () => {
  const page = src("app/(protected)/requests/page.tsx");
  const memo = (name: string, close: string, params: string[]) => {
    const head = `const ${name}: DashboardMetrics = useMemo(() => {`;
    const head2 = `const ${name} = useMemo(() => {`;
    let from = page.indexOf(head); let len = head.length;
    if (from < 0) { from = page.indexOf(head2); len = head2.length; }
    expect(from, name).toBeGreaterThan(0);
    const body = page.slice(from + len, page.indexOf(close, from));
    const js = ts.transpileModule(`function memo(${params.join(", ")}) {${body}\n}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    return new Function(`${js}\nreturn memo;`)();
  };
  const metrics = memo("metrics", "\n  }, [tickets, activeRole, isActionRequired, uid]);", ["tickets", "activeRole", "isActionRequired", "uid", "isTerminalTicketStatus", "isEngineerRole", "calculateDaysOpen"]);
  const labels = memo("cardLabels", "\n  }, [activeRole]);", ["activeRole"]);
  const isEngineerRole = (r?: string) => !!r && r.includes("Engineer");
  const T = (status: string, extra: Record<string, unknown> = {}) => ({ id: Math.random().toString(36), status, lastModified: new Date().toISOString(), ...extra });
  const tickets = [T("PENDING_ENG_TEAM"), T("PENDING_REVIEW"), T("PENDING_FINAL_APPROVAL"), T("PENDING_IFC"), T("FINAL_DRAFT"), T("CLOSED"), T("PENDING_ASSIGNMENT")];
  const run = (role: string | null) => metrics(tickets, role, () => false, "u1", (st: string) => st === "CLOSED", isEngineerRole, () => 0);

  it("a null role does not throw (it threw TypeError on activeRole.includes) and counts nothing — as the Viewer placeholder fell through", () => {
    expect(() => run(null)).not.toThrow();
    expect(run(null)).toMatchObject({ slot2Count: 0, slot3Count: 0, slot4Count: 0, totalVolume: 7 });
    expect(run("Viewer")).toMatchObject({ slot2Count: 0, slot3Count: 0, slot4Count: 0 });
    expect(labels(null)).toEqual({ slot2: "Team Queue", slot3: "Drawing Review", slot4: "Final Approvals" });
    expect(labels(null)).toEqual(labels("Viewer"));
  });

  it("regression — every real headline gets exactly the tiles it got before (the lens stays the headline's, display only)", () => {
    expect(run("Engineer-2")).toMatchObject({ slot2Count: 1, slot3Count: 1, slot4Count: 1 });
    expect(run("DocCtrl")).toMatchObject({ slot2Count: 1, slot3Count: 1, slot4Count: 1 });
    expect(run("Manager")).toMatchObject({ slot2Count: 1, slot3Count: 1, slot4Count: 0 });
    expect(labels("Admin")).toEqual({ slot2: "Engineering Review", slot3: "Unassigned Pool", slot4: "Revision Status" });
    expect(labels("DocCtrl")).toEqual({ slot2: "Ready to Issue", slot3: "Pending Closure", slot4: "Total Archives" });
    expect(labels("Drafter").slot2).toBe("My Workload");
  });
});

// ── SESS-6: an audit row with no role known omits it ──────────────────────
describe("DEC-44 (IS-P1) §1 — the role is omitted, never a placeholder", () => {
  it("SecureDocViewer writes the VIEW row with userRole activeRole ?? undefined, through logAuditAction", () => {
    const v = src("components/viewers/SecureDocViewer.tsx");
    expect(v).toMatch(/logAuditAction\(\{\n\s*action: 'VIEW',[\s\S]*?userRole: activeRole \?\? undefined,\n\s*details: \{ fileName: title \},/);
    expect(v).not.toMatch(/userRole: activeRole\n/);
  });
});

// ── OFF-8 done-when 3: the inventory ──────────────────────────────────────
describe("OFF-8 — every key the app keeps in this browser is in RoleContext's inventory", () => {
  const roots = ["app", "components", "hooks", "lib"];
  const all = roots.flatMap(walk);
  const touching = all.filter((f) => f !== ROLE_CONTEXT && /\b(localStorage|sessionStorage)\b/.test(src(f)));
  const idbTouching = all.filter((f) => f !== ROLE_CONTEXT && /\bindexedDB\b/.test(src(f)));
  const owners = new Set([...CLIENT_STORAGE_INVENTORY.flatMap((r) => r.owners), ...CLIENT_INDEXED_DB_INVENTORY.flatMap((d) => d.owners)]);

  it("a file that touches localStorage / sessionStorage has a row (the census of 2026-10-07: every one)", () => {
    expect(touching.filter((f) => !owners.has(f))).toEqual([]);
    expect(idbTouching).toEqual(CLIENT_INDEXED_DB_INVENTORY.flatMap((d) => d.owners));
  });

  it("every row names a key its owners really use, says why, and every account row says whether an evaporated session drops it", () => {
    for (const r of CLIENT_STORAGE_INVENTORY) {
      expect(r.why.length, r.key).toBeGreaterThan(5);
      if (r.class === "account") expect(["cache", "held"]).toContain(r.kind);
      if (r.key === "sb-") { expect(src("lib/supabase.ts")).toMatch(/storage: hybridAuthStorage/); continue; }
      const head = r.key.replace(/[:.-]$/, "");
      expect(r.owners.some((o) => src(o).includes(head)), `${r.key} in ${r.owners.join(", ")}`).toBe(true);
    }
    for (const d of CLIENT_INDEXED_DB_INVENTORY) {
      expect(src(d.owners[0])).toContain(`const DB_NAME = "${d.name}"`);
      for (const st of d.stores) expect(src(d.owners[0])).toContain(`const STORE = "${st}"`);
    }
  });

  it("the sign-in flow's keys are kept (an expiry-driven SIGNED_OUT needs them); what the account read is cleared", () => {
    const cls = (store: string, key: string) => CLIENT_STORAGE_INVENTORY.find((r) => r.store === store && r.key === key)?.class;
    expect(cls("local", "manufacturingos.preferMicrosoft")).toBe("sign-in");
    expect(cls("session", "manufacturingos.silentSSOAttempted")).toBe("sign-in");
    expect(cls("session", "manufacturingos.signInNext")).toBe("sign-in");
    expect(cls("local", "manufacturingos.rememberSession")).toBe("sign-in");
    for (const k of ["intel-status-", "schema-gaps-", "mfg-os.palette.recents", "orgGraph:pos", "dismissed:"]) expect(cls("local", k), k).toBe("account");
    for (const k of ["org-graph-", "mfg-os:lib:", "kl-active-thread-"]) expect(cls("session", k), k).toBe("account");
    expect(CLIENT_INDEXED_DB_INVENTORY.map((d) => d.class)).toEqual(["account"]);
  });
});

describe("OFF-8 — the purge", () => {
  const seed = () => {
    const L = window.localStorage, S = window.sessionStorage;
    L.setItem("intel-status-u1-o1", "{}"); L.setItem("schema-gaps-u1-o1", "{}");
    L.setItem("mfg-os.palette.recents", JSON.stringify([{ label: "P-101 Overhead P&ID", href: "/d/P-101" }]));
    L.setItem("orgGraph:pos:o1", "{}"); L.setItem("orgGraph:pos3d:o1", "{}");
    L.setItem("dismissed:u1:o1:hint", "1");
    L.setItem("manufacturingos.activeOrgId", "o1"); L.setItem("manufacturingos.activeOrgId.owner", "u1");
    L.setItem("manufacturingos.preferMicrosoft", "true"); L.setItem("manufacturingos.rememberSession", "true");
    L.setItem("sb-ref-auth-token", "tok");
    L.setItem("mfgos.theme.mode", "dark"); L.setItem("orgGraph:settings:o1", "{}"); L.setItem("manufacturingos.dashboard.u1", "{}");
    L.setItem("manufacturingos.customStamps", "[]");
    S.setItem("org-graph-o1", "{}"); S.setItem("mfg-os:lib:l1:o1", "{}"); S.setItem("kl-active-thread-l1", "[]");
    S.setItem("manufacturingos.silentSSOAttempted", "1"); S.setItem("manufacturingos.signInNext", "{}"); S.setItem("kl-embed-nudge-at", "1");
  };
  const keys = (st: Storage) => Array.from({ length: st.length }, (_, i) => st.key(i)!).sort();

  it("scope \"all\" (SIGNED_OUT): every account key goes from both stores; the workspace pointer is left to clearStoredOrgId; sign-in and device keys stay", () => {
    seed();
    purgeAccountStorage(window.localStorage, "local", "all");
    purgeAccountStorage(window.sessionStorage, "session", "all");
    expect(keys(window.localStorage)).toEqual([
      "manufacturingos.activeOrgId", "manufacturingos.activeOrgId.owner", "manufacturingos.customStamps", "manufacturingos.dashboard.u1",
      "manufacturingos.preferMicrosoft", "manufacturingos.rememberSession", "mfgos.theme.mode", "orgGraph:settings:o1", "sb-ref-auth-token",
    ]);
    expect(keys(window.sessionStorage)).toEqual(["kl-embed-nudge-at", "manufacturingos.signInNext", "manufacturingos.silentSSOAttempted"]);
  });

  it("scope \"cache\" (a session evaporated): only the rebuildable caches — the ask thread and the dismissals are held", () => {
    seed();
    purgeAccountStorage(window.localStorage, "local", "cache");
    purgeAccountStorage(window.sessionStorage, "session", "cache");
    expect(window.localStorage.getItem("mfg-os.palette.recents")).toBeNull();
    expect(window.localStorage.getItem("intel-status-u1-o1")).toBeNull();
    expect(window.localStorage.getItem("orgGraph:pos3d:o1")).toBeNull();
    expect(window.sessionStorage.getItem("org-graph-o1")).toBeNull();
    expect(window.sessionStorage.getItem("mfg-os:lib:l1:o1")).toBeNull();
    expect(window.sessionStorage.getItem("kl-active-thread-l1")).toBe("[]");
    expect(window.localStorage.getItem("dismissed:u1:o1:hint")).toBe("1");
    expect(window.localStorage.getItem("manufacturingos.activeOrgId")).toBe("o1");
  });

  it("never throws: a missing or forbidden store is nothing to purge", () => {
    expect(purgeAccountStorage(null, "local", "all")).toEqual([]);
    const forbidden = { get length(): number { throw new Error("SecurityError"); } } as unknown as Storage;
    expect(purgeAccountStorage(forbidden, "local", "all")).toEqual([]);
  });

  it("scope \"all\" deletes the draft-handoff IndexedDB database, bounded — a blocked delete never holds the sign-out", async () => {
    const asked: string[] = [];
    const idb = { deleteDatabase: (name: string) => { asked.push(name); const req: Record<string, () => void> = {}; queueMicrotask(() => req.onblocked?.()); return req; } } as unknown as IDBFactory;
    await purgeAccountClientStores("all", { idb, budgetMs: 50 });
    expect(asked).toEqual(["manufacturingos"]);
    const hung = { deleteDatabase: () => ({}) } as unknown as IDBFactory;
    const t0 = Date.now();
    await purgeAccountClientStores("all", { idb: hung, budgetMs: 30 });
    expect(Date.now() - t0).toBeLessThan(1000);
    asked.length = 0;
    await purgeAccountClientStores("cache", { idb, budgetMs: 50 });
    expect(asked).toEqual([]); // an evaporated session keeps the unsubmitted hand-off
  });

  it("identityChangeEndsAccount: only a DIFFERENT identity after a known one", () => {
    expect(identityChangeEndsAccount(null, "u1")).toBe(false);
    expect(identityChangeEndsAccount("u1", "u1")).toBe(false);
    expect(identityChangeEndsAccount("u1", "u2")).toBe(true);
  });
});

describe("OFF-8 — the provider's branches, rendered", () => {
  const seedAccount = () => {
    window.localStorage.setItem("mfg-os.palette.recents", "[]");
    window.localStorage.setItem("dismissed:u1:o1:x", "1");
    window.sessionStorage.setItem("kl-active-thread-l1", "[]");
    window.sessionStorage.setItem("org-graph-o1", "{}");
    window.localStorage.setItem("manufacturingos.preferMicrosoft", "true");
    window.sessionStorage.setItem("manufacturingos.silentSSOAttempted", "1");
  };

  it("SIGNED_OUT clears every account key and the device workspace, and keeps the silent-SSO flags", async () => {
    s.session = { user: { id: "u1", email: "a@x.io" } };
    s.member = ADMIN;
    await mount();
    seedAccount();
    await act(async () => { await s.authCb!("SIGNED_OUT", null); });
    expect(window.localStorage.getItem("mfg-os.palette.recents")).toBeNull();
    expect(window.localStorage.getItem("dismissed:u1:o1:x")).toBeNull();
    expect(window.sessionStorage.getItem("kl-active-thread-l1")).toBeNull();
    expect(window.sessionStorage.getItem("org-graph-o1")).toBeNull();
    expect(window.localStorage.getItem("manufacturingos.activeOrgId")).toBeNull();
    expect(window.localStorage.getItem("manufacturingos.preferMicrosoft")).toBe("true");
    expect(window.sessionStorage.getItem("manufacturingos.silentSSOAttempted")).toBe("1");
  });

  it("a session that evaporates (no SIGNED_OUT) drops the caches, keeps held work and the owner-checked workspace", async () => {
    s.session = { user: { id: "u1", email: "a@x.io" } };
    s.member = ADMIN;
    await mount();
    seedAccount();
    expect(window.localStorage.getItem("manufacturingos.activeOrgId")).toBe("o1");
    await act(async () => { await s.authCb!("INITIAL_SESSION", null); });
    expect(probe()).toMatch(/^NULL\|\|/);
    expect(window.localStorage.getItem("mfg-os.palette.recents")).toBeNull();
    expect(window.sessionStorage.getItem("org-graph-o1")).toBeNull();
    expect(window.sessionStorage.getItem("kl-active-thread-l1")).toBe("[]");
    expect(window.localStorage.getItem("dismissed:u1:o1:x")).toBe("1");
    expect(window.localStorage.getItem("manufacturingos.activeOrgId")).toBe("o1");
  });

  it("a DIFFERENT identity signing in on the tab ends the last one's held data too; the same identity keeps it", async () => {
    s.session = { user: { id: "u1", email: "a@x.io" } };
    s.member = ADMIN;
    await mount();
    seedAccount();
    await act(async () => { await s.authCb!("SIGNED_IN", { user: { id: "u1", email: "a@x.io" } }); });
    expect(window.sessionStorage.getItem("kl-active-thread-l1")).toBe("[]");
    expect(window.localStorage.getItem("mfg-os.palette.recents")).toBe("[]");
    s.member = { ...ADMIN, uid: "u2" };
    await act(async () => { await s.authCb!("SIGNED_IN", { user: { id: "u2", email: "b@x.io" } }); });
    await tick();
    expect(window.sessionStorage.getItem("kl-active-thread-l1")).toBeNull();
    expect(window.localStorage.getItem("mfg-os.palette.recents")).toBeNull();
    expect(window.localStorage.getItem("manufacturingos.preferMicrosoft")).toBe("true");
  });

  it("source: SIGNED_OUT purges every account store before the Cache Storage purge and the redirect; the evaporated branch purges caches only and never the workspace", () => {
    const rc = src(ROLE_CONTEXT);
    const start = rc.indexOf('if (event === "SIGNED_OUT") {');
    const block = rc.slice(start, rc.indexOf('window.location.replace("/");', start));
    expect(block.indexOf("clearStoredOrgId();")).toBeGreaterThan(0);
    expect(block.indexOf('await purgeAccountClientStores("all");')).toBeGreaterThan(block.indexOf("clearStoredOrgId();"));
    expect(block.indexOf("caches.keys()")).toBeGreaterThan(block.indexOf('await purgeAccountClientStores("all");'));
    const evap = rc.slice(rc.indexOf("// Session evaporated without a SIGNED_OUT"), rc.indexOf("// When tab becomes visible again"));
    expect(evap).toMatch(/await purgeAccountClientStores\("cache"\);/);
    expect(evap).not.toMatch(/clearStoredOrgId|purgeAccountClientStores\("all"\)|location\.replace/);
  });
});
