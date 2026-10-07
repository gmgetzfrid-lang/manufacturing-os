"use client";

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Role } from "@/types/schema";
import { normalizeRoles, primaryRole } from "@/lib/roleCapabilities";
import type { MembershipState } from "@/lib/protectedGate";
import { pickBestMembership } from "@/lib/membershipSelection";
import { readStoredOrgId, readStoredOrgIdFor, writeStoredOrgId, clearStoredOrgId } from "@/lib/workspaceDeviceState";
import { logWorkspaceRelocation } from "@/lib/audit";
import { normalizeEmail } from "@/lib/identity";

type OrgMember = {
  orgId: string;
  uid: string;
  role: Role;     // headline — highest-ranked of `roles`
  roles: Role[];  // additive collection
  status: "active" | "invited" | "suspended" | "inactive";
  email?: string;
  /** RG-9: the name a signature is recorded under (org_members.display_name). */
  displayName?: string | null;
};

// ─── Resolution budgets (SESS-2) ─────────────────────────────────────
// ONE budget for membership resolution, shared by the boot path and the
// SIGNED_IN user-switch path. 15s because Supabase cold-start on the
// free/shared tier can spend 5-10s on the first RLS-gated query of a
// session, and the retry ladder below adds up to three sequential attempts
// plus 1.8s of deliberate backoff. A safety net, not a normal-case
// constraint. When it trips, membership resolves to "error" — the honest
// retry screen — never to a rendered placeholder role.
const RESOLVE_BUDGET_MS = 15_000;
// The spinner watchdogs are deliberately SHORTER than the resolve budget:
// they only decide when the full-screen "Authenticating…" spinner yields to
// the layout's still-resolving screen. They never decide what role renders —
// the layout branches on membershipState (SESS-1), so force-clearing
// `loading` early costs an honest waiting screen, not a wrong render.
const LOADING_WATCHDOG_MS = 6_000;
const BOOT_SPINNER_MS = 8_000;

// ─── What this browser keeps, and what a sign-out removes (OFF-8) ─────
// The rule (DEC-44 (IS-P1) §2): a value an account READ from the server —
// records, titles, ids, threads, files, snapshots — must not outlive the
// account that fetched it. Every key the app writes to localStorage /
// sessionStorage, and the one IndexedDB database, is listed here with its
// class; lib/__tests__/sessSixRoleNull.test.ts refuses a key — a literal, a
// constant or a template's fixed head at any getItem / setItem / removeItem
// — that matches no row here (or a row its file does not own).
//   - "account": what the account read. Its `kind` says when it goes:
//       "cache"    — rebuilt from the server on the next visit. Cleared on
//                    every SIGNED_OUT, when a DIFFERENT identity next runs
//                    the app in this browser or this tab (LAST_IDENTITY_KEY
//                    — across a reload and across tabs), and when THIS tab
//                    had an identity, its session evaporates without a
//                    SIGNED_OUT, and supabase-js keeps no session in
//                    localStorage or in this tab's sessionStorage (an
//                    expired token it is still retrying keeps them).
//       "held"     — per-identity state: cleared on SIGNED_OUT and when a
//                    different identity runs the app; kept when a session
//                    evaporates.
//       "identity" — the person's own work or arrangement, which an
//                    expiry-driven SIGNED_OUT (indistinguishable here from
//                    a sign-out button) must not cost them — it survived
//                    every sign-out before IS-P1. Kept on SIGNED_OUT and
//                    when a session evaporates; ended only when a DIFFERENT
//                    identity next runs the app in this browser or this
//                    tab, before anything of that identity is read
//                    (noteIdentity). The remembered identity is itself of
//                    this kind, so it outlives the sign-out it must answer.
//   - "workspace": the device workspace pointer — cleared on SIGNED_OUT by
//     clearStoredOrgId (IDENT-4), kept on evaporation (owner-checked).
//   - "sign-in": the sign-in flow's own state, which must survive an
//     expiry-driven SIGNED_OUT (the silent-SSO flags, the post-sign-in
//     destination, the "keep me signed in" choice, supabase-js's session).
//   - "uid-scoped": keyed by the account's uid, so never served to another
//     identity — kept.
//   - "device": how this device looks and which hints were seen — not
//     anything an account read — kept.
export type ClientStorageClass = "account" | "workspace" | "sign-in" | "uid-scoped" | "device";
export type AccountKind = "cache" | "held" | "identity";
export type ClientStorageRule = {
  store: "local" | "session";
  /** The exact key, or (match "prefix") every key starting with it. */
  key: string;
  match: "exact" | "prefix";
  class: ClientStorageClass;
  /** For "account" rows: which ends drop it (see the class notes above). */
  kind?: AccountKind;
  /** The files that read or write it. */
  owners: readonly string[];
  why: string;
};

