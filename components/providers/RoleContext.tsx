// 'use client';

// import React, {
//   createContext,
//   useCallback,
//   useContext,
//   useEffect,
//   useMemo,
//   useState,
// } from 'react';
// import { usePathname } from 'next/navigation';
// import { onAuthStateChanged, type User } from 'firebase/auth';
// import { doc, getDoc, onSnapshot, type Unsubscribe } from 'firebase/firestore';
// import { auth, db } from '@/lib/firebase';

// /**
//  * RoleContext is the foundation for:
//  * - Multi-tenant subscription model (individual + enterprise orgs)
//  * - Role-based admin controls (Admin / DocCtrl)
//  *
//  * Data model supported (new, multi-tenant):
//  *   /tenants/{tenantId}/users/{uid} => { role, status, displayName, email, ... }
//  *
//  * Backward compatible (legacy/single-tenant):
//  *   /users/{uid} => { role, ... }
//  */

// export type AppRole =
//   | 'Admin'
//   | 'DocCtrl'
//   | 'Manager'
//   | 'Supervisor'
//   | 'Viewer'
//   | string;

// type RoleContextValue = {
//   user: User | null;
//   uid: string | null;
//   email: string | null;
//   displayName: string | null;

//   /** Active tenant/org workspace the user is operating in */
//   activeTenantId: string | null;

//   /** Role *within* the active tenant (or legacy /users role fallback) */
//   role: AppRole | null;

//   loading: boolean;

//   isAdmin: boolean;
//   isController: boolean;

//   /** Switch active tenant (persisted to localStorage). */
//   setActiveTenantId: (tenantId: string) => void;

//   /** Force re-fetch of role/membership (useful after invites or admin edits). */
//   refresh: () => Promise<void>;
// };

// const RoleContext = createContext<RoleContextValue | undefined>(undefined);

// function getTenantIdFromPathname(pathname: string | null): string | null {
//   if (!pathname) return null;

//   // Convention: routes are optionally scoped like:
//   //   /t/<tenantId>/...
//   // If you haven't added tenant-scoped routes yet, this will just return null.
//   const parts = pathname.split('/').filter(Boolean);
//   if (parts.length >= 2 && parts[0] === 't') return parts[1];

//   return null;
// }

// async function readRoleForUser(params: {
//   uid: string;
//   tenantId: string | null;
// }): Promise<{
//   role: AppRole | null;
//   displayName: string | null;
//   email: string | null;
// }> {
//   const { uid, tenantId } = params;

//   // Prefer tenant-scoped profile if tenantId is available.
//   if (tenantId) {
//     const tenantUserRef = doc(db, 'tenants', tenantId, 'users', uid);
//     const tenantSnap = await getDoc(tenantUserRef);
//     if (tenantSnap.exists()) {
//       const data = tenantSnap.data() as any;
//       return {
//         role: (data?.role ?? null) as AppRole | null,
//         displayName: (data?.displayName ?? null) as string | null,
//         email: (data?.email ?? null) as string | null,
//       };
//     }
//   }

//   // Legacy fallback: single global users collection.
//   const legacyRef = doc(db, 'users', uid);
//   const legacySnap = await getDoc(legacyRef);
//   if (legacySnap.exists()) {
//     const data = legacySnap.data() as any;
//     return {
//       role: (data?.role ?? null) as AppRole | null,
//       displayName: (data?.displayName ?? null) as string | null,
//       email: (data?.email ?? null) as string | null,
//     };
//   }

//   // Safe default for missing profile
//   return { role: 'Viewer', displayName: null, email: null };
// }

// export function RoleProvider({ children }: { children: React.ReactNode }) {
//   const pathname = usePathname();

//   const [user, setUser] = useState<User | null>(null);
//   const [uid, setUid] = useState<string | null>(null);
//   const [email, setEmail] = useState<string | null>(null);

//   const [displayName, setDisplayName] = useState<string | null>(null);
//   const [activeTenantId, _setActiveTenantId] = useState<string | null>(null);
//   const [role, setRole] = useState<AppRole | null>(null);
//   const [loading, setLoading] = useState(true);

//   const setActiveTenantId = useCallback((tenantId: string) => {
//     _setActiveTenantId(tenantId);
//     try {
//       localStorage.setItem('refineryos.activeTenantId', tenantId);
//     } catch {
//       // ignore
//     }
//   }, []);

