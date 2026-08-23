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
  /** ⚠ Placeholder until `membershipState === "member"`. The literal
   *  "Viewer" here means "not known yet", not "is a Viewer" — the protected
   *  layout guarantees the app shell never renders during resolution
   *  (SESS-1), but code that runs OUTSIDE the gated shell (providers, the
   *  notification center) must check `membershipState` before acting on
   *  role state. Making this `Role | null` at the type level is tracked as
   *  SESS-6 in the identity-and-session audit. */
  activeRole: Role;
  /** Full additive role collection for the active org. `activeRole` is the
   *  headline (highest-ranked) of these. Same placeholder caveat: `[]`
   *  until `membershipState === "member"`. */
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
  const [activeRole, setActiveRole] = useState<Role>("Viewer");
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
      setActiveRole("Viewer");
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
      };
      const active = nextMember.status === "active";
      setMember(nextMember);
      setRoles(active ? collection : []);
      setActiveRole(active ? headline : "Viewer");
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
      setActiveRole("Viewer");
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
        setActiveRole("Viewer");
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
        // they must not outlive the account that fetched them.
        try {
          const doomed: string[] = [];
          for (let i = 0; i < window.localStorage.length; i++) {
            const k = window.localStorage.key(i);
            if (k && (k.startsWith("intel-status-") || k.startsWith("schema-gaps-"))) doomed.push(k);
          }
          doomed.forEach((k) => window.localStorage.removeItem(k));
        } catch { /* private mode */ }
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
        setUid(u.id);
        setUserEmail(u.email ?? null);
        // SIGNED_IN re-fires on tab return, on token refresh, and any time
        // Supabase re-detects an existing session — not only on a fresh
        // password login. If the user id hasn't changed, this is just a
        // re-emit and there is nothing to refetch. Blocking the UI here
        // (the previous behavior) was the cause of the "stuck on
        // Authenticating…" loop when the tab went background → foreground.
        if (event === "SIGNED_IN") {
          const isSameUser = uidRef.current === u.id;
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
        setActiveRole("Viewer");
        setRoles([]);
        setMember(null);
        setWorkspaceRelocation(null);
        setLoading(false);
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
