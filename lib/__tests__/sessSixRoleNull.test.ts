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
//           driven SIGNED_OUT); an INITIAL_SESSION with no session clears
//           nothing unless this tab had an identity and supabase-js keeps no
//           session (then only the rebuildable caches, never Cache Storage);
//           a different identity booting in this browser — after a reload,
//           in a new tab — ends the last one's data. The census is per KEY:
//           every literal, constant or template head a file hands to
//           getItem / setItem / removeItem matches a row that file owns.
//
// The provider is driven AS RENDERED against a mocked supabase client (its
// auth callback captured, the membership queries answered per scenario); the
// pages' role lenses are lifted from their source and run (a page module
// exports nothing else — the pattern prjRoundGJ12.test.ts uses).

import { describe, it, expect, vi, beforeEach, afterEach, expectTypeOf } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, posix } from "node:path";
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
  LAST_IDENTITY_KEY, supabaseSessionPersisted, type ClientStorageRule,
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

  it("census: the role fallbacks that still turn a missing role into \"unknown\" are the recorded residual sites (document-control's checkout surfaces, SESS-6 Scope) — no new one", () => {
    // Reachable from a null headline only through the library page (its
    // `currentUser.role` / `userRole` props) and StaleCheckoutBanner, and
    // unreachable today — with no role there is no principal, no listed
    // document and no inspector. Fixing one shrinks the list; adding one fails.
    const KNOWN: Record<string, number> = {
      "components/projects/StaleCheckoutBanner.tsx": 1,
      "components/documents/CheckoutFlowModal.tsx": 3,
      "components/documents/CheckInPanel.tsx": 1,
      "components/documents/CheckoutStatusCell.tsx": 2,
      "lib/checkoutEpisodes.ts": 1,
    };
    const found: Record<string, number> = {};
    for (const f of ["app", "components", "hooks", "lib"].flatMap(walk)) {
      const n = [...src(f).matchAll(/[Rr]ole[^,\n]*(?:\|\||\?\?)\s*["']unknown["']/g)].length;
      if (n) found[f] = n;
    }
    for (const [f, n] of Object.entries(found)) expect(n, f).toBeLessThanOrEqual(KNOWN[f] ?? 0);
  });
});

// ── OFF-8 done-when 3: the per-key census ─────────────────────────────────
// Every getItem / setItem / removeItem call is read from the file's syntax
// tree. Its key argument is resolved to a fixed text — a literal, a constant
// (followed through `const` declarations, local key-builder functions and
// named imports), a template's or a `+` concatenation's fixed head, or the
// common head of a conditional's two branches — and must match an inventory
// row of the same store that the file owns. A key the census cannot read (a
// helper's parameter, a loop variable) must be listed below with the rows it
// carries; a listed site that no longer exists fails too. Inline scripts
// (strings handed to the page) are read by pattern.
type KeyShape = { text: string; prefix: boolean };
type FoundKey = KeyShape & { store: "local" | "session" | null };
const INDIRECT_KEYS: Record<string, { calls: string[]; carries: string[]; why: string }> = {
  "hooks/useDismissed.ts": {
    calls: ["localStorage.getItem(k)", "localStorage.removeItem(k)", "localStorage.setItem(k)"],
    carries: ["dismissed:"],
    why: "read / write take a key built by storageKey() (`dismissed:<uid>:<org>:<key>`); clearDismissals removes the keys it found under the prefix",
  },
  "lib/supabase.ts": {
    calls: ["localStorage.getItem(key)", "sessionStorage.getItem(key)", "localStorage.setItem(key)", "sessionStorage.removeItem(key)", "sessionStorage.setItem(key)", "localStorage.removeItem(key)"],
    carries: ["sb-"],
    why: "hybridAuthStorage stores whatever key supabase-js hands it — its own sb-… session and PKCE keys",
  },
  "app/(protected)/intelligence/page.tsx": {
    calls: ["localStorage.removeItem(k)", "sessionStorage.removeItem(k)"],
    carries: ["intel-status-", "schema-gaps-"],
    why: "legacyHubKeys(org): the org-only snapshot keys of before (HUB-10), removed on sight",
  },
  [ROLE_CONTEXT]: {
    calls: ["storage.removeItem(k)"],
    carries: CLIENT_STORAGE_INVENTORY.filter((r) => r.class === "account").map((r) => r.key),
    why: "the purge removes the keys it found matching the inventory's account rows",
  },
};

const parsedSources = new Map<string, ts.SourceFile>();
function parseSource(file: string, text: string): ts.SourceFile {
  const key = `${file}\u0000${text.length}\u0000${text.slice(-200)}`;
  let sf = parsedSources.get(key);
  if (!sf) {
    sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    parsedSources.set(key, sf);
  }
  return sf;
}
function moduleFile(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? posix.join(posix.dirname(from), spec) : null;
  if (!base) return null;
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) if (existsSync(join(process.cwd(), base + ext))) return base + ext;
  return null;
}
const bindingNames = (n: ts.BindingName): string[] =>
  ts.isIdentifier(n) ? [n.text] : n.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