export const CLIENT_STORAGE_INVENTORY: readonly ClientStorageRule[] = [
  // ── account: what the account read ──
  { store: "local", key: "intel-status-", match: "prefix", class: "account", kind: "cache", owners: ["lib/hubStatus.ts", "app/(protected)/intelligence/page.tsx"], why: "the hub's status snapshot (HUB-10) — the account's key and index state" },
  { store: "session", key: "intel-status-", match: "prefix", class: "account", kind: "cache", owners: ["lib/hubStatus.ts", "app/(protected)/intelligence/page.tsx"], why: "the legacy org-only snapshot key, removed on sight" },
  { store: "local", key: "schema-gaps-", match: "prefix", class: "account", kind: "cache", owners: ["lib/hubStatus.ts", "app/(protected)/intelligence/page.tsx"], why: "the hub's schema-gap snapshot" },
  { store: "session", key: "schema-gaps-", match: "prefix", class: "account", kind: "cache", owners: ["lib/hubStatus.ts", "app/(protected)/intelligence/page.tsx"], why: "the legacy org-only gap key, removed on sight" },
  { store: "local", key: "mfg-os.palette.recents", match: "exact", class: "account", kind: "identity", owners: ["components/navigation/GlobalCommandPalette.tsx"], why: "the titles and links of the documents, projects and requests the account last opened — the person's own list, kept across a sign-out for their next sign-in, ended before another identity sees it" },
  { store: "local", key: "orgGraph:pos", match: "prefix", class: "account", kind: "identity", owners: ["app/(protected)/graph/page.tsx"], why: "the graph layout the person arranged (every settle and drag), keyed by org and by the ids of the nodes the account's graph returned — kept across a sign-out, as before IS-P1, ended before another identity sees it" },
  { store: "session", key: "org-graph-", match: "prefix", class: "account", kind: "cache", owners: ["app/(protected)/graph/page.tsx"], why: "the assembled graph (node titles included) painted instantly on return" },
  { store: "session", key: "mfg-os:lib:", match: "prefix", class: "account", kind: "cache", owners: ["app/(protected)/documents/[libraryId]/page.tsx"], why: "the library row (its access lists included) painted instantly on return" },
  { store: "session", key: "kl-active-thread-", match: "prefix", class: "account", kind: "identity", owners: ["app/(protected)/knowledge/[id]/page.tsx"], why: "the account's open ask thread — its questions and the answers drawn from its documents; kept across a sign-out in this tab for the same person, ended when another identity runs the app in this tab" },
  { store: "local", key: "dismissed:", match: "prefix", class: "account", kind: "held", owners: ["hooks/useDismissed.ts"], why: "dismissals, keyed <uid>:<org> — useDismissed also sweeps them on SIGNED_OUT" },
  { store: "local", key: "manufacturingos.lastIdentity", match: "exact", class: "account", kind: "identity", owners: ["components/providers/RoleContext.tsx"], why: "the uid the app last ran as in this browser, so a DIFFERENT identity booting here — after a sign-out, a reload or in a new tab — ends the last one's account data first (kept across SIGNED_OUT and evaporation; it is what lets the person's own work outlive a sign-out)" },
  { store: "session", key: "manufacturingos.lastIdentity", match: "exact", class: "account", kind: "identity", owners: ["components/providers/RoleContext.tsx"], why: "the uid THIS tab last ran as, so a different identity booting in this tab ends this tab's sessionStorage account data even when another tab already moved the browser's memory to that identity" },
  // ── workspace ──
  { store: "local", key: "manufacturingos.activeOrgId", match: "exact", class: "workspace", owners: ["lib/workspaceDeviceState.ts"], why: "the device workspace (IDENT-4: cleared on SIGNED_OUT, owner-checked otherwise)" },
  { store: "local", key: "manufacturingos.activeOrgId.owner", match: "exact", class: "workspace", owners: ["lib/workspaceDeviceState.ts"], why: "the uid that stored the device workspace" },
  // ── sign-in: must survive an expiry-driven SIGNED_OUT ──
  { store: "local", key: "manufacturingos.preferMicrosoft", match: "exact", class: "sign-in", owners: ["lib/supabase.ts"], why: "the silent-SSO flag: an expiry keeps it; the explicit sign-out buttons clear it themselves" },
  { store: "session", key: "manufacturingos.silentSSOAttempted", match: "exact", class: "sign-in", owners: ["app/page.tsx"], why: "the once-per-tab silent-SSO guard — clearing it on an expiry-driven SIGNED_OUT could loop the silent attempt" },
  { store: "session", key: "manufacturingos.signInNext", match: "exact", class: "sign-in", owners: ["lib/signInNext.ts"], why: "the destination carried across the Microsoft round trip (TTL'd, consumed once)" },
  { store: "local", key: "manufacturingos.rememberSession", match: "exact", class: "sign-in", owners: ["lib/supabase.ts"], why: "the login screen's \"keep me signed in\" choice, set before sign-in" },
  { store: "local", key: "sb-", match: "prefix", class: "sign-in", owners: ["lib/supabase.ts"], why: "supabase-js's session and PKCE verifier (hybridAuthStorage) — supabase-js removes them itself" },
  { store: "session", key: "sb-", match: "prefix", class: "sign-in", owners: ["lib/supabase.ts"], why: "the same, for a session not kept signed in" },
  // ── uid-scoped ──
  { store: "local", key: "manufacturingos.dashboard.", match: "prefix", class: "uid-scoped", owners: ["lib/dashboard/config.ts"], why: "the mirror of users.dashboard_config, keyed by uid" },
  // ── device ──
  { store: "local", key: "mfgos.theme.mode", match: "exact", class: "device", owners: ["components/providers/ThemeProvider.tsx"], why: "light / dark" },
  { store: "local", key: "mfgos.theme.palette", match: "exact", class: "device", owners: ["components/providers/ThemeProvider.tsx"], why: "accent colours" },
  { store: "local", key: "mfgos.theme.accent", match: "exact", class: "device", owners: ["components/providers/ThemeProvider.tsx"], why: "the legacy accent" },
  { store: "local", key: "mfg-os.density", match: "exact", class: "device", owners: ["components/navigation/DensityToggle.tsx", "app/layout.tsx"], why: "row density" },
  { store: "local", key: "mfg-os.sidebar.collapsed", match: "exact", class: "device", owners: ["components/navigation/Sidebar.tsx"], why: "the rail's collapsed state" },
  { store: "local", key: "mfg-os.sidebar.closedSections", match: "exact", class: "device", owners: ["components/navigation/Sidebar.tsx"], why: "which sidebar sections are folded" },
  { store: "local", key: "requests.viewMode", match: "exact", class: "device", owners: ["app/(protected)/requests/page.tsx"], why: "table / grid / team" },
  { store: "local", key: "kl-cite-hint-seen", match: "exact", class: "device", owners: ["app/(protected)/knowledge/[id]/page.tsx"], why: "a hint was seen" },
  { store: "local", key: "knowledge-ask-mode", match: "exact", class: "device", owners: ["app/(protected)/knowledge/[id]/page.tsx"], why: "the ask mode last chosen" },
  { store: "local", key: "orgGraph:settings:", match: "prefix", class: "device", owners: ["lib/graphSettings.ts"], why: "how the graph is drawn (forces, colours, lens) — DEC-88 keeps it local" },
  { store: "local", key: "first_run_hint:", match: "prefix", class: "device", owners: ["components/ui/FirstRunHint.tsx"], why: "a hint was seen" },
  { store: "local", key: "exec.guide.seen.v1", match: "exact", class: "device", owners: ["components/projects/ExecutionGuide.tsx"], why: "a guide was seen" },
  { store: "local", key: "costGlossarySeen.v1", match: "exact", class: "device", owners: ["components/projects/cost/CostCharts.tsx"], why: "a glossary was seen" },
  { store: "local", key: "mfg-os.setup-checklist.dismissed", match: "exact", class: "device", owners: ["components/onboarding/SetupChecklist.tsx"], why: "the setup checklist was put away" },
  { store: "local", key: "mfg-os.staleCheckouts.dismissedUntil", match: "exact", class: "device", owners: ["components/projects/StaleCheckoutBanner.tsx"], why: "a banner snooze time" },
  { store: "local", key: "mfg.inspector.sec.", match: "prefix", class: "device", owners: ["components/ui/CollapsibleSection.tsx"], why: "which inspector sections are folded" },
  { store: "local", key: "mfg.revup.", match: "prefix", class: "device", owners: ["components/documents/RevUpModal.tsx"], why: "the issue type last chosen in a library's rev-up" },
  { store: "local", key: "manufacturingos.customStamps", match: "exact", class: "device", owners: ["components/viewers/FullScreenViewer.tsx"], why: "stamp images the person uploaded on this device — not an account read; not keyed by uid, so the next account on the device is offered them (public-surfaces OFF-15)" },
  { store: "session", key: "kl-embed-nudge-at", match: "exact", class: "device", owners: ["lib/knowledge.ts"], why: "a throttle timestamp" },
];

