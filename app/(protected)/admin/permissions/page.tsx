"use client";

// /admin/permissions — visual matrix of role × library × action.
//
// Each library carries readAccess / writeAccess / adminAccess role
// lists (jsonb on the libraries row). This page renders the matrix
// in one grid so an admin can scan "who can do what across every
// library" at a glance instead of opening each library config.
//
// Click a cell to toggle that role's access for that library + action.
// Updates upsert the library row directly.

import React, { useCallback, useEffect, useState } from "react";
import {
  Shield, Loader2, AlertTriangle, RefreshCw, Check, X, Eye, Edit3, Settings,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import type { Role } from "@/types/schema";

const ALL_ROLES: Role[] = [
  "Admin", "DocCtrl", "Manager", "Supervisor", "DraftingSupervisor",
  "Engineer-1", "Engineer-2", "Engineer-3", "Engineer-4",
  "Requester", "Drafter", "Accounting", "Safety", "HR", "Maintenance", "Viewer",
];
const ADMIN_ROLES = new Set(["Admin", "DocCtrl"]);

type AccessKind = "read" | "write" | "admin";

interface LibraryRow {
  id: string;
  name: string;
  read_access: Role[] | "ALL" | null;
  write_access: Role[] | null;
  admin_access: Role[] | null;
}

export default function PermissionsMatrixPage() {
  const { activeRole, activeOrgId, userEmail } = useRole();
  const canEdit = !!activeRole && ADMIN_ROLES.has(activeRole);
  const [libs, setLibs] = useState<LibraryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingCell, setSavingCell] = useState<string | null>(null); // "<lib>:<role>:<kind>"

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true); setError(null);
    try {
      const { data } = await supabase
        .from("libraries")
        .select("id, name, read_access, write_access, admin_access")
        .eq("org_id", activeOrgId)
        .order("name");
      setLibs((data ?? []) as LibraryRow[]);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [activeOrgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const hasAccess = (lib: LibraryRow, role: Role, kind: AccessKind): boolean => {
    if (kind === "read") {
      if (lib.read_access === "ALL") return true;
      return Array.isArray(lib.read_access) && lib.read_access.includes(role);
    }
    if (kind === "write") return Array.isArray(lib.write_access) && lib.write_access.includes(role);
    if (kind === "admin") return Array.isArray(lib.admin_access) && lib.admin_access.includes(role);
    return false;
  };

  const toggle = async (lib: LibraryRow, role: Role, kind: AccessKind) => {
    if (!canEdit) return;
    const cellKey = `${lib.id}:${role}:${kind}`;
    setSavingCell(cellKey);
    try {
      const field: keyof LibraryRow = kind === "read" ? "read_access" : kind === "write" ? "write_access" : "admin_access";
      const current = lib[field];
      const list: Role[] = Array.isArray(current) ? current as Role[] : [];
      const on = list.includes(role);
      const nextList = on ? list.filter((r) => r !== role) : [...list, role];
      const patch: Record<string, unknown> = { [field as string]: nextList };
      await supabase.from("libraries").update(patch).eq("id", lib.id);
      setLibs((prev) => prev.map((l) => l.id === lib.id ? { ...l, [field]: nextList } : l));
    } catch (e) {
      alert((e as Error).message);
    } finally { setSavingCell(null); }
  };

  if (!canEdit) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="max-w-3xl mx-auto bg-white rounded-2xl border border-slate-200 p-6 shadow-sm flex items-start gap-3">
          <Shield className="w-6 h-6 text-slate-500 shrink-0" />
          <div>
            <h1 className="text-xl font-black text-slate-900">Permissions Matrix</h1>
            <p className="text-sm text-slate-600 mt-1">Admin-class only. Ask your workspace admin if you need access.</p>
            <div className="text-xs text-slate-400 mt-2">{userEmail} ({activeRole})</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      <div className="max-w-7xl mx-auto p-6">
        <div className="flex items-end justify-between mb-6 gap-4">
          <div>
            <h1 className="text-2xl font-black text-slate-900 inline-flex items-center gap-3">
              <Shield className="w-6 h-6 text-slate-500" /> Permissions Matrix
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Every library × every role × read / write / admin. Click a cell to toggle. Edits write to <code className="text-[10px] bg-slate-100 px-1 rounded">libraries.read_access</code> / <code className="text-[10px] bg-slate-100 px-1 rounded">write_access</code> / <code className="text-[10px] bg-slate-100 px-1 rounded">admin_access</code>.
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 shadow-sm hover:bg-slate-50 text-xs font-bold text-slate-700"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {loading && libs.length === 0 ? (
          <div className="py-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        ) : libs.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center text-sm italic text-slate-500">
            No libraries yet. Create one from Library Config.
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
                <tr>
                  <th className="text-left px-4 py-3 sticky left-0 bg-slate-50 z-10">
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Library</span>
                  </th>
                  {ALL_ROLES.map((r) => (
                    <th key={r} colSpan={3} className="text-center px-2 py-3 border-l border-slate-200">
                      <div className="text-[10px] font-black text-slate-700 uppercase tracking-widest">{r}</div>
                      <div className="mt-1 flex items-center justify-center gap-3 text-[9px] text-slate-400">
                        <span title="Read"><Eye className="w-2.5 h-2.5" /></span>
                        <span title="Write"><Edit3 className="w-2.5 h-2.5" /></span>
                        <span title="Admin"><Settings className="w-2.5 h-2.5" /></span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {libs.map((lib) => (
                  <tr key={lib.id} className="hover:bg-slate-50/40">
                    <td className="px-4 py-2 sticky left-0 bg-white">
                      <div className="text-sm font-bold text-slate-900 truncate">{lib.name}</div>
                      {lib.read_access === "ALL" && (
                        <div className="text-[9px] font-bold text-emerald-700 mt-0.5">Public read</div>
                      )}
                    </td>
                    {ALL_ROLES.map((role) => (
                      <React.Fragment key={role}>
                        {(["read", "write", "admin"] as AccessKind[]).map((kind) => (
                          <Cell
                            key={kind}
                            on={hasAccess(lib, role, kind)}
                            disabled={savingCell !== null}
                            saving={savingCell === `${lib.id}:${role}:${kind}`}
                            onClick={() => toggle(lib, role, kind)}
                          />
                        ))}
                      </React.Fragment>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Legend */}
        <div className="mt-4 text-[10px] text-slate-500 flex items-center gap-4">
          <span className="inline-flex items-center gap-1"><Eye className="w-3 h-3" /> Read</span>
          <span className="inline-flex items-center gap-1"><Edit3 className="w-3 h-3" /> Write (upload, create, edit)</span>
          <span className="inline-flex items-center gap-1"><Settings className="w-3 h-3" /> Admin (config + permissions)</span>
        </div>
      </div>
    </div>
  );
}

function Cell({ on, disabled, saving, onClick }: { on: boolean; disabled: boolean; saving: boolean; onClick: () => void }) {
  return (
    <td className="text-center px-1 py-1 border-l border-slate-100">
      <button
        onClick={onClick}
        disabled={disabled}
        className={`w-5 h-5 inline-flex items-center justify-center rounded transition-colors ${
          on
            ? "bg-emerald-500 hover:bg-emerald-600 text-white"
            : "bg-slate-100 hover:bg-slate-200 text-slate-300"
        } disabled:opacity-40`}
      >
        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : on ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
      </button>
    </td>
  );
}
