// "use client";

// import React, { useEffect, useMemo, useState } from "react";
// import Link from "next/link";
// import { useRouter } from "next/navigation";
// import { collection, getDocs, orderBy, query } from "firebase/firestore";
// import { db } from "@/lib/firebase";
// import { useRole } from "@/components/providers/RoleContext";
// import { LibraryConfig, Role } from "@/types/schema";
// import {
//   Shield,
//   Search,
//   Library,
//   ArrowRight,
//   Lock,
//   Eye,
//   Settings,
//   RefreshCw,
//   AlertTriangle,
// } from "lucide-react";

// type UiLibrary = LibraryConfig & {
//   _id: string; // defensive alias for id
//   _canRead: boolean;
//   _isPublicRead: boolean;
// };

// const isControllerRole = (role: Role) => role === "Admin" || role === "DocCtrl";

// const toArrayRole = (v: any): Role[] => (Array.isArray(v) ? (v as Role[]) : []);

// const safeLower = (v: any) => (typeof v === "string" ? v.toLowerCase() : "");

// function computeCanRead(lib: Partial<LibraryConfig>, role: Role) {
//   const readAccess = (lib as any).readAccess;
//   if (readAccess === "ALL") return true;

//   const readList = toArrayRole(readAccess);
//   const visibleTo = toArrayRole((lib as any).visibleTo);

//   // Most permissive model: if either list includes the role, allow read.
//   return readList.includes(role) || visibleTo.includes(role);
// }

// function computeIsPublicRead(lib: Partial<LibraryConfig>) {
//   return (lib as any).readAccess === "ALL";
// }

// export default function DocumentsHomePage() {
//   const router = useRouter();
//   const { activeRole, userEmail } = useRole();

//   const [loading, setLoading] = useState(true);
//   const [refreshing, setRefreshing] = useState(false);
//   const [error, setError] = useState<string | null>(null);

//   const [libraries, setLibraries] = useState<UiLibrary[]>([]);
//   const [search, setSearch] = useState("");

//   const isController = isControllerRole(activeRole);

//   const fetchLibraries = async (opts?: { silent?: boolean }) => {
//     if (!opts?.silent) setLoading(true);
//     setError(null);

//     try {
//       const q = query(collection(db, "libraries"), orderBy("createdAt", "desc"));
//       const snap = await getDocs(q);

//       const libs = snap.docs.map((d) => {
//         const data = d.data() as any;

//         // Defensive normalization for older/partial library docs
//         const normalized: Partial<LibraryConfig> = {
//           id: d.id,
//           name: data?.name ?? "Untitled Library",
//           description: data?.description ?? "",
//           type: data?.type ?? "Engineering",
//           customColumns: Array.isArray(data?.customColumns) ? data.customColumns : [],
//           writeAccess: toArrayRole(data?.writeAccess),
//           adminAccess: toArrayRole(data?.adminAccess),
//           readAccess: data?.readAccess ?? "ALL",
//           visibleTo: toArrayRole(data?.visibleTo),
//           enableCheckOut: Boolean(data?.enableCheckOut),
//           enableTraining: Boolean(data?.enableTraining),
//           folderSecurity: data?.folderSecurity ?? "Inherited",
//         };

//         const _canRead = computeCanRead(normalized, activeRole);
//         const _isPublicRead = computeIsPublicRead(normalized);

//         return {
//           ...(normalized as LibraryConfig),
//           _id: d.id,
//           _canRead,
//           _isPublicRead,
//         } as UiLibrary;
//       });

//       // Controllers can see everything. Everyone else only sees what they can read.
//       const visible = isController ? libs : libs.filter((l) => l._canRead);

//       setLibraries(visible);
//     } catch (e: any) {
//       console.error("DocumentsHomePage: failed to load libraries", e);
//       setError("Failed to load libraries. Check Firestore permissions and console errors.");
//     } finally {
//       if (!opts?.silent) setLoading(false);
//     }
//   };

//   useEffect(() => {
//     // If your protected layout guarantees auth, this is just a safety net.
//     if (!userEmail) return;
//     fetchLibraries();
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [userEmail, activeRole]);

//   const filtered = useMemo(() => {
//     const q = search.trim().toLowerCase();
//     if (!q) return libraries;

//     return libraries.filter((l) => {
//       const hay = `${safeLower(l.name)} ${safeLower(l.description)} ${safeLower(l.type)}`;
//       return hay.includes(q);
//     });
//   }, [libraries, search]);

//   const EmptyState = () => (
//     <div className="rounded-2xl border border-slate-200 bg-white p-10 shadow-sm">
//       <div className="flex items-start gap-4">
//         <div className="h-12 w-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow">
//           <Library className="h-6 w-6" />
//         </div>