/** The one IndexedDB database the app opens. */
export const CLIENT_INDEXED_DB_INVENTORY: readonly { name: string; stores: readonly string[]; class: "account"; kind: AccountKind; owners: readonly string[]; why: string }[] = [
  { name: "manufacturingos", stores: ["draftHandoff"], class: "account", kind: "identity", owners: ["lib/draftHandoff.ts"], why: "marked-up drawings handed from the viewer to the request form, kept until that request is submitted (LIFE-3) — across an expiry-driven sign-out too, as before IS-P1; deleted when a different identity runs the app here" },
];

function ruleMatches(rule: ClientStorageRule, key: string): boolean {
  return rule.match === "exact" ? key === rule.key : key.startsWith(rule.key);
}

/** Which "account" keys a purge removes: every one when a DIFFERENT identity
 *  ends the last one ("all"); the caches and the held state when a
 *  SIGNED_OUT ends the session ("signout" — the person's own work, kind
 *  "identity", stays for the same person's next sign-in); only the
 *  rebuildable caches when a session merely evaporated ("cache"). */
export type AccountPurgeScope = "all" | "signout" | "cache";

/** Does a purge of this scope remove an account row of this kind? */
export function purgeTakes(scope: AccountPurgeScope, kind: AccountKind | undefined): boolean {
  return scope === "all" || kind === "cache" || (scope === "signout" && kind === "held");
}

/** Remove the account keys (CLIENT_STORAGE_INVENTORY, class "account") from
 *  one browser store. Never throws — storage can be missing or forbidden.
 *  Returns the keys it removed. */
export function purgeAccountStorage(storage: Storage | null | undefined, store: "local" | "session", scope: AccountPurgeScope): string[] {
  const rules = CLIENT_STORAGE_INVENTORY.filter((r) =>
    r.store === store && r.class === "account" && purgeTakes(scope, r.kind));
  const doomed: string[] = [];
  try {
    if (!storage) return doomed;
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && rules.some((r) => ruleMatches(r, k))) doomed.push(k);
    }
    doomed.forEach((k) => storage.removeItem(k));
  } catch { /* private mode / storage forbidden */ }
  return doomed;
}

/** localStorage, or null where reading it throws (a forbidden store). */
function browserStore(store: "local" | "session"): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return store === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Both browser stores, then the account IndexedDB databases the scope takes
 *  (only "all" today: the draft hand-off is kind "identity") — awaited but
 *  bounded, so a blocked delete can never hold an identity change (a delete
 *  still blocked by an open connection completes once it closes). */
