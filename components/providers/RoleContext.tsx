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
        .single();

      if (profile?.default_org_id) {
        orgId = profile.default_org_id as string;
      } else {
        const { data: memberships } = await supabase
          .from("org_members")
          .select("org_id")
          .eq("uid", userId)
          .eq("status", "active")
          .limit(1)
          .single();

        if (memberships?.org_id) {
          orgId = memberships.org_id as string;
          await persistOrgId(orgId, userId);
        }
      }
    }

    _setActiveOrgId(orgId);

    // 2) Resolve role for this org
    if (orgId) {
      const { data: mem } = await supabase
        .from("org_members")
        .select("*")
        .eq("org_id", orgId)
        .eq("uid", userId)
        .single();

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
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!bootedRef.current && event === "INITIAL_SESSION") return;

      if (session?.user) {
        const u = session.user;
        setUid(u.id);
        setUserEmail(u.email ?? null);
        setLoading(true);
        await resolveOrgAndRole(u.id, u.email ?? null);
        setLoading(false);
      } else {
        setUid(null);
        setUserEmail(null);
        _setActiveOrgId(null);
        setActiveRole("Viewer");
        setMember(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
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
