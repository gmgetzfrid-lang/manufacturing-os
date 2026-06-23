"use client";

// /admin/restore — preview a restore-from-scratch before anything is written.
//
// Drag in a backup (the JSON export) and see exactly how a returning client's
// data would merge into THIS workspace: which users re-link by email, who'd be
// created as a restored placeholder, any org-name collision to resolve, and
// every warning — all computed server-side with zero writes. Approve-then-apply
// is the deliberate next step (it mutates the live workspace), so this page
// stops at the reviewed plan.

import React, { useCallback, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, UploadCloud, Loader2, AlertTriangle, Users, UserCheck, UserPlus,
  Building2, FileWarning, Database, ShieldAlert, CheckCircle2, Info,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";

interface UserItem { oldUid: string; email: string; displayName?: string; role?: string; disposition: "linked" | "new"; newUid?: string }
interface TableItem { name: string; rows: number; willImport: boolean; reason?: string }
interface RestorePlan {
  schemaVersion?: string;
  targetOrgId: string;
  orgNameCollision: { backupName: string; currentName: string } | null;
  users: UserItem[];
  counts: { matchedUsers: number; newUsers: number; totalRows: number; files: number; tables: TableItem[] };
  warnings: string[];
}

function fmtNum(n: number) { return n >= 1000 ? n.toLocaleString() : String(n); }

export default function RestorePage() {
  const { activeOrgId, activeRole } = useRole();
  const isAdmin = activeRole === "Admin";

  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [keepName, setKeepName] = useState<"backup" | "current">("current");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!activeOrgId) return;
    setError(null); setPlan(null); setFileName(file.name);
    if (!/\.json$/i.test(file.name)) {
      setError("Upload the JSON backup (the “JSON only” download). ZIP preview arrives with the apply step.");
      return;
    }
    setBusy(true);
    try {
      const text = await file.text();
      let envelope: unknown;
      try { envelope = JSON.parse(text); } catch { throw new Error("That file isn’t valid JSON."); }
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token ?? "";
      const res = await fetch(`/api/admin/restore/preview?orgId=${encodeURIComponent(activeOrgId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(envelope),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      const p = body.plan as RestorePlan;
      setPlan(p);
      setKeepName(p.orgNameCollision ? "current" : "current");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [activeOrgId]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFile(f);
  };

  if (!isAdmin) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0" /> Restore is Admin-only — it can reshape the entire workspace.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6">
      <div className="flex items-start gap-3 mb-5">
        <Link href="/admin/storage" className="p-2 mt-1 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)] transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-black text-[var(--color-text)] flex items-center gap-2">
            <UploadCloud className="w-5 h-5 text-[var(--color-accent)]" /> Restore from backup
          </h1>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            Preview how a backup merges into this workspace — users reconcile by email, nothing is written until you approve.
          </p>
        </div>
      </div>

      {/* Dropzone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`rounded-2xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
          dragging ? "border-[var(--color-accent)] bg-[var(--color-accent)]/5" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-2)]"
        }`}
      >
        <input ref={inputRef} type="file" accept=".json,application/json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
        {busy ? (
          <div className="inline-flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Reading backup &amp; planning…</div>
        ) : (
          <>
            <UploadCloud className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-2" />
            <div className="text-sm font-bold text-[var(--color-text)]">{fileName ?? "Drop a backup .json here, or click to choose"}</div>
            <div className="text-[11px] text-[var(--color-text-muted)] mt-1">Use the “JSON only” backup from Storage &amp; Backup. It’s read in your browser; only the records (no files) are sent for planning.</div>
          </>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {plan && (
        <div className="mt-5 space-y-4">
          {/* Warnings */}
          {plan.warnings.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <div className="text-xs font-black text-amber-900 uppercase tracking-widest mb-2 flex items-center gap-1.5"><FileWarning className="w-3.5 h-3.5" /> Review before applying</div>
              <ul className="space-y-1.5">
                {plan.warnings.map((w, i) => (
                  <li key={i} className="text-[11px] text-amber-900 flex items-start gap-1.5"><span className="mt-1 w-1 h-1 rounded-full bg-amber-500 shrink-0" /> {w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Org-name collision */}
          {plan.orgNameCollision && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="text-sm font-black text-[var(--color-text)] flex items-center gap-2 mb-1"><Building2 className="w-4 h-4 text-[var(--color-accent)]" /> Which organization name should win?</div>
              <p className="text-[11px] text-[var(--color-text-muted)] mb-3">The backup and this workspace disagree. Pick the name to keep — applied at restore.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {([["current", plan.orgNameCollision.currentName, "Keep this workspace’s name"], ["backup", plan.orgNameCollision.backupName, "Use the backup’s name"]] as const).map(([val, name, hint]) => (
                  <button key={val} onClick={() => setKeepName(val)}
                    className={`text-left rounded-xl border p-3 transition-colors ${keepName === val ? "border-[var(--color-accent)] bg-[var(--color-accent)]/5" : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-3.5 h-3.5 rounded-full border-2 ${keepName === val ? "border-[var(--color-accent)] bg-[var(--color-accent)]" : "border-[var(--color-border-strong)]"}`} />
                      <span className="text-sm font-bold text-[var(--color-text)] truncate">{name}</span>
                    </div>
                    <div className="text-[10.5px] text-[var(--color-text-muted)] mt-0.5 pl-[22px]">{hint}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Summary counts */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat icon={UserCheck} tint="text-emerald-600" value={plan.counts.matchedUsers} label="users re-linked" />
            <Stat icon={UserPlus} tint="text-blue-600" value={plan.counts.newUsers} label="restored placeholders" />
            <Stat icon={Database} tint="text-[var(--color-accent)]" value={plan.counts.totalRows} label="records to import" />
            <Stat icon={UploadCloud} tint="text-violet-600" value={plan.counts.files} label="files referenced" />
          </div>

          {/* Users */}
          {plan.users.length > 0 && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[var(--color-border)] text-xs font-black text-[var(--color-text)] uppercase tracking-widest flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> User reconciliation (by email)</div>
              <div className="divide-y divide-[var(--color-border)] max-h-72 overflow-y-auto">
                {plan.users.map((u) => (
                  <div key={u.email} className="px-4 py-2 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-[var(--color-text)] truncate">{u.displayName || u.email}</div>
                      <div className="text-[10.5px] text-[var(--color-text-muted)] truncate">{u.email}{u.role ? ` · ${u.role}` : ""}</div>
                    </div>
                    {u.disposition === "linked" ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded"><UserCheck className="w-3 h-3" /> re-link</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded"><UserPlus className="w-3 h-3" /> restore + re-invite</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tables */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[var(--color-border)] text-xs font-black text-[var(--color-text)] uppercase tracking-widest flex items-center gap-1.5"><Database className="w-3.5 h-3.5" /> What would import</div>
            <div className="divide-y divide-[var(--color-border)] max-h-72 overflow-y-auto">
              {plan.counts.tables.filter((t) => t.rows > 0).map((t) => (
                <div key={t.name} className="px-4 py-1.5 flex items-center gap-3" title={t.reason}>
                  <span className="font-mono text-[11px] text-[var(--color-text)] flex-1 truncate">{t.name}</span>
                  <span className="text-[11px] text-[var(--color-text-muted)]">{fmtNum(t.rows)} rows</span>
                  {t.willImport
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    : <span className="text-[10px] text-[var(--color-text-faint)] italic shrink-0">skipped</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Apply — the deliberate, honest stopping point */}
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-4 flex items-start gap-3">
            <Info className="w-4 h-4 text-[var(--color-text-muted)] mt-0.5 shrink-0" />
            <div className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
              <b className="text-[var(--color-text)]">This is a preview — nothing has been written.</b> Applying restores records into this
              live workspace, creates restored-user placeholders, and re-uploads binaries. Because that step rewrites real data, it’s
              being finished against your database (auth/foreign-key handling) before it’s switched on here. The plan above is exactly
              what it will execute.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Icon, tint, value, label }: { icon: React.ComponentType<{ className?: string }>; tint: string; value: number; label: string }) {
  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <Icon className={`w-4 h-4 ${tint} mb-1`} />
      <div className="text-xl font-black text-[var(--color-text)]">{fmtNum(value)}</div>
      <div className="text-[10.5px] text-[var(--color-text-muted)] leading-tight">{label}</div>
    </div>
  );
}