export async function purgeAccountClientStores(scope: AccountPurgeScope, opts?: { idb?: IDBFactory | null; budgetMs?: number }): Promise<void> {
  purgeAccountStorage(browserStore("local"), "local", scope);
  purgeAccountStorage(browserStore("session"), "session", scope);
  const doomedDbs = CLIENT_INDEXED_DB_INVENTORY.filter((db) => purgeTakes(scope, db.kind));
  if (doomedDbs.length === 0) return;
  let idb: IDBFactory | null = null;
  try { idb = opts?.idb !== undefined ? opts.idb : (typeof indexedDB !== "undefined" ? indexedDB : null); } catch { idb = null; }
  if (!idb) return;
  const factory = idb;
  const deletions = doomedDbs.map((db) => new Promise<void>((done) => {
    try {
      const req = factory.deleteDatabase(db.name);
      req.onsuccess = () => done();
      req.onerror = () => done();
      req.onblocked = () => done();
    } catch { done(); }
  }));
  await Promise.race([Promise.all(deletions), new Promise<void>((done) => setTimeout(done, opts?.budgetMs ?? 1500))]);
}

/** A session user appearing after a DIFFERENT one was last seen here (a
 *  switch, a sign-in after a sign-out or an evaporated session) ends the
 *  last identity's account data — its "held" and "identity" keys included. */
export function identityChangeEndsAccount(lastUid: string | null, nextUid: string): boolean {
  return !!lastUid && lastUid !== nextUid;
}

/** OFF-8: where the last identity is remembered between page loads — in
 *  localStorage for the browser, and in sessionStorage for this tab (a
 *  tab's sessionStorage is its own: another tab's purge cannot reach it).
 *  The protected app never sees a sign-in (every sign-in happens on "/",
 *  outside this provider, and lands with a fresh page load), so an identity
 *  held only in memory could never be compared with the next one. Class
 *  "account" / kind "identity" in the inventory: kept across SIGNED_OUT and
 *  an evaporated session, so the next DIFFERENT identity still ends the
 *  person's kept work before it reads anything. */
export const LAST_IDENTITY_KEY = "manufacturingos.lastIdentity";

function readLastIdentity(store: "local" | "session"): string | null {
  try {
    return (store === "local" ? browserStore("local")?.getItem(LAST_IDENTITY_KEY) : browserStore("session")?.getItem(LAST_IDENTITY_KEY)) || null;
  } catch { return null; }
}

function writeLastIdentity(uid: string): void {
  try { browserStore("local")?.setItem(LAST_IDENTITY_KEY, uid); } catch { /* storage forbidden — this tab still remembers */ }
  try { browserStore("session")?.setItem(LAST_IDENTITY_KEY, uid); } catch { /* storage forbidden */ }
}

/** supabase-js's persisted session key (`sb-<project ref>-auth-token`; the
 *  PKCE verifier `…-auth-token-code-verifier` is not a session). */
const SUPABASE_SESSION_KEY = /^sb-.*-auth-token$/;

/** Does supabase-js still keep a session in this browser — in localStorage
 *  ("keep me signed in") or in this tab's sessionStorage? An INITIAL_SESSION
 *  with no session does not mean the account is gone: auth-js answers null
 *  while it retries an expired token on a flaky network (the session stays
 *  stored and the next TOKEN_REFRESHED brings the same user back), and a
 *  new tab of a "keep me signed in"-off user has no session while the first
 *  tab is still signed in. A store that cannot be read counts as keeping
 *  one — never purge on a guess. */