type Decl = { kind: "value"; expr: ts.Expression; file: string } | { kind: "fn"; node: ts.SignatureDeclaration & { body?: ts.Node }; file: string } | { kind: "opaque" } | null;
function lookupName(name: string, at: ts.Node, file: string): Decl {
  for (let cur: ts.Node | undefined = at.parent; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur) && cur.parameters.some((p) => bindingNames(p.name).includes(name))) return { kind: "opaque" };
    if ((ts.isForOfStatement(cur) || ts.isForInStatement(cur) || ts.isForStatement(cur)) && cur.initializer && ts.isVariableDeclarationList(cur.initializer)
      && cur.initializer.declarations.some((d) => bindingNames(d.name).includes(name))) return { kind: "opaque" };
    const stmts = ts.isSourceFile(cur) || ts.isBlock(cur) || ts.isModuleBlock(cur) || ts.isCaseClause(cur) || ts.isDefaultClause(cur) ? cur.statements : null;
    if (!stmts) continue;
    for (const st of stmts) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!bindingNames(d.name).includes(name)) continue;
          if (!ts.isIdentifier(d.name) || !d.initializer) return { kind: "opaque" };
          if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) return { kind: "fn", node: d.initializer, file };
          return { kind: "value", expr: d.initializer, file };
        }
      } else if (ts.isFunctionDeclaration(st) && st.name?.text === name) {
        return { kind: "fn", node: st, file };
      } else if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
        const el = st.importClause.namedBindings.elements.find((e) => e.name.text === name);
        if (!el) continue;
        const target = moduleFile(file, (st.moduleSpecifier as ts.StringLiteral).text);
        if (!target) return { kind: "opaque" };
        const sf = parseSource(target, src(target));
        return lookupName((el.propertyName ?? el.name).text, sf.endOfFileToken, target);
      }
    }
  }
  return null;
}
function returnedExpr(fn: { body?: ts.Node }): ts.Expression | null {
  if (!fn.body) return null;
  if (!ts.isBlock(fn.body)) return fn.body as ts.Expression;
  const rets = fn.body.statements.filter(ts.isReturnStatement);
  return rets.length === 1 && rets[0].expression ? rets[0].expression : null;
}
function resolveKey(e: ts.Expression, file: string, depth = 0): KeyShape | null {
  if (depth > 12) return null;
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) return resolveKey(e.expression, file, depth + 1);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { text: e.text, prefix: false };
  const head = (text: string): KeyShape | null => (text ? { text, prefix: true } : null);
  if (ts.isTemplateExpression(e)) {
    let text = e.head.text;
    for (const span of e.templateSpans) {
      const r = resolveKey(span.expression, file, depth + 1);
      if (!r || r.prefix) return head(text + (r?.text ?? ""));
      text += r.text + span.literal.text;
    }
    return { text, prefix: false };
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = resolveKey(e.left, file, depth + 1);
    if (!l || l.prefix) return l;
    const r = resolveKey(e.right, file, depth + 1);
    return r ? { text: l.text + r.text, prefix: r.prefix } : head(l.text);
  }
  if (ts.isConditionalExpression(e)) {
    const a = resolveKey(e.whenTrue, file, depth + 1), b = resolveKey(e.whenFalse, file, depth + 1);
    if (!a || !b) return null;
    if (!a.prefix && !b.prefix && a.text === b.text) return a;
    let i = 0;
    while (i < a.text.length && i < b.text.length && a.text[i] === b.text[i]) i++;
    return head(a.text.slice(0, i));
  }
  if (ts.isIdentifier(e)) {
    const d = lookupName(e.text, e, file);
    return d?.kind === "value" ? resolveKey(d.expr, d.file, depth + 1) : null;
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    const d = lookupName(e.expression.text, e.expression, file);
    const ret = d?.kind === "fn" ? returnedExpr(d.node) : null;
    return ret && d?.kind === "fn" ? resolveKey(ret, d.file, depth + 1) : null;
  }
  return null;
}
function storeOfReceiver(recv: string): "local" | "session" | null {
  if (/\blocalStorage\b|browserStore\("local"\)/.test(recv)) return "local";
  if (/\bsessionStorage\b|browserStore\("session"\)/.test(recv)) return "session";
  return null;
}
function storageKeysOf(file: string, text: string): { keys: FoundKey[]; unread: string[] } {
  const sf = parseSource(file, text);
  const keys: FoundKey[] = [];
  const unread: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(get|set|remove)Item$/.test(n.expression.name.text) && n.arguments.length > 0) {
      const recvText = n.expression.expression.getText(sf);
      const store = storeOfReceiver(recvText);
      const k = resolveKey(n.arguments[0], file);
      const recvShort = recvText.replace(/^window\./, "");
      if (k) keys.push({ ...k, store });
      else unread.push(`${recvShort}.${n.expression.name.text}(${n.arguments[0].getText(sf)})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // inline scripts: storage calls inside a string the page hands to the browser
  for (const m of text.matchAll(/\b(localStorage|sessionStorage)\.(?:get|set|remove)Item\(\s*'([^']*)'/g)) {
    const store = m[1] === "localStorage" ? "local" : "session";
    const ref = /^\$\{(\w+)\}$/.exec(m[2]);
    const value = ref ? new RegExp(`const ${ref[1]}\\s*=\\s*["']([^"']+)["']`).exec(text)?.[1] : m[2];
    if (value) keys.push({ text: value, prefix: false, store });
    else unread.push(`${m[1]}.…Item('${m[2]}')`);
  }
  return { keys, unread };
}
const keyMatchesRule = (k: FoundKey, r: ClientStorageRule) =>
  (k.store === null || k.store === r.store) && (r.match === "exact" ? !k.prefix && k.text === r.key : k.text.startsWith(r.key));
function censusFailures(file: string, text: string): string[] {
  const { keys, unread } = storageKeysOf(file, text);
  const out: string[] = [];
  for (const k of keys) {
    if (!CLIENT_STORAGE_INVENTORY.some((r) => r.owners.includes(file) && keyMatchesRule(k, r))) {
      out.push(`${file}: ${k.store ?? "?"}:${k.text}${k.prefix ? "…" : ""} matches no inventory row it owns`);
    }
  }
  const listed = INDIRECT_KEYS[file];
  for (const u of new Set(unread)) {
    if (!listed?.calls.includes(u)) out.push(`${file}: ${u} — a key the census cannot read; list it in INDIRECT_KEYS with what it carries`);
  }
  if (listed) {
    for (const c of listed.calls) if (!unread.includes(c)) out.push(`${file}: INDIRECT_KEYS lists ${c}, which is no longer there`);
    for (const key of listed.carries) {
      if (!CLIENT_STORAGE_INVENTORY.some((r) => r.key === key && (r.owners.includes(file) || file === ROLE_CONTEXT))) out.push(`${file}: INDIRECT_KEYS carries ${key}, which is no row it owns`);
    }
  }
  return out;
}

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

  it("per KEY: every key a file hands to getItem / setItem / removeItem matches a row of the right store that the file owns", () => {
    const failures = [...touching, ROLE_CONTEXT].flatMap((f) => censusFailures(f, src(f)));
    expect(failures).toEqual([]);
    // the census really sees the keys (not vacuous): one per resolution path
    const seen = (f: string) => storageKeysOf(f, src(f)).keys.map((k) => `${k.store ?? "?"}:${k.text}${k.prefix ? "…" : ""}`);
    expect(seen("components/navigation/GlobalCommandPalette.tsx")).toContain("local:mfg-os.palette.recents");      // a constant
    expect(seen("app/(protected)/graph/page.tsx")).toEqual(expect.arrayContaining(["session:org-graph-…", "local:orgGraph:pos…"])); // a local function's conditional; a template
    expect(seen("app/(protected)/intelligence/page.tsx")).toEqual(expect.arrayContaining(["local:intel-status-…", "local:schema-gaps-…"])); // an imported key builder
    expect(seen("components/ui/FirstRunHint.tsx")).toContain("local:first_run_hint:…");                              // a constant + a prop
    expect(seen("app/layout.tsx")).toContain("local:mfg-os.density");                                                 // an inline script
    expect(seen(ROLE_CONTEXT)).toContain("local:manufacturingos.lastIdentity");
  });

  it("per KEY, negative controls: a new key in a file that already owns rows fails until it has its own row", () => {
    const kp = "app/(protected)/knowledge/[id]/page.tsx";
    // the review's case — an account-read answer kept under a new prefix in a file that owns three rows
    const added = `${src(kp)}\nfunction __probe(libId: string, answerText: string) { localStorage.setItem(\`kl-last-answer-\${libId}\`, answerText); }\n`;
    expect(censusFailures(kp, added)).toEqual([`${kp}: local:kl-last-answer-… matches no inventory row it owns`]);
    // a known key in the wrong store
    const gp = "components/navigation/GlobalCommandPalette.tsx";
    expect(censusFailures(gp, `${src(gp)}\nexport function __probe(v: string) { sessionStorage.setItem(RECENTS_KEY, v); }\n`))
      .toEqual([`${gp}: session:mfg-os.palette.recents matches no inventory row it owns`]);
    // a key passed through a new helper's parameter is refused until it is listed with what it carries
    expect(censusFailures(gp, `${src(gp)}\nexport function __probe(key: string) { return localStorage.getItem(key); }\n`))
      .toEqual([`${gp}: localStorage.getItem(key) — a key the census cannot read; list it in INDIRECT_KEYS with what it carries`]);
    // a key another file owns
    expect(censusFailures(gp, `${src(gp)}\nexport function __probe() { return localStorage.getItem("requests.viewMode"); }\n`))
      .toEqual([`${gp}: local:requests.viewMode matches no inventory row it owns`]);
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
    L.setItem("dismissed:u1:o1:hint", "1"); L.setItem(LAST_IDENTITY_KEY, "u1");
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
    expect(window.localStorage.getItem(LAST_IDENTITY_KEY)).toBe("u1"); // so a different identity later still ends the held data
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

  it("supabaseSessionPersisted: a stored sb-…-auth-token in either store is a session; the PKCE verifier is not; an unreadable store is never a guess to purge on", () => {
    const store = (keys: string[]) => ({ length: keys.length, key: (i: number) => keys[i] ?? null }) as unknown as Storage;
    expect(supabaseSessionPersisted([store([]), store([])])).toBe(false);
    expect(supabaseSessionPersisted([store(["sb-abcd-auth-token"]), store([])])).toBe(true);
    expect(supabaseSessionPersisted([store([]), store(["sb-abcd-auth-token"])])).toBe(true);
    expect(supabaseSessionPersisted([store(["sb-abcd-auth-token-code-verifier", "mfg-os.palette.recents"]), store([])])).toBe(false);
    expect(supabaseSessionPersisted([null, store([])])).toBe(true);
    const forbidden = { get length(): number { throw new Error("SecurityError"); } } as unknown as Storage;
    expect(supabaseSessionPersisted([forbidden])).toBe(true);
  });
});

describe("OFF-8 — the provider's branches, rendered", () => {
  const seedAccount = () => {
    window.localStorage.setItem("mfg-os.palette.recents", "[]");
    window.localStorage.setItem("orgGraph:pos:o1", "{\"doc:d1\":[1,2,0]}");
    window.localStorage.setItem("dismissed:u1:o1:x", "1");
    window.sessionStorage.setItem("kl-active-thread-l1", "[]");
    window.sessionStorage.setItem("org-graph-o1", "{}");
    window.localStorage.setItem("manufacturingos.preferMicrosoft", "true");
    window.sessionStorage.setItem("manufacturingos.silentSSOAttempted", "1");
  };
  const everything = () => {
    const dump = (st: Storage) => Object.fromEntries(Array.from({ length: st.length }, (_, i) => st.key(i)!).sort().map((k) => [k, st.getItem(k)]));
    return { local: dump(window.localStorage), session: dump(window.sessionStorage) };
  };
  // Cache Storage (the service worker's shell, runtime and session caches)
  // and the draft hand-off IndexedDB database, observed.
  let cacheNames: Set<string>;
  let cachesApi: { keys: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let idbDeleted: string[];
  beforeEach(() => {
    cacheNames = new Set(["mfgos-shell", "mfgos-runtime", "mfgos-session"]);
    cachesApi = { keys: vi.fn(async () => [...cacheNames]), delete: vi.fn(async (n: string) => cacheNames.delete(n)) };
    vi.stubGlobal("caches", cachesApi);
    idbDeleted = [];
    vi.stubGlobal("indexedDB", {
      deleteDatabase: (name: string) => {
        idbDeleted.push(name);
        const req: Record<string, () => void> = {};
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const reload = async (session: { user: { id: string; email: string } } | null) => {
    act(() => root.unmount());
    root = createRoot(host);
    s.session = session;
    await mount();
  };

  it("SIGNED_OUT clears every account key, the draft hand-off, the remembered identity and the device workspace, keeps the silent-SSO flags — and PKG-1's Cache Storage purge still runs", async () => {
    s.session = { user: { id: "u1", email: "a@x.io" } };
    s.member = ADMIN;
    await mount();
    seedAccount();
    expect(window.localStorage.getItem(LAST_IDENTITY_KEY)).toBe("u1");
    await act(async () => { await s.authCb!("SIGNED_OUT", null); });
    expect(window.localStorage.getItem("mfg-os.palette.recents")).toBeNull();
    expect(window.localStorage.getItem("orgGraph:pos:o1")).toBeNull();
    expect(window.localStorage.getItem("dismissed:u1:o1:x")).toBeNull();
    expect(window.sessionStorage.getItem("kl-active-thread-l1")).toBeNull();
    expect(window.sessionStorage.getItem("org-graph-o1")).toBeNull();
    expect(window.localStorage.getItem(LAST_IDENTITY_KEY)).toBeNull();
    expect(window.localStorage.getItem("manufacturingos.activeOrgId")).toBeNull();
    expect(window.localStorage.getItem("manufacturingos.preferMicrosoft")).toBe("true");
    expect(window.sessionStorage.getItem("manufacturingos.silentSSOAttempted")).toBe("1");
    expect(idbDeleted).toEqual(["manufacturingos"]);
    expect(cachesApi.delete).toHaveBeenCalledTimes(3);
    expect([...cacheNames]).toEqual([]);
  });

  it("this tab's session evaporates and supabase-js keeps none: the caches go; held work, the remembered identity, the workspace and Cache Storage stay", async () => {
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
    expect(window.localStorage.getItem(LAST_IDENTITY_KEY)).toBe("u1");
    expect(window.localStorage.getItem("manufacturingos.activeOrgId")).toBe("o1");
    expect(cachesApi.keys).not.toHaveBeenCalled();
    expect(cachesApi.delete).not.toHaveBeenCalled();
    expect(idbDeleted).toEqual([]);
  });

  it("regression (review blocker): a tab that boots with no session — a new tab of a \"keep me signed in\"-off user still signed in on the first — deletes nothing on INITIAL_SESSION(null) and leaves Cache Storage alone", async () => {
    seedAccount();
    window.localStorage.setItem(LAST_IDENTITY_KEY, "u1"); // the first tab's identity
    await mount(); // no session in this tab
    const before = everything();
    await act(async () => { await s.authCb!("INITIAL_SESSION", null); });
    expect(probe()).toBe("NULL||resolving|none");
    expect(everything()).toEqual(before);
    expect(cachesApi.keys).not.toHaveBeenCalled();
    expect(cachesApi.delete).not.toHaveBeenCalled();
    expect(idbDeleted).toEqual([]);
  });

  it.each([["localStorage", "local"], ["sessionStorage", "session"]] as const)(
    "regression (review blocker): INITIAL_SESSION(null) while supabase-js still keeps the session in %s (an expired token it is retrying offline) keeps the palette recents, the graph layout and Cache Storage",
    async (_label, store) => {
      s.session = { user: { id: "u1", email: "a@x.io" } };
      s.member = ADMIN;
      await mount();
      seedAccount();
      window.localStorage.setItem("orgGraph:pos3d:o1", "{}");
      (store === "local" ? window.localStorage : window.sessionStorage).setItem("sb-abcd-auth-token", "{\"access_token\":\"expired\"}");
      const before = everything();
      await act(async () => { await s.authCb!("INITIAL_SESSION", null); });
      expect(everything()).toEqual(before);
      expect(window.localStorage.getItem("mfg-os.palette.recents")).toBe("[]");
      expect(window.localStorage.getItem("orgGraph:pos:o1")).not.toBeNull();
      expect(window.localStorage.getItem("orgGraph:pos3d:o1")).toBe("{}");
      expect(cachesApi.keys).not.toHaveBeenCalled();
      expect(cachesApi.delete).not.toHaveBeenCalled();
      expect([...cacheNames]).toHaveLength(3);
    },
  );

  it("a DIFFERENT identity booting after a reload — every sign-in lands on \"/\" and remounts the provider — ends the last one's held data and the draft hand-off (the review's path)", async () => {
    s.session = { user: { id: "u1", email: "a@x.io" } };
    s.member = ADMIN;
    await mount();
    await act(async () => { await s.authCb!("INITIAL_SESSION", null); }); // u1's session evaporates
    seedAccount(); // u1's ask thread, dismissals, caches
    s.member = { ...ADMIN, uid: "u2", email: "b@x.io" };
    await reload({ user: { id: "u2", email: "b@x.io" } }); // "/" → B signs in → the protected layout mounts a fresh provider
    expect(probe()).toBe("Admin|Admin|member|any");
    expect(window.sessionStorage.getItem("kl-active-thread-l1")).toBeNull();
    expect(window.localStorage.getItem("dismissed:u1:o1:x")).toBeNull();
    expect(window.localStorage.getItem("mfg-os.palette.recents")).toBeNull();
    expect(idbDeleted).toEqual(["manufacturingos"]);
    expect(window.localStorage.getItem(LAST_IDENTITY_KEY)).toBe("u2");
    expect(window.localStorage.getItem("manufacturingos.preferMicrosoft")).toBe("true");
    expect(window.sessionStorage.getItem("manufacturingos.silentSSOAttempted")).toBe("1");
  });

  it("a new tab booting as a DIFFERENT identity (the last one's tab closed with \"keep me signed in\" off) ends the last one's data", async () => {
    seedAccount();
    window.localStorage.setItem(LAST_IDENTITY_KEY, "u1");
    s.session = { user: { id: "u2", email: "b@x.io" } };
    s.member = { ...ADMIN, uid: "u2", email: "b@x.io" };
    await mount();
    expect(window.localStorage.getItem("mfg-os.palette.recents")).toBeNull();
    expect(window.localStorage.getItem("dismissed:u1:o1:x")).toBeNull();
    expect(idbDeleted).toEqual(["manufacturingos"]);
    expect(window.localStorage.getItem(LAST_IDENTITY_KEY)).toBe("u2");
  });

  it("regression: the SAME identity across a reload keeps everything; a first boot with nothing remembered purges nothing and remembers it", async () => {
    seedAccount();
    s.session = { user: { id: "u1", email: "a@x.io" } };
    s.member = ADMIN;
    const before = everything();
    await mount(); // first boot after this change: nothing remembered yet
    expect(window.localStorage.getItem(LAST_IDENTITY_KEY)).toBe("u1");
    const after = everything();
    delete (after.local as Record<string, unknown>)[LAST_IDENTITY_KEY];
    delete (after.local as Record<string, unknown>)["manufacturingos.activeOrgId"];
    delete (after.local as Record<string, unknown>)["manufacturingos.activeOrgId.owner"];
    expect(after).toEqual(before);
    await reload({ user: { id: "u1", email: "a@x.io" } });
    expect(window.localStorage.getItem("mfg-os.palette.recents")).toBe("[]");
    expect(window.localStorage.getItem("orgGraph:pos:o1")).not.toBeNull();
    expect(window.sessionStorage.getItem("kl-active-thread-l1")).toBe("[]");
    expect(window.localStorage.getItem("dismissed:u1:o1:x")).toBe("1");
    expect(idbDeleted).toEqual([]);
    expect(cachesApi.delete).not.toHaveBeenCalled();
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
    expect(window.localStorage.getItem(LAST_IDENTITY_KEY)).toBe("u2");
  });

  it("source: SIGNED_OUT purges every account store before the Cache Storage purge and the redirect; the evaporated branch purges caches only, only when gated, and never the workspace or Cache Storage; boot notes the identity before reading anything", () => {
    const rc = src(ROLE_CONTEXT);
    const start = rc.indexOf('if (event === "SIGNED_OUT") {');
    const block = rc.slice(start, rc.indexOf('window.location.replace("/");', start));
    expect(block.indexOf("clearStoredOrgId();")).toBeGreaterThan(0);
    expect(block.indexOf('await purgeAccountClientStores("all");')).toBeGreaterThan(block.indexOf("clearStoredOrgId();"));
    expect(block.indexOf("caches.keys()")).toBeGreaterThan(block.indexOf('await purgeAccountClientStores("all");'));
    const evap = rc.slice(rc.indexOf("// Session evaporated without a SIGNED_OUT"), rc.indexOf("// When tab becomes visible again"));
    expect(evap).toMatch(/if \(lastIdentityRef\.current !== null && !supabaseSessionPersisted\(\[browserStore\("local"\), browserStore\("session"\)\]\)\) \{\n\s*await purgeAccountClientStores\("cache"\);\n\s*\}/);
    expect(evap).not.toMatch(/caches\.|clearStoredOrgId|purgeAccountClientStores\("all"\)|location\.replace/);
    const boot = rc.slice(rc.indexOf("supabase.auth.getSession().then("), rc.indexOf("// Listen for auth changes"));
    expect(boot).toMatch(/const u = session\.user;\n(?:\s*\/\/.*\n)*\s*await noteIdentity\(u\.id\);\n\s*setUid\(u\.id\);/);
  });
});
