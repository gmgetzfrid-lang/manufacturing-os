"use client";

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Role } from "@/types/schema";
import { normalizeRoles, primaryRole } from "@/lib/roleCapabilities";

type OrgMember = {
  orgId: string;
  uid: string;
  role: Role;     // headline — highest-ranked of `roles`
  roles: Role[];  // additive collection
  status: "active" | "invited" | "suspended" | "inactive";
  email?: string;
};

type MembershipState = "resolving" | "member" | "none" | "error";

type RoleContextValue = {
  loading: boolean;
  activeRole: Role;
  /** Full additive role collection for the active org. `activeRole` is the
   *  headline (highest-ranked) of these. */
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
};

const RoleContext = createContext<RoleContextValue | null>(null);

const LS_ORG_KEY = "manufacturingos.activeOrgId";

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
    try {
      const v = window.localStorage.getItem(LS_ORG_KEY);
      if (v) _setActiveOrgId((cur) => cur ?? v);
    } catch { /* private mode — boot resolves the org from the profile */ }
  }, []);
  const [activeRole, setActiveRole] = useState<Role>("Viewer");
  const [roles, setRoles] = useState<Role[]>([]);
  const [member, setMember] = useState<OrgMember | null>(null);
  const [membershipState, setMembershipState] = useState<MembershipState>("resolving");
  const bootedRef = useRef(false);
  // Track the *current* uid in a ref so the auth-state callback (which
  // captures the initial closure) can detect "this SIGNED_IN is just a
  // re-emit of the same user" without blocking the UI on every tab return.
  const uidRef = useRef<string | null>(null);

  // Keep uidRef in sync so the auth-state subscription (which only closes
  // over the initial value) can check identity changes.
  useEffect(() => { uidRef.current = uid; }, [uid]);

  // Watchdog: never let `loading` stay true forever. Whenever loading flips
  // to true post-boot, give it 6 seconds to resolve; after that, force it
  // false so the user is never staring at a blank "Authenticating…" spinner.
  // Auth-gated queries still work — they'll surface their own errors.
  useEffect(() => {
    if (!loading) return;
    const t = window.setTimeout(() => {
      console.warn("[RoleContext] loading watchdog tripped — force-clearing spinner");
      setLoading(false);
    }, 6000);
    return () => window.clearTimeout(t);
  }, [loading]);

  const persistOrgId = useCallback(async (nextOrgId: string | null, nextUid: string) => {
    try {
      if (typeof window !== "undefined") {
        if (nextOrgId) localStorage.setItem(LS_ORG_KEY, nextOrgId);
        else localStorage.removeItem(LS_ORG_KEY);
      }
    } catch {}

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
    // Always write localStorage immediately so a refresh restores the workspace,
    // even if uid hasn't propagated yet (which would skip the DB upsert).
    try {
      if (typeof window !== "undefined") {
        if (orgId) localStorage.setItem(LS_ORG_KEY, orgId);
        else localStorage.removeItem(LS_ORG_KEY);
      }
    } catch {}
    if (uid) await persistOrgId(orgId, uid);
  }, [uid, persistOrgId]);

  const resolveOrgAndRole = async (userId: string, email: string | null) => {
    setMembershipState("resolving");

    // Every query THROWS on error so the retry loop below can tell "the
    // lookup failed" apart from "this account truly has no membership". The
    // old code swallowed errors and answered Viewer for both — on a flaky
    // phone connection that dressed an Admin up as a locked-out stranger.
    const attempt = async (): Promise<{ orgId: string | null; mem: Record<string, unknown> | null }> => {
      // 1) Candidate org: this device's last workspace → profile default.
      let orgId: string | null = null;
      try {
        if (typeof window !== "undefined") orgId = localStorage.getItem(LS_ORG_KEY);
      } catch {}
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
      //    workspace, revoked access, fresh phone) → their first active
      //    membership anywhere wins instead of a dead end.
      if (!mem || mem.status !== "active") {
        const { data, error } = await supabase
          .from("org_members").select("*")
          .eq("uid", userId).eq("status", "active")
          .limit(1).maybeSingle();
        if (error) throw new Error(error.message);
        if (data) {
          mem = data as Record<string, unknown>;
          orgId = mem.org_id as string;
        }
      }
      return { orgId, mem };
    };

    let resolved: { orgId: string | null; mem: Record<string, unknown> | null } | null = null;
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
      setMember(null);
      setRoles([]);
      setActiveRole("Viewer");
      setMembershipState("error");
      return;
    }

    const { orgId, mem } = resolved;
    _setActiveOrgId(orgId);
    if (orgId) {
      try {
        if (typeof window !== "undefined") localStorage.setItem(LS_ORG_KEY, orgId);
      } catch {}
    }

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
      if (active) void persistOrgId(orgId, userId);
    } else {
      setMember(null);
      setRoles([]);
      setActiveRole("Viewer");
      setMembershipState("none");
    }

    // Upsert user profile
    try {
      await supabase.from("users").upsert({
        id: userId,
        email: email ?? null,
        updated_at: new Date().toISOString(),
      });
    } catch {}
  };

  useEffect(() => {
    // Safety: never let "Authenticating..." spin forever. If boot stalls past
    // 8 seconds (slow network, stuck supabase call), drop the spinner and let
    // the rest of the app render — auth-gated queries will either work or
    // redirect on their own.
    const bootTimeout = window.setTimeout(() => {
      setLoading(false);
      bootedRef.current = true;
    }, 8000);

    // Get initial session
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user) {
        const u = session.user;
        setUid(u.id);
        setUserEmail(u.email ?? null);
        await resolveOrgAndRole(u.id, u.email ?? null);
      }
      setLoading(false);
      bootedRef.current = true;
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
        setLoading(false);
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
          setUid(session.user.id);
          setUserEmail(session.user.email ?? null);
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
            // Actual user switch (rare). Resolve their org/role, with a
            // hard timeout so a slow query can't lock the UI.
            // Bumped from 5s → 15s — Supabase cold-start on the
            // free/shared tier can spend 5-10s on the first
            // RLS-gated query of a session. The timeout is a
            // safety net, not a normal-case constraint.
            setLoading(true);
            try {
              await Promise.race([
                resolveOrgAndRole(u.id, u.email ?? null),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("resolveOrgAndRole timeout")), 15000)
                ),
              ]);
            } catch (err) {
              console.warn("[RoleContext] role resolve timed out — proceeding", err);
            } finally {
              setLoading(false);
            }
          }
        }
      } else {
        setUid(null);
        setUserEmail(null);
        _setActiveOrgId(null);
        setActiveRole("Viewer");
        setRoles([]);
        setMember(null);
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
    }),
    [loading, activeRole, roles, userEmail, uid, activeOrgId, member, membershipState, setActiveOrgId]
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within RoleProvider");
  return ctx;
}