//         <div className="flex-1">
//           <h2 className="text-xl font-bold text-slate-900">No libraries available</h2>
//           <p className="text-sm text-slate-600 mt-1">
//             {isController
//               ? "There are no libraries configured yet. Create your first library in the Library Admin panel."
//               : "You don't currently have access to any controlled libraries. Contact Doc Control or an Admin to grant access."}
//           </p>

//           <div className="mt-6 flex flex-wrap gap-3">
//             {isController ? (
//               <Link
//                 href="/admin/libraries"
//                 className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white shadow hover:bg-slate-800 transition"
//               >
//                 <Settings className="h-4 w-4" />
//                 Open Library Admin
//                 <ArrowRight className="h-4 w-4" />
//               </Link>
//             ) : (
//               <div className="inline-flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-2 text-sm font-bold text-amber-800 border border-amber-200">
//                 <AlertTriangle className="h-4 w-4" />
//                 Access is controlled by DocCtrl/Admin only.
//               </div>
//             )}

//             <button
//               onClick={async () => {
//                 setRefreshing(true);
//                 await fetchLibraries({ silent: true });
//                 setRefreshing(false);
//               }}
//               className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-800 shadow-sm hover:bg-slate-50 transition disabled:opacity-50"
//               disabled={refreshing}
//             >
//               <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
//               Refresh
//             </button>
//           </div>
//         </div>
//       </div>
//     </div>
//   );

//   if (!userEmail) {
//     // If this route is truly protected by your layout, you can delete this block.
//     return (
//       <div className="p-8">
//         <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
//           <h1 className="text-xl font-bold text-slate-900">Not signed in</h1>
//           <p className="text-sm text-slate-600 mt-1">Please sign in to access Document Control.</p>
//           <button
//             onClick={() => router.push("/")}
//             className="mt-6 inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white shadow hover:bg-slate-800 transition"
//           >
//             Go to Login <ArrowRight className="h-4 w-4" />
//           </button>
//         </div>
//       </div>
//     );
//   }

//   return (
//     <div className="p-6 md:p-8">
//       {/* Header */}
//       <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
//         <div>
//           <div className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-3 py-1 text-xs font-bold text-white shadow">
//             <Shield className="h-4 w-4" />
//             Document Control
//           </div>

//           <h1 className="mt-3 text-3xl font-extrabold text-slate-900 tracking-tight">
//             Controlled Libraries
//           </h1>
//           <p className="mt-1 text-sm text-slate-600 max-w-2xl">
//             Single source of truth for issued documents. Library structure changes are restricted to{" "}
//             <span className="font-semibold text-slate-800">DocCtrl/Admin</span>.
//           </p>
//         </div>

//         <div className="flex flex-wrap items-center gap-3">
//           {isController && (
//             <Link
//               href="/admin/libraries"
//               className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white shadow hover:bg-slate-800 transition"
//             >
//               <Settings className="h-4 w-4" />
//               Library Admin
//             </Link>
//           )}

//           <button
//             onClick={async () => {
//               setRefreshing(true);
//               await fetchLibraries({ silent: true });
//               setRefreshing(false);
//             }}
//             className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-800 shadow-sm hover:bg-slate-50 transition disabled:opacity-50"
//             disabled={refreshing}
//           >
//             <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
//             Refresh
//           </button>
//         </div>
//       </div>

//       {/* Search */}
//       <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
//         <div className="flex items-center gap-3">
//           <div className="h-10 w-10 rounded-xl bg-slate-100 flex items-center justify-center">
//             <Search className="h-5 w-5 text-slate-500" />
//           </div>
//           <div className="flex-1">
//             <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">
//               Search libraries
//             </label>
//             <input
//               value={search}
//               onChange={(e) => setSearch(e.target.value)}
//               placeholder="Type a name, description, or type..."
//               className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-orange-500/30 focus:border-orange-500 transition"
//             />
//           </div>
//         </div>
//       </div>

//       {/* Errors */}
//       {error && (
//         <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700 flex items-center gap-2">
//           <AlertTriangle className="h-4 w-4" />
//           {error}
//         </div>
//       )}