export function supabaseSessionPersisted(stores: ReadonlyArray<Storage | null | undefined>): boolean {
  for (const st of stores) {
    try {
      if (!st) return true;
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (k && SUPABASE_SESSION_KEY.test(k)) return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

/** A self-heal moved this session to a different workspace than the one the
 *  device/profile pointed at (ORGSEL-4). Non-null until the user
 *  acknowledges it, switches workspace, or signs out. */
export type WorkspaceRelocation = {
  fromOrgId: string | null;
  toOrgId: string;
  /** How many active memberships were in the running. >1 means the resolver
   *  CHOSE (highest role rank, then oldest membership — see
   *  lib/membershipSelection.ts) and did NOT persist the choice as the new
   *  default. */
  candidateCount: number;
};

type RoleContextValue = {
  loading: boolean;
  /** True once the boot sequence has settled — getSession returned (with or
   *  without a session) or the boot timeout gave up. Before that, a null
   *  `uid` means "not known yet", not "signed out". */
  booted: boolean;
  /** The headline role of an ACTIVE membership, or `null` whenever there
   *  is none to report: while membership is resolving, after a failed
   *  lookup, for an account that is not an active member, and after
   *  sign-out (SESS-6). `null` never means "Viewer" — it means "no role is
   *  known", and every consumer treats it as the least-privileged state (no
   *  actions, no read grant from the role). The type makes an unchecked
   *  read a compile error instead of a confident placeholder: branch on
   *  `null` (or use `hasRole` / `hasAnyRole`, which answer `false` while it
   *  is `null`). `membershipState` still says WHY it is `null`. */
  activeRole: Role | null;
  /** Full additive role collection for the active org. `activeRole` is the
   *  headline (highest-ranked) of these. `[]` whenever `activeRole` is
   *  `null` (until `membershipState === "member"`). */
  roles: Role[];
  /** True if the member holds `role` among their collection. */
  hasRole: (role: Role) => boolean;
  /** True if the member holds any of `roles` among their collection. */
  hasAnyRole: (roles: Role[]) => boolean;
  userEmail: string | null;
  uid: string | null;
  activeOrgId: string | null;
  setActiveOrgId: (orgId: string | null) => Promise<void>;
  member: OrgMember | null;
  /** The honest answer to "is this signed-in account admitted anywhere?"
   *  "none" = authenticated but not a member of any workspace (show the
   *  hard-stop screen, never a fake empty Viewer app); "error" = the
   *  membership lookup itself failed after retries (show retry, never
   *  silently downgrade to Viewer). */
  membershipState: MembershipState;
  /** Set when a self-heal relocated this session — the layout shows a
   *  notice so a workspace change is never indistinguishable from a normal
   *  sign-in (ORGSEL-4). */
  workspaceRelocation: WorkspaceRelocation | null;
  acknowledgeWorkspaceRelocation: () => void;
};

const RoleContext = createContext<RoleContextValue | null>(null);

export function RoleProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [uid, setUid] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  // Restore the workspace BEFORE FIRST PAINT, not in the initializer. The
  // synchronous initializer read localStorage on the client but the server
  // pre-render had null — every signed-in user's first client render
  // disagreed with the server HTML across the whole protected tree, which
  // is the React #418 hydration error that kept appearing in production.
  // A layout effect runs after hydration but before the browser paints, so
  // the org is back for the first visible frame (no flash, no hang on a
  // transient-null loading state) and both hydration renders start null.
  const [activeOrgId, _setActiveOrgId] = useState<string | null>(null);
  useLayoutEffect(() => {
    // Owner validation is impossible here (no session yet) — resolution
    // re-validates with readStoredOrgIdFor(uid) before trusting the value.
    const v = readStoredOrgId();
    if (v) _setActiveOrgId((cur) => cur ?? v);
  }, []);
  const [activeRole, setActiveRole] = useState<Role | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [member, setMember] = useState<OrgMember | null>(null);
  const [membershipState, setMembershipState] = useState<MembershipState>("resolving");
  const [workspaceRelocation, setWorkspaceRelocation] = useState<WorkspaceRelocation | null>(null);
  const [booted, setBooted] = useState(false);
  const bootedRef = useRef(false);
  // Track the *current* uid in a ref so the auth-state callback (which
  // captures the initial closure) can detect "this SIGNED_IN is just a
  // re-emit of the same user" without blocking the UI on every tab return.
  const uidRef = useRef<string | null>(null);
  // OFF-8: the last session user seen on this tab. Unlike uidRef it survives
  // a session that evaporates without a SIGNED_OUT. A DIFFERENT identity is
  // compared against the identity the app last ran as in this browser and
  // in this tab (LAST_IDENTITY_KEY, which outlives a SIGNED_OUT; this ref
  // stands in where storage cannot be read), so one booting here — after a
  // sign-out, a reload, or in a new tab — ends the last one's account data
  // before it reads anything (identityChangeEndsAccount): all of it when the
  // browser last ran as someone else; this tab's sessionStorage copy when
  // only this tab did (another tab already ended the rest).
  const lastIdentityRef = useRef<string | null>(null);
  const noteIdentity = async (nextUid: string) => {
    if (lastIdentityRef.current === nextUid) return;
    const browserLast = readLastIdentity("local") ?? lastIdentityRef.current;
    const tabLast = readLastIdentity("session") ?? lastIdentityRef.current;
    if (identityChangeEndsAccount(browserLast, nextUid)) {
      await purgeAccountClientStores("all");
    } else if (identityChangeEndsAccount(tabLast, nextUid)) {
      purgeAccountStorage(browserStore("session"), "session", "all");
    }
    lastIdentityRef.current = nextUid;
    writeLastIdentity(nextUid);
  };

  // Keep uidRef in sync so the auth-state subscription (which only closes
  // over the initial value) can check identity changes.
  useEffect(() => { uidRef.current = uid; }, [uid]);

  // Resolve bookkeeping. Resolves can overlap (boot + a user switch, or a
  // rescue from a token refresh); the GENERATION counter makes them
  // last-STARTED-wins instead of last-FINISHED-wins — a superseded resolve
  // must not write state, persist a workspace, announce a relocation, or
  // stamp "error" over a newer resolve's progress.
  const resolveGenRef = useRef(0);
  const resolveInFlightRef = useRef(false);
  const membershipStateRef = useRef<MembershipState>("resolving");
  useEffect(() => { membershipStateRef.current = membershipState; }, [membershipState]);

  // Watchdog: never let `loading` stay true forever. Whenever loading flips
  // to true post-boot, give it a few seconds to resolve; after that, force it
  // false so the user is never staring at a blank "Authenticating…" spinner.
  // Auth-gated queries still work — they'll surface their own errors. The
  // layout's membershipState branch keeps this from ever rendering a
  // placeholder role (SESS-1).
  useEffect(() => {
    if (!loading) return;
    const t = window.setTimeout(() => {
      console.warn("[RoleContext] loading watchdog tripped — force-clearing spinner");
      setLoading(false);
    }, LOADING_WATCHDOG_MS);
    return () => window.clearTimeout(t);
  }, [loading]);

  // Shared budget wrapper (SESS-2): both resolve paths race the same clock.
  const raceWithBudget = useCallback(async (p: Promise<void>) => {
    let timer: number | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = window.setTimeout(
        () => reject(new Error(`membership resolve exceeded ${RESOLVE_BUDGET_MS}ms budget`)),
        RESOLVE_BUDGET_MS
      );
    });
    try {
      await Promise.race([p, budget]);
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }, []);

  const persistOrgId = useCallback(async (nextOrgId: string | null, nextUid: string) => {
    writeStoredOrgId(nextOrgId, nextUid);
    try {
      await supabase.from("users").upsert({
        id: nextUid,
        default_org_id: nextOrgId ?? null,
        updated_at: new Date().toISOString(),
      });
    } catch {}
  }, []);

  const setActiveOrgId = useCallback(async (orgId: string | null) => {
    _setActiveOrgId(orgId);
    // A deliberate switch resolves any pending relocation notice — the user
    // has now chosen where they are.
    setWorkspaceRelocation(null);
    // Always write localStorage immediately so a refresh restores the workspace,
    // even if uid hasn't propagated yet (which would skip the DB upsert).
    writeStoredOrgId(orgId, uid ?? null);
    if (uid) await persistOrgId(orgId, uid);
  }, [uid, persistOrgId]);

  const acknowledgeWorkspaceRelocation = useCallback(() => {
    setWorkspaceRelocation(null);
  }, []);

  const resolveOrgAndRole = async (userId: string, email: string | null, gen: number) => {
    // Every state write below is guarded: a resolve that has been superseded
    // (a newer one started — user switch, rescue, retry) must contribute
    // nothing, not even an error stamp.
    const isCurrent = () => resolveGenRef.current === gen;
    setMembershipState("resolving");
    setWorkspaceRelocation(null);

    type Attempt = {
      orgId: string | null;
      mem: Record<string, unknown> | null;
      /** Set when the self-heal picked a workspace: where resolution started
       *  from and how many candidates were in the running (ORGSEL-1/4). */
      relocation: { fromOrgId: string | null; candidateCount: number } | null;
    };

    // Every query THROWS on error so the retry loop below can tell "the
    // lookup failed" apart from "this account truly has no membership". The
    // old code swallowed errors and answered Viewer for both — on a flaky
    // phone connection that dressed an Admin up as a locked-out stranger.
    const attempt = async (): Promise<Attempt> => {
      // 1) Candidate org: this device's last workspace (only if this uid
      //    stored it — a second identity on the same browser must not
      //    inherit it, IDENT-4) → profile default.
      let orgId: string | null = readStoredOrgIdFor(userId);
      if (!orgId) {
        const { data: profile, error } = await supabase
          .from("users").select("default_org_id").eq("id", userId).maybeSingle();
        if (error) throw new Error(error.message);
        if (profile?.default_org_id) orgId = profile.default_org_id as string;
      }

      // 2) Membership in the candidate org.
      let mem: Record<string, unknown> | null = null;
      if (orgId) {
        const { data, error } = await supabase
          .from("org_members").select("*")
          .eq("org_id", orgId).eq("uid", userId).maybeSingle();
        if (error) throw new Error(error.message);
        mem = data as Record<string, unknown> | null;
      }

      // 3) Self-heal: no ACTIVE membership in the candidate (stale device
      //    workspace, revoked access, fresh phone) → a DETERMINISTIC pick
      //    among their active memberships instead of a dead end. The old
      //    `limit(1)` with no ORDER BY was an arbitrary pick that could land
      //    an Admin in the one workspace where they are a Viewer — and then
      //    persisted the accident as the new default (ORGSEL-1).
      let relocation: Attempt["relocation"] = null;
      if (!mem || mem.status !== "active") {
        // Server-side ORDER BY so the fetched subset is itself stable: with
        // more than 20 active memberships the cap would otherwise reintroduce
        // the arbitrary-subset problem one level up from the picker. Ranking
        // still happens client-side (role rank isn't expressible here).
        const { data, error } = await supabase
          .from("org_members").select("*")
          .eq("uid", userId).eq("status", "active")
          .order("created_at", { ascending: true })
          .order("org_id", { ascending: true })
          .limit(20);
        if (error) throw new Error(error.message);
        const pick = pickBestMembership((data ?? []) as Array<Record<string, unknown>>);
        if (pick) {
          relocation = { fromOrgId: orgId, candidateCount: pick.candidateCount };
          mem = pick.row;
          orgId = pick.orgId;
        }
      }
      return { orgId, mem, relocation };
    };

    let resolved: Attempt | null = null;
    let lastErr: unknown = null;
    for (let i = 0; i < 3 && !resolved; i++) {
      try {
        resolved = await attempt();
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 600 * (i + 1)));
      }
    }
    if (!resolved) {
      // Real lookup failure — say so and let the shell offer a retry.
      console.warn("[RoleContext] membership resolution failed after retries", lastErr);
      if (!isCurrent()) return;
      setMember(null);
      setRoles([]);
      setActiveRole(null);
      setMembershipState("error");
      return;
    }
    if (!isCurrent()) return; // a newer resolve owns the state now

    const { orgId, mem, relocation } = resolved;
    _setActiveOrgId(orgId);

    if (orgId && mem) {
      // Additive collection from `roles`, falling back to the legacy single
      // `role` (pre-migration rows). Headline is the highest-ranked role.
      const collection = normalizeRoles(mem.roles, mem.role as Role | undefined);
      const headline = primaryRole(collection);
      const nextMember: OrgMember = {
        orgId,
        uid: userId,
        role: headline,
        roles: collection,
        status: ((mem.status as string | null) ?? "inactive") as OrgMember["status"],
        email: (mem.email as string | undefined) ?? email ?? undefined,
        displayName: ((mem.display_name as string | null | undefined) ?? "").trim() || null,
      };
      const active = nextMember.status === "active";
      setMember(nextMember);
      setRoles(active ? collection : []);
      setActiveRole(active ? headline : null);
      setMembershipState(active ? "member" : "none");

      // Persist the workspace as the new default ONLY when it wasn't a
      // choice among several (ORGSEL-1): the normal candidate path and the
      // sole-membership self-heal keep today's behavior; a pick among
      // multiple workspaces stays unpersisted until the user confirms it
      // (the relocation notice offers that).
      const chosenAmongSeveral = (relocation?.candidateCount ?? 0) > 1;
      if (active && !chosenAmongSeveral) void persistOrgId(orgId, userId);

      // A self-heal that moved away from a real candidate is announced and
      // recorded, never silent (ORGSEL-4). Fresh-device resolution
      // (no candidate at all) stays silent, as designed.
      if (active && relocation?.fromOrgId && relocation.fromOrgId !== orgId) {
        setWorkspaceRelocation({
          fromOrgId: relocation.fromOrgId,
          toOrgId: orgId,
          candidateCount: relocation.candidateCount,
        });
        void logWorkspaceRelocation({
          toOrgId: orgId,
          fromOrgId: relocation.fromOrgId,
          candidateCount: relocation.candidateCount,
          userId,
          userEmail: email ?? undefined,
          userRole: headline,
        });
      }
    } else {
      setMember(null);
      setRoles([]);
      setActiveRole(null);
      setMembershipState("none");
    }

    // Upsert user profile — pure bookkeeping, so it must never hold the
    // boot: awaiting this write kept every hard page load on the
    // "Authenticating…" spinner for an extra database round trip. Email is
    // stored in canonical form (IDENT-3) — Azure returns the UPN in
    // directory casing, and this fire-and-forget write must not undo the
    // normalization the server routes and migration establish.
    void supabase.from("users").upsert({
      id: userId,
      email: email ? normalizeEmail(email) : null,
      updated_at: new Date().toISOString(),
    }).then(() => undefined, () => undefined);
  };

  // The one entry point for membership resolution: allocates the generation,
  // races the shared budget, and lands budget exhaustion on the honest
  // "error" retry screen — but only if this resolve is still the current
  // one. Never throws.
  const startResolve = async (userId: string, email: string | null) => {
    const gen = ++resolveGenRef.current;
    resolveInFlightRef.current = true;
    try {
      await raceWithBudget(resolveOrgAndRole(userId, email, gen));
    } catch (err) {
      console.warn("[RoleContext] membership resolve exceeded its budget", err);
      if (resolveGenRef.current === gen) {
        setMembershipState((s) => (s === "resolving" ? "error" : s));
      }
    } finally {
      if (resolveGenRef.current === gen) resolveInFlightRef.current = false;
    }
  };

  useEffect(() => {
    // Safety: never let "Authenticating..." spin forever. If boot stalls
    // (slow network, stuck supabase call), drop the spinner and let the
    // layout show its still-resolving screen — auth-gated queries will
    // either work or redirect on their own.
    const bootTimeout = window.setTimeout(() => {
      setLoading(false);
      bootedRef.current = true;
      setBooted(true);
    }, BOOT_SPINNER_MS);

    // Get initial session
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user) {
        const u = session.user;
        // OFF-8: a different identity than the one the app last ran as in
        // this browser ends that identity's account data before anything of
        // this one's is read or written.
        await noteIdentity(u.id);
        setUid(u.id);
        setUserEmail(u.email ?? null);
        // Same budget as the SIGNED_IN path (SESS-2) — the boot resolve used
        // to have no timeout at all, so a hung query parked the app on a
        // placeholder forever. On budget exhaustion, land on "error" (the
        // retry screen); a resolve that limps in later still overwrites it.
        await startResolve(u.id, u.email ?? null);
      }
      setLoading(false);
      bootedRef.current = true;
      setBooted(true);
      window.clearTimeout(bootTimeout);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!bootedRef.current && event === "INITIAL_SESSION") return;

      if (event === "SIGNED_OUT") {
        setUid(null);
        setUserEmail(null);
        _setActiveOrgId(null);
        setActiveRole(null);
        setRoles([]);
        setMember(null);
        setMembershipState("resolving");
        setWorkspaceRelocation(null);
        setLoading(false);
        // The device workspace must not outlive the account that stored it —
        // the next identity on this browser would inherit it as its first
        // resolution candidate (IDENT-4). The next sign-in of the SAME
        // account restores its workspace from users.default_org_id.
        // (preferMicrosoft is deliberately NOT cleared here: expiry-driven
        // sign-outs also emit SIGNED_OUT, and the silent-SSO flag must
        // survive those — explicit sign-out buttons clear it themselves.)
        clearStoredOrgId();
        // Status snapshots persist in localStorage for instant paints —
        // they must not outlive the account that fetched them. OFF-8: the
        // same for every rebuildable cache the account read and its held
        // state (CLIENT_STORAGE_INVENTORY, class "account", kinds "cache"
        // and "held" — the hub, graph and library snapshots, dismissals) in
        // localStorage AND sessionStorage. The person's own work and
        // arrangement (kind "identity" — the arranged graph layout, the
        // palette's recents, the open ask thread, the redline hand-off
        // waiting for its request, and the remembered identity) survive, as
        // they did before IS-P1: an expiry-driven SIGNED_OUT looks exactly
        // like this one, and the same person signing back in comes back to
        // them. A DIFFERENT identity ends them before it reads anything
        // (noteIdentity, LAST_IDENTITY_KEY). The sign-in flow's own keys
        // (the silent-SSO flags, the post-sign-in destination) survive, as
        // an expiry-driven SIGNED_OUT needs them; device preferences stay.
        await purgeAccountClientStores("signout");
        // The same principle for Cache Storage (OFF-8): every cache the
        // service worker filled on this device is deleted BEFORE the
        // redirect, whichever way the session ended — a sign-out button
        // (which has already posted SIGN_OUT), a token that could not be
        // refreshed, or a sign-out in another tab. The next sign-in re-warms
        // the offline shell. Bounded, so a wedged CacheStorage can never hold
        // the sign-out; no Cache Storage (plain HTTP) means nothing cached.
        try {
          if (typeof caches !== "undefined") {
            const purge = caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n))));
            await Promise.race([purge, new Promise((done) => window.setTimeout(done, 1500))]);
          }
        } catch { /* nothing to purge */ }
        window.location.replace("/");
        return;
      }

      // TOKEN_REFRESHED and USER_UPDATED are silent background events that fire
      // whenever Supabase rotates the access token (every ~hour, or when the tab
      // wakes from dormancy). They MUST NOT flip `loading` to true, or the whole
      // app gets stuck on the "Authenticating..." spinner every time you leave
      // and return to the tab.
      if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
        if (session?.user) {
          const u = session.user;
          const uidChanged = uidRef.current !== u.id;
          if (uidChanged) await noteIdentity(u.id);
          setUid(u.id);
          setUserEmail(u.email ?? null);
          // A refresh can be the FIRST event that establishes an identity:
          // boot's getSession can come back sessionless when an expired
          // token can't refresh on a flaky network, and the auto-refresh
          // ticker then succeeds seconds later. Without a resolve here the
          // layout's resolving screen would wait on nothing, forever.
          // Ordinary hourly refreshes skip this — membership is already
          // resolved and the uid unchanged.
          if ((uidChanged || membershipStateRef.current === "resolving") && !resolveInFlightRef.current) {
            void startResolve(u.id, u.email ?? null);
          }
        }
        return;
      }

      if (session?.user) {
        const u = session.user;
        // Read the identity BEFORE anything awaits: uidRef follows `uid`
        // through an effect, so once an await yields, React may commit a
        // setUid and run that effect — a user switch would then read as a
        // re-emit of the same user and never resolve the new one's
        // membership (the previous identity's role, org and member row
        // would stay on screen for the new one — IS-P1 review blocker).
        const isSameUser = uidRef.current === u.id;
        if (event === "SIGNED_IN") {
          // OFF-8: a different identity than the last one seen in this
          // browser or this tab ends that identity's account data first —
          // before anything of this one's is set, as the boot path does (a
          // switch in another tab, or a sign-in after a session
          // evaporated).
          await noteIdentity(u.id);
        }
        setUid(u.id);
        setUserEmail(u.email ?? null);
        // SIGNED_IN re-fires on tab return, on token refresh, and any time
        // Supabase re-detects an existing session — not only on a fresh
        // password login. If the user id hasn't changed, this is just a
        // re-emit and there is nothing to refetch. Blocking the UI here
        // (the previous behavior) was the cause of the "stuck on
        // Authenticating…" loop when the tab went background → foreground.
        if (event === "SIGNED_IN") {
          if (!isSameUser) {
            // Actual user switch (rare). Resolve their org/role under the
            // shared budget (SESS-2) so a slow query can't lock the UI. On
            // exhaustion, land on the honest "error" state — the old code
            // "proceeded", which meant rendering whatever placeholder was
            // in the context at the time.
            setLoading(true);
            try {
              await startResolve(u.id, u.email ?? null);
            } finally {
              setLoading(false);
            }
          } else if (membershipStateRef.current === "resolving" && !resolveInFlightRef.current) {
            // Same user, but membership never resolved and nothing is in
            // flight (boot saw no session; this re-emit is the rescue).
            void startResolve(u.id, u.email ?? null);
          }
        }
      } else {
        // Session evaporated without a SIGNED_OUT (edge events). The device
        // workspace key is left in place deliberately — the same account
        // re-establishing its session keeps its instant restore, and a
        // DIFFERENT account is protected by the owner check in
        // readStoredOrgIdFor (IDENT-4).
        setUid(null);
        setUserEmail(null);
        _setActiveOrgId(null);
        setActiveRole(null);
        setRoles([]);
        setMember(null);
        setWorkspaceRelocation(null);
        setLoading(false);
        // OFF-8: an INITIAL_SESSION with no session is not a sign-out. It
        // reaches here for every tab that boots without a usable session —
        // a new tab of a "keep me signed in"-off user whose first tab is
        // still signed in, a tablet booting offline while auth-js retries an
        // expired token it still keeps — so nothing is cleared unless THIS
        // tab had an identity AND supabase-js keeps no session in
        // localStorage or in this tab's sessionStorage. Then only the
        // rebuildable account caches go (kind "cache"); held state (the
        // dismissals) goes at the next SIGNED_OUT, and the person's own work
        // (kind "identity" — an unsubmitted redline hand-off, an open ask
        // thread, the arranged graph layout, the recents) when a DIFFERENT
        // identity next runs the app here (noteIdentity, LAST_IDENTITY_KEY).
        // Cache Storage is left alone: the service worker's identity check
        // purges it when a different identity's SESSION is announced
        // (XEDGE-6), and emptying it here would take the offline shell from
        // a tablet whose session is merely waiting on the network.
        if (lastIdentityRef.current !== null && !supabaseSessionPersisted([browserStore("local"), browserStore("session")])) {
          await purgeAccountClientStores("cache");
        }
      }
    });

    // When tab becomes visible again after being dormant, verify the session
    // is still valid. If the token expired and couldn't refresh, kick to login.
    const handleVisibility = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session && bootedRef.current) {
          window.location.replace("/");
        }
      } catch {
        // Network hiccup — don't kick the user; let the next event handle it.
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      subscription.unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<RoleContextValue>(
    () => ({
      loading,
      booted,
      activeRole,
      roles,
      hasRole: (r: Role) => roles.includes(r),
      hasAnyRole: (rs: Role[]) => rs.some((r) => roles.includes(r)),
      userEmail,
      uid,
      activeOrgId,
      setActiveOrgId,
      member,
      membershipState,
      workspaceRelocation,
      acknowledgeWorkspaceRelocation,
    }),
    [loading, booted, activeRole, roles, userEmail, uid, activeOrgId, member, membershipState, workspaceRelocation, acknowledgeWorkspaceRelocation, setActiveOrgId]
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within RoleProvider");
  return ctx;
}
