"use client";

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Role } from "@/types/schema";

type OrgMember = {
  orgId: string;
  uid: string;
  role: Role;
  status: "active" | "invited" | "suspended" | "inactive";
  email?: string;
};

type RoleContextValue = {
  loading: boolean;
  activeRole: Role;
  userEmail: string | null;
  uid: string | null;
  activeOrgId: string | null;
  setActiveOrgId: (orgId: string | null) => Promise<void>;
  member: OrgMember | null;
};

const RoleContext = createContext<RoleContextValue | null>(null);

const LS_ORG_KEY = "manufacturingos.activeOrgId";

function normalizeRole(v: unknown): Role {
  if (typeof v !== "string") return "Viewer";
  return v as Role;
}

export function RoleProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [uid, setUid] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [activeOrgId, _setActiveOrgId] = useState<string | null>(null);
  const [activeRole, setActiveRole] = useState<Role>("Viewer");
  const [member, setMember] = useState<OrgMember | null>(null);
  const bootedRef = useRef(false);

  const persistOrgId = async (nextOrgId: string | null, nextUid: string) => {
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
  };

  const setActiveOrgId = async (orgId: string | null) => {
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
  };

  const resolveOrgAndRole = async (userId: string, email: string | null) => {
    // 1) Determine org: localStorage → user profile → first active membership
    let orgId: string | null = null;

    try {
      if (typeof window !== "undefined") {
        orgId = localStorage.getItem(LS_ORG_KEY);
      }
    } catch {}

    if (!orgId) {
      const { data: profile } = await supabase
        .from("users")
        .select("default_org_id")
        .eq("id", userId)
        .maybeSingle();

      if (profile?.default_org_id) {
        orgId = profile.default_org_id as string;
      } else {
        const { data: memberships } = await supabase
          .from("org_members")
          .select("org_id")
          .eq("uid", userId)
          .eq("status", "active")
          .limit(1)
          .maybeSingle();

        if (memberships?.org_id) {
          orgId = memberships.org_id as string;
          await persistOrgId(orgId, userId);
        }
      }
    }

    _setActiveOrgId(orgId);

    // Always persist whichever orgId we resolved, so subsequent refreshes
    // skip the DB lookup and don't risk falling back to a different workspace.
    if (orgId) {
      try {
        if (typeof window !== "undefined") {
          localStorage.setItem(LS_ORG_KEY, orgId);
        }
      } catch {}
    }

    // 2) Resolve role for this org
    if (orgId) {
      const { data: mem } = await supabase
        .from("org_members")
        .select("*")
        .eq("org_id", orgId)
        .eq("uid", userId)
        .maybeSingle();

      if (mem) {
        const nextMember: OrgMember = {
          orgId: mem.org_id as string,
          uid: userId,
          role: normalizeRole(mem.role),
          status: (mem.status ?? "inactive") as OrgMember["status"],
          email: (mem.email as string | undefined) ?? email ?? undefined,
        };
        setMember(nextMember);
        setActiveRole(nextMember.status === "active" ? nextMember.role : "Viewer");
      } else {
        setMember(null);
        setActiveRole("Viewer");
      }
    } else {
      setMember(null);
      setActiveRole("Viewer");
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
        setMember(null);
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
        // Only block the UI when actually signing in fresh.
        if (event === "SIGNED_IN") {
          setLoading(true);
          try {
            await resolveOrgAndRole(u.id, u.email ?? null);
          } finally {
            setLoading(false);
          }
        }
      } else {
        setUid(null);
        setUserEmail(null);
        _setActiveOrgId(null);
        setActiveRole("Viewer");
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
    () => ({ loading, activeRole, userEmail, uid, activeOrgId, setActiveOrgId, member }),
    [loading, activeRole, userEmail, uid, activeOrgId, member]
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within RoleProvider");
  return ctx;
}