//       {/* Loading */}
//       {loading ? (
//         <div className="mt-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
//           {Array.from({ length: 6 }).map((_, i) => (
//             <div
//               key={i}
//               className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm animate-pulse"
//             >
//               <div className="h-10 w-10 rounded-2xl bg-slate-100" />
//               <div className="mt-4 h-4 w-2/3 rounded bg-slate-100" />
//               <div className="mt-2 h-3 w-full rounded bg-slate-100" />
//               <div className="mt-2 h-3 w-5/6 rounded bg-slate-100" />
//               <div className="mt-4 h-8 w-32 rounded-xl bg-slate-100" />
//             </div>
//           ))}
//         </div>
//       ) : filtered.length === 0 ? (
//         <div className="mt-6">
//           <EmptyState />
//         </div>
//       ) : (
//         <div className="mt-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
//           {filtered.map((lib) => (
//             <Link
//               key={lib._id}
//               href={`/documents/${lib._id}`}
//               className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:shadow-md hover:border-slate-300 transition"
//             >
//               <div className="flex items-start justify-between gap-4">
//                 <div className="h-12 w-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow group-hover:scale-105 transition">
//                   <Library className="h-6 w-6" />
//                 </div>

//                 <div className="flex items-center gap-2">
//                   {lib._isPublicRead ? (
//                     <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-extrabold text-emerald-700">
//                       <Eye className="h-3.5 w-3.5" />
//                       Public Read
//                     </span>
//                   ) : (
//                     <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-extrabold text-slate-700">
//                       <Lock className="h-3.5 w-3.5" />
//                       Restricted
//                     </span>
//                   )}
//                 </div>
//               </div>

//               <div className="mt-4">
//                 <h3 className="text-lg font-extrabold text-slate-900 group-hover:text-slate-950 transition line-clamp-1">
//                   {lib.name}
//                 </h3>
//                 <p className="mt-1 text-sm text-slate-600 line-clamp-2">
//                   {lib.description || "No description provided."}
//                 </p>
//               </div>

//               <div className="mt-4 flex items-center justify-between">
//                 <div className="inline-flex items-center gap-2 rounded-xl bg-slate-50 border border-slate-200 px-3 py-1.5">
//                   <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">
//                     Type
//                   </span>
//                   <span className="text-xs font-extrabold text-slate-800">{lib.type}</span>
//                 </div>

//                 <div className="inline-flex items-center gap-2 text-sm font-extrabold text-slate-900">
//                   Open
//                   <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition" />
//                 </div>
//               </div>
//             </Link>
//           ))}
//         </div>
//       )}
//     </div>
//   );
// }


"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useRole } from "@/components/providers/RoleContext";
import { LibraryConfig, Role } from "@/types/schema";
import {
  Library,
  Search,
  ArrowRight,
  Settings,
  RefreshCw,
  AlertTriangle,
  Shield,
  Eye,
  Lock,
} from "lucide-react";

type UiLibrary = LibraryConfig & {
  _id: string;
  _canRead: boolean;
  _isPublicRead: boolean;
};

const isControllerRole = (role: Role) => role === "Admin" || role === "DocCtrl";
const toArrayRole = (v: unknown): Role[] => (Array.isArray(v) ? (v as Role[]) : []);
const safeLower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");

function computeCanRead(lib: Partial<LibraryConfig>, role: Role) {
  const readAccess = (lib as { readAccess?: Role[] | "ALL" }).readAccess;
  if (readAccess === "ALL") return true;

  const readList = toArrayRole(readAccess);
  const visibleTo = toArrayRole((lib as { visibleTo?: unknown }).visibleTo);

  return readList.includes(role) || visibleTo.includes(role);
}

function computeIsPublicRead(lib: Partial<LibraryConfig>) {
  return (lib as { readAccess?: Role[] | "ALL" }).readAccess === "ALL";
}