//   // Initial tenant selection: URL -> localStorage -> null
//   useEffect(() => {
//     const fromPath = getTenantIdFromPathname(pathname);
//     if (fromPath) {
//       _setActiveTenantId(fromPath);
//       return;
//     }

//     try {
//       const stored = localStorage.getItem('refineryos.activeTenantId');
//       if (stored) _setActiveTenantId(stored);
//     } catch {
//       // ignore
//     }
//   }, [pathname]);

//   const refresh = useCallback(async () => {
//     if (!uid) return;
//     setLoading(true);
//     try {
//       const profile = await readRoleForUser({ uid, tenantId: activeTenantId });
//       setRole(profile.role ?? 'Viewer');
//       if (profile.displayName) setDisplayName(profile.displayName);
//       if (profile.email) setEmail(profile.email);
//     } finally {
//       setLoading(false);
//     }
//   }, [uid, activeTenantId]);

//   // Auth listener
//   useEffect(() => {
//     const unsub = onAuthStateChanged(auth, async (u) => {
//       setUser(u);
//       setUid(u?.uid ?? null);
//       setEmail(u?.email ?? null);
//       setDisplayName(u?.displayName ?? null);

//       if (!u) {
//         setRole(null);
//         setLoading(false);
//         return;
//       }

//       // fetch role once immediately
//       setLoading(true);
//       try {
//         const profile = await readRoleForUser({
//           uid: u.uid,
//           tenantId: activeTenantId,
//         });
//         setRole(profile.role ?? 'Viewer');
//         if (profile.displayName) setDisplayName(profile.displayName);
//         if (profile.email) setEmail(profile.email);
//       } finally {
//         setLoading(false);
//       }
//     });

//     return () => unsub();
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [activeTenantId]);

//   // Live updates for role changes (admin edits)
//   useEffect(() => {
//     let unsub: Unsubscribe | null = null;

//     if (!uid) return;

//     // Prefer tenant-scoped membership if we have a tenant id.
//     if (activeTenantId) {
//       unsub = onSnapshot(
//         doc(db, 'tenants', activeTenantId, 'users', uid),
//         (snap) => {
//           if (!snap.exists()) return;
//           const data = snap.data() as any;
//           if (data?.role) setRole(data.role as AppRole);
//           if (typeof data?.displayName === 'string')
//             setDisplayName(data.displayName);
//           if (typeof data?.email === 'string') setEmail(data.email);
//         },
//         () => {
//           // ignore snapshot errors here; refresh() can be used to diagnose
//         }
//       );
//     } else {
//       // Legacy fallback
//       unsub = onSnapshot(
//         doc(db, 'users', uid),
//         (snap) => {
//           if (!snap.exists()) return;
//           const data = snap.data() as any;
//           if (data?.role) setRole(data.role as AppRole);
//           if (typeof data?.displayName === 'string')
//             setDisplayName(data.displayName);
//           if (typeof data?.email === 'string') setEmail(data.email);
//         },
//         () => {
//           // ignore
//         }
//       );
//     }

//     return () => {
//       if (unsub) unsub();
//     };
//   }, [uid, activeTenantId]);

//   const isAdmin = role === 'Admin';
//   const isController = role === 'Admin' || role === 'DocCtrl';

//   const value = useMemo<RoleContextValue>(
//     () => ({
//       user,
//       uid,
//       email,
//       displayName,
//       activeTenantId,
//       role,
//       loading,
//       isAdmin,
//       isController,
//       setActiveTenantId,
//       refresh,
//     }),
//     [
//       user,
//       uid,
//       email,
//       displayName,
//       activeTenantId,
//       role,
//       loading,
//       isAdmin,
//       isController,
//       setActiveTenantId,
//       refresh,
//     ]
//   );

//   return (
//     <RoleContext.Provider value={value}>{children}</RoleContext.Provider>
//   );
// }

// export function useRole() {
//   const ctx = useContext(RoleContext);
//   if (!ctx) throw new Error('useRole must be used within a RoleProvider');
//   return ctx;
// }


"use client";

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "@/lib/firebase";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import type { Timestamp, Role } from "@/types/schema";

type OrgMember = {
  orgId: string;
  uid: string;
  role: Role;
  status: "active" | "invited" | "suspended" | "inactive";
  email?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
};