export default function DocumentsHomePage() {
  const router = useRouter();
  const { activeRole, userEmail, activeOrgId } = useRole();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [libraries, setLibraries] = useState<UiLibrary[]>([]);
  const [search, setSearch] = useState("");

  const isController = isControllerRole(activeRole);

  const fetchLibraries = async (opts?: { silent?: boolean }) => {
    if (!activeOrgId) {
      setLibraries([]);
      setLoading(false);
      return;
    }

    if (!opts?.silent) setLoading(true);
    setError(null);

    try {
      const q = query(
        collection(db, "libraries"),
        where("orgId", "==", activeOrgId),
        orderBy("createdAt", "desc")
      );
      const snap = await getDocs(q);

      const libs = snap.docs.map((d) => {
        const data = d.data() as Record<string, unknown>;

        const normalized: Partial<LibraryConfig> = {
          id: d.id,
          orgId: (data?.orgId as string) ?? activeOrgId ?? "",
          name: (data?.name as string) ?? "Untitled Library",
          description: (data?.description as string) ?? "",
          type: (data?.type as any) ?? "Engineering",
          customColumns: Array.isArray(data?.customColumns) ? data.customColumns : [],
          writeAccess: toArrayRole(data?.writeAccess),
          adminAccess: toArrayRole(data?.adminAccess),
          readAccess: (data?.readAccess as any) ?? "ALL",
          visibleTo: toArrayRole(data?.visibleTo),

          folderSecurity: (data?.folderSecurity as any) ?? "Inherited",
        };

        const _canRead = computeCanRead(normalized, activeRole);
        const _isPublicRead = computeIsPublicRead(normalized);

        return {
          ...(normalized as LibraryConfig),
          _id: d.id,
          _canRead,
          _isPublicRead,
        } as UiLibrary;
      });

      const visible = isController ? libs : libs.filter((l) => l._canRead);
      setLibraries(visible);
    } catch (e: unknown) {
      console.error("DocumentsHomePage: failed to load libraries", e);
      setError("Failed to load libraries. Check Firestore permissions and console errors.");
      setLibraries([]);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (!userEmail) return;
    fetchLibraries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEmail, activeRole, activeOrgId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return libraries;

    return libraries.filter((l) => {
      const hay = `${safeLower(l.name)} ${safeLower(l.description)} ${safeLower(l.type)}`;
      return hay.includes(q);
    });
  }, [libraries, search]);

  if (!activeOrgId) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="max-w-3xl mx-auto bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow">
              <Shield className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-black text-slate-900">Workspace not selected</h2>
              <p className="text-sm text-slate-600 mt-2">
                Please select a workspace from the sidebar to view your documents and libraries.
              </p>
              <p className="text-xs text-slate-500 mt-3">
                Your access is determined by your membership in the selected organization.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const EmptyState = () => (
    <div className="rounded-2xl border border-slate-200 bg-white p-10 shadow-sm">
      <div className="flex items-start gap-4">
        <div className="h-12 w-12 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow">
          <Library className="h-6 w-6" />
        </div>

        <div className="flex-1">
          <h2 className="text-xl font-bold text-slate-900">No libraries available</h2>
          <p className="text-sm text-slate-600 mt-1">
            {isController
              ? "There are no libraries configured yet. Create your first library in the Library Admin panel."
              : "You don't currently have access to any controlled libraries. Contact Doc Control or an Admin to grant access."}
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            {isController ? (
              <Link
                href="/admin/libraries"
                className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-bold text-white shadow hover:bg-slate-800 transition"
              >
                <Settings className="h-4 w-4" />
                Open Library Admin
                <ArrowRight className="h-4 w-4" />
              </Link>
            ) : (
              <div className="inline-flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-2 text-sm font-bold text-amber-800 border border-amber-200">
                <AlertTriangle className="h-4 w-4" />
                Access is controlled by DocCtrl/Admin only.
              </div>
            )}
          </div>

          <div className="mt-6 text-[11px] text-slate-400 font-mono">
            orgId: <span className="text-slate-600">{activeOrgId}</span>
          </div>
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 p-10">
        <div className="max-w-6xl mx-auto text-slate-600">Loading libraries...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-20">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-black text-slate-900 tracking-tight">Document Control</h1>
            <p className="text-sm text-slate-600 mt-1">
              Secure libraries scoped to org: <span className="font-mono">{activeOrgId}</span>
            </p>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search libraries..."
                className="pl-9 pr-4 py-2 rounded-xl border border-slate-200 bg-white shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 w-72"
              />
            </div>

            <button
              onClick={async () => {
                setRefreshing(true);
                await fetchLibraries({ silent: true });
                setRefreshing(false);
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-slate-200 shadow-sm hover:bg-slate-50 font-bold text-sm"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <div className="flex items-center gap-2 font-bold">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </div>
            <div className="mt-2 text-xs text-red-700 font-mono bg-red-100 p-2 rounded">
              Debugging Info:
              <br />
              Org ID: {activeOrgId}
              <br />
              User Email: {userEmail}
              <br />
              <span className="font-bold">Tip:</span> Ensure your user document in 
              `orgs/{activeOrgId}/members/{'{uid}'}` has the field `status: "active"`.
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filtered.map((lib) => (
              <button
                key={lib._id}
                onClick={() => router.push(`/documents/${lib._id}`)}
                className="text-left bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md transition"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-lg font-black text-slate-900 truncate">{lib.name}</div>
                    <div className="text-sm text-slate-600 mt-1 line-clamp-2">{lib.description}</div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      {lib._isPublicRead ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                          <Eye className="w-3 h-3" /> Public Read
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200">
                          <Lock className="w-3 h-3" /> Controlled
                        </span>
                      )}
                      {!lib._canRead && !isController && (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200">
                          <AlertTriangle className="w-3 h-3" /> No Access
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 inline-flex items-center gap-2 text-slate-900 font-black">
                    Open <ArrowRight className="w-4 h-4" />
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