type RoleContextValue = {
  loading: boolean;

  // What the rest of your app already expects
  activeRole: Role;
  userEmail: string | null;
  uid: string | null;

  // Org scope (the missing pillar)
  activeOrgId: string | null;
  setActiveOrgId: (orgId: string | null) => Promise<void>;

  // Raw membership (useful later for billing/seats/admin UI)
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
    } catch { }

    // store a pointer on the user profile (self-managed rules allow it)
    try {
      const userRef = doc(db, "users", nextUid);
      await setDoc(
        userRef,
        {
          uid: nextUid,
          email: userEmail ?? undefined,
          defaultOrgId: nextOrgId ?? null,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch {
      // non-fatal
    }
  };

  const setActiveOrgId = async (orgId: string | null) => {
    if (!uid) {
      _setActiveOrgId(orgId);
      return;
    }
    _setActiveOrgId(orgId);
    await persistOrgId(orgId, uid);
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setLoading(true);

      if (!user) {
        setUid(null);
        setUserEmail(null);
        _setActiveOrgId(null);
        setActiveRole("Viewer");
        setMember(null);
        setLoading(false);
        return;
      }

      setUid(user.uid);
      setUserEmail(user.email ?? null);

      // 1) Determine org scope:
      //    Prefer: localStorage -> fallback: /users/{uid}.defaultOrgId
      let orgId: string | null = null;

      try {
        if (typeof window !== "undefined") {
          orgId = localStorage.getItem(LS_ORG_KEY);
        }
      } catch { }

      if (!orgId) {
        try {
          // 1. Try finding default in user profile
          const userSnap = await getDoc(doc(db, "users", user.uid));
          if (userSnap.exists()) {
            const data = userSnap.data() as Record<string, unknown>;
            if (typeof data?.defaultOrgId === "string" && data.defaultOrgId.trim()) {
              orgId = data.defaultOrgId.trim();
            }
          }

          // 2. If still no org, find the FIRST active membership
          if (!orgId) {
             const { collectionGroup, query, where, getDocs, limit } = await import("firebase/firestore");
             const memQuery = query(
               collectionGroup(db, 'members'),
               where('uid', '==', user.uid),
               where('status', '==', 'active'),
               limit(1)
             );
             const memSnap = await getDocs(memQuery);
             if (!memSnap.empty) {
               const data = memSnap.docs[0].data();
               if (data.orgId) {
                 orgId = data.orgId;
                 // Persist this auto-discovery so next load is faster
                 await persistOrgId(orgId, user.uid);
               }
             }
          }
        } catch { }
      }

      _setActiveOrgId(orgId);

      // 2) Resolve membership role if orgId exists
      if (orgId) {
        try {
          const memRef = doc(db, "orgs", orgId, "members", user.uid);
          const memSnap = await getDoc(memRef);

          if (memSnap.exists()) {
            const data = memSnap.data() as Record<string, unknown>;
            const nextMember: OrgMember = {
              orgId,
              uid: user.uid,
              role: normalizeRole(data?.role),
              status: (data?.status ?? "inactive") as OrgMember["status"],
              email: (data?.email as string | undefined) ?? user.email ?? undefined,
              createdAt: data?.createdAt as Timestamp | undefined,
              updatedAt: data?.updatedAt as Timestamp | undefined,
            };
            setMember(nextMember);

            // only treat active members as “real roles”
            if (nextMember.status === "active") {
              setActiveRole(nextMember.role);
            } else {
              setActiveRole("Viewer");
            }
          } else {
            // Not a member of this org (yet) -> locked down
            setMember(null);
            setActiveRole("Viewer");
          }
        } catch {
          setMember(null);
          setActiveRole("Viewer");
        }
      } else {
        // No org chosen yet -> locked down
        setMember(null);
        setActiveRole("Viewer");
      }

      // ensure profile exists
      try {
        const userRef = doc(db, "users", user.uid);
        await setDoc(
          userRef,
          {
            uid: user.uid,
            email: user.email ?? null,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } catch { }

      setLoading(false);
      bootedRef.current = true;
    });

    return () => unsub();
  }, [userEmail]);

  const value = useMemo<RoleContextValue>(
    () => ({
      loading,
      activeRole,
      userEmail,
      uid,
      activeOrgId,
      setActiveOrgId,
      member,
    }),
    [loading, activeRole, userEmail, uid, activeOrgId, setActiveOrgId, member]
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole() {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error("useRole must be used within RoleProvider");
  return ctx;
}
