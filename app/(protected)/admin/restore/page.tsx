"use client";

// /admin/restore — bring a workspace back from a backup, end to end.
//
//   1. Drop a backup — the Full ZIP (records + binaries) or the JSON export.
//      Parsed IN THE BROWSER; the plan below is computed locally, zero writes.
//   2. Review the plan — user reconciliation by email, org-name collision,
//      exactly which tables import.
//   3. Restore records — chunked through /api/admin/restore/begin +
//      /apply-table so any size of backup fits under request limits.
//   4. Put files back (ZIP only) — re-uploads the ZIP's /files payload to
//      storage under the (org-remapped) original keys, skipping files that
//      are already present and ones that belong to offline space archives.

import React, { useCallback, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, UploadCloud, Loader2, AlertTriangle, Users, UserCheck, UserPlus,
  Building2, FileWarning, Database, ShieldAlert, CheckCircle2, FolderArchive,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { appConfirm } from "@/components/providers/DialogProvider";
import {
  planRestore, orderTablesForRestore, remapOrgPath,
  type RestorePlan, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";

type ZipLike = {
  files: Record<string, { dir: boolean }>;
  file(path: string): { async(type: "string"): Promise<string>; async(type: "blob"): Promise<Blob> } | null;
};

interface ApplyProgress {
  phase: "idle" | "begin" | "tables" | "done" | "error";
  currentTable?: string;
  rowsDone: number;
  rowsTotal: number;
  tablesDone: number;
  tablesTotal: number;
}
interface FilesProgress {
  running: boolean;
  done: number; total: number;
  uploaded: number; skipped: number; offline: number; failed: number;
  error?: string | null;
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", txt: "text/plain",
  csv: "text/csv", zip: "application/zip", dxf: "image/vnd.dxf", dwg: "application/acad",
  doc: "application/msword", xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const contentTypeFor = (key: string) =>
  CONTENT_TYPES[(key.toLowerCase().split(".").pop() || "")] || "application/octet-stream";

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

  // The parsed backup. Held in refs — these can be tens of MB and never need
  // to drive a render on their own.
  const envelopeRef = useRef<RestoreEnvelopeLike | null>(null);
  const zipRef = useRef<ZipLike | null>(null);
  const [fileEntryCount, setFileEntryCount] = useState(0);

  const [applyProgress, setApplyProgress] = useState<ApplyProgress>({ phase: "idle", rowsDone: 0, rowsTotal: 0, tablesDone: 0, tablesTotal: 0 });
  const [applyResult, setApplyResult] = useState<{ createdUsers: number; linkedUsers: number; totalInserted: number; failedTables: string[] } | null>(null);
  const idRemapRef = useRef<RestorePlan["idRemap"] | null>(null);

  const [filesProgress, setFilesProgress] = useState<FilesProgress>({ running: false, done: 0, total: 0, uploaded: 0, skipped: 0, offline: 0, failed: 0 });

  const authToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }, []);

  // ── 1. Read + plan (all local — nothing is written) ───────────────────────
  const handleFile = useCallback(async (file: File) => {
    if (!activeOrgId) return;
    setError(null); setPlan(null); setFileName(file.name); setApplyResult(null);
    setApplyProgress({ phase: "idle", rowsDone: 0, rowsTotal: 0, tablesDone: 0, tablesTotal: 0 });
    setFilesProgress({ running: false, done: 0, total: 0, uploaded: 0, skipped: 0, offline: 0, failed: 0 });
    envelopeRef.current = null; zipRef.current = null; setFileEntryCount(0);
    idRemapRef.current = null;

    const isZip = /\.zip$/i.test(file.name);
    const isJson = /\.json$/i.test(file.name);
    if (!isZip && !isJson) {
      setError("Drop the Full ZIP backup or the JSON export.");
      return;
    }
    setBusy(true);
    try {
      let envelope: RestoreEnvelopeLike;
      if (isZip) {
        const JSZip = (await import("jszip")).default;
        const zip = await JSZip.loadAsync(file) as unknown as ZipLike;
        const entryNames = Object.keys(zip.files);
        const manifestPath = entryNames.find((p) => /(^|\/)manifest\.json$/i.test(p));
        if (!manifestPath) throw new Error("No manifest.json — this doesn't look like a manufacturing-os backup ZIP.");
        const manifest = JSON.parse(await zip.file(manifestPath)!.async("string"));
        const tables: Record<string, unknown[]> = {};
        const tablePaths = entryNames.filter((p) => /(^|\/)tables\/[^/]+\.json$/i.test(p) && !zip.files[p].dir);
        for (const p of tablePaths) {
          const name = (p.split("/").pop() || "").replace(/\.json$/i, "");
          try { tables[name] = JSON.parse(await zip.file(p)!.async("string")) as unknown[]; }
          catch { tables[name] = []; }
        }
        envelope = { manifest, tables };
        zipRef.current = zip;
        setFileEntryCount(entryNames.filter((p) => /^\/?files\//i.test(p) && !zip.files[p].dir).length);
      } else {
        const text = await file.text();
        envelope = JSON.parse(text) as RestoreEnvelopeLike;
      }
      if (!envelope?.manifest?.orgId || !envelope?.tables) {
        throw new Error("Not a recognizable backup: missing manifest/tables.");
      }

      // Current workspace context for the local plan.
      const [{ data: orgRow }, { data: memberRows }] = await Promise.all([
        supabase.from("orgs").select("name").eq("id", activeOrgId).maybeSingle(),
        supabase.from("org_members").select("uid, email").eq("org_id", activeOrgId).eq("status", "active"),
      ]);
      const members = ((memberRows ?? []) as Array<{ uid: string; email: string | null }>)
        .filter((m) => m.email).map((m) => ({ uid: m.uid, email: m.email as string }));
      const p = planRestore(envelope, {
        orgId: activeOrgId,
        orgName: ((orgRow as { name?: string } | null)?.name ?? ""),
        members,
      });
      envelopeRef.current = envelope;
      setPlan(p);
      setKeepName("current");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [activeOrgId]);

  // ── 3. Chunked apply: begin (users) → apply-table in FK order ─────────────
  const applyRestore = async () => {
    const envelope = envelopeRef.current;
    if (!activeOrgId || !envelope || !plan) return;
    const ok = await appConfirm({
      title: "Apply restore",
      message: `Write ${fmtNum(plan.counts.totalRows)} record(s) into this workspace? ${plan.counts.newUsers} restored placeholder user(s) will be created (inactive, no seat). Existing data is kept — this is additive and can't be auto-undone.`,
      tone: "danger",
      confirmLabel: "Apply restore",
    });
    if (!ok) return;
    setError(null);
    const importable = plan.counts.tables.filter((t) => t.willImport && t.rows > 0);
    const order = orderTablesForRestore(importable.map((t) => t.name));
    const rowsTotal = importable.reduce((s, t) => s + t.rows, 0);
    setApplyProgress({ phase: "begin", rowsDone: 0, rowsTotal, tablesDone: 0, tablesTotal: order.length });
    try {
      const token = await authToken();
      const beginRes = await fetch(`/api/admin/restore/begin?orgId=${encodeURIComponent(activeOrgId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          manifest: { orgId: envelope.manifest.orgId, orgName: envelope.manifest.orgName },
          orgMembers: envelope.tables.org_members ?? [],
          orgNameChoice: keepName,
        }),
      });
      const beginBody = await beginRes.json().catch(() => null);
      if (!beginRes.ok) throw new Error(beginBody?.error || `HTTP ${beginRes.status}`);
      const idRemap = beginBody.idRemap as RestorePlan["idRemap"];
      idRemapRef.current = idRemap;

      let rowsDone = 0, tablesDone = 0, totalInserted = 0;
      const failedTables: string[] = [];
      for (const table of order) {
        const rows = (envelope.tables[table] as Array<Record<string, unknown>> | undefined) ?? [];
        setApplyProgress({ phase: "tables", currentTable: table, rowsDone, rowsTotal, tablesDone, tablesTotal: order.length });
        let tableFailed = false;
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          const res = await fetch(`/api/admin/restore/apply-table?orgId=${encodeURIComponent(activeOrgId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ table, rows: chunk, idRemap, manifest: { orgId: envelope.manifest.orgId, orgName: envelope.manifest.orgName } }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok) { tableFailed = true; break; }
          totalInserted += Number(body?.inserted ?? 0);
          rowsDone += chunk.length;
          setApplyProgress({ phase: "tables", currentTable: table, rowsDone, rowsTotal, tablesDone, tablesTotal: order.length });
        }
        if (tableFailed) failedTables.push(table);
        tablesDone++;
      }
      setApplyProgress({ phase: "done", rowsDone, rowsTotal, tablesDone, tablesTotal: order.length });
      setApplyResult({
        createdUsers: Number(beginBody.createdUsers ?? 0),
        linkedUsers: Number(beginBody.linkedUsers ?? 0),
        totalInserted,
        failedTables,
      });
    } catch (e) {
      setApplyProgress((p) => ({ ...p, phase: "error" }));
      setError((e as Error).message);
    }
  };

  // ── 4. Put files back (ZIP only) ───────────────────────────────────────────
  const putFilesBack = async () => {
    const zip = zipRef.current;
    if (!activeOrgId || !zip) return;
    const orgPairs = Object.entries(idRemapRef.current?.orgId ?? {}).filter(([o, n]) => o && n && o !== n) as Array<[string, string]>;
    const entries = Object.keys(zip.files).filter((p) => /^\/?files\//i.test(p) && !zip.files[p].dir);
    if (entries.length === 0) return;
    setFilesProgress({ running: true, done: 0, total: entries.length, uploaded: 0, skipped: 0, offline: 0, failed: 0 });
    const token = await authToken();

    const counters = { done: 0, uploaded: 0, skipped: 0, offline: 0, failed: 0 };
    const bump = () => setFilesProgress({ running: true, total: entries.length, ...counters, error: null });

    const uploadOne = async (entryPath: string) => {
      try {
        // Zip entries live under files/<storage-key>; the key must follow the
        // org remap so it lands under THIS workspace's prefix.
        const rawKey = entryPath.replace(/^\/?files\//i, "");
        const key = remapOrgPath(rawKey, orgPairs);

        // Skip what's already live; never resurrect space-archived binaries —
        // those intentionally live in their own offline zips.
        const check = await fetch(`/api/storage/resolve?path=${encodeURIComponent(key)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const state = await check.json().catch(() => null) as { archived?: boolean; archiveId?: string | null } | null;
        if (check.ok && state?.archived === false) { counters.skipped++; return; }
        if (check.ok && state?.archived === true && state?.archiveId) { counters.offline++; return; }

        const blob = await zip.file(entryPath)!.async("blob");
        const up = await fetch(`/api/storage/upload-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ path: key, contentType: contentTypeFor(key) }),
        });
        const upBody = await up.json().catch(() => null);
        if (!up.ok || !upBody?.url) throw new Error(upBody?.error || `HTTP ${up.status}`);
        const put = await fetch(upBody.url as string, { method: "PUT", body: blob, headers: { "Content-Type": contentTypeFor(key) } });
        if (!put.ok) throw new Error(`PUT ${put.status}`);
        counters.uploaded++;
      } catch {
        counters.failed++;
      } finally {
        counters.done++;
        bump();
      }
    };

    // Bounded concurrency — steady progress without hammering the presigner.
    const CONCURRENCY = 3;
    let idx = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
        while (idx < entries.length) {
          const mine = entries[idx++];
          await uploadOne(mine);
        }
      }),
    );
    setFilesProgress({ running: false, total: entries.length, ...counters });
  };

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

  const applying = applyProgress.phase === "begin" || applyProgress.phase === "tables";
  const pct = applyProgress.rowsTotal > 0 ? Math.round((applyProgress.rowsDone / applyProgress.rowsTotal) * 100) : 0;
  const filePct = filesProgress.total > 0 ? Math.round((filesProgress.done / filesProgress.total) * 100) : 0;

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
            Drop the Full ZIP (records + files) or the JSON export. Everything is planned in your browser — nothing is written until you approve.
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
        <input ref={inputRef} type="file" accept=".json,.zip,application/json,application/zip" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
        {busy ? (
          <div className="inline-flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Reading backup &amp; planning…</div>
        ) : (
          <>
            <UploadCloud className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-2" />
            <div className="text-sm font-bold text-[var(--color-text)]">{fileName ?? "Drop a backup .zip or .json here, or click to choose"}</div>
            <div className="text-[11px] text-[var(--color-text-muted)] mt-1">The Full ZIP restores records <b>and</b> can put the files back. Read locally in your browser.</div>
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
            <Stat icon={FolderArchive} tint="text-violet-600" value={fileEntryCount || plan.counts.files} label={fileEntryCount ? "files in this ZIP" : "files referenced"} />
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

          {/* Apply progress */}
          {applying && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="flex items-center gap-2 text-sm font-bold text-[var(--color-text)] mb-2">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--color-accent)]" />
                {applyProgress.phase === "begin" ? "Reconciling users…" : <>Restoring <span className="font-mono">{applyProgress.currentTable}</span> — table {Math.min(applyProgress.tablesDone + 1, applyProgress.tablesTotal)} of {applyProgress.tablesTotal}</>}
              </div>
              <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="text-[10.5px] text-[var(--color-text-muted)] mt-1">{fmtNum(applyProgress.rowsDone)} / {fmtNum(applyProgress.rowsTotal)} records ({pct}%)</div>
            </div>
          )}

          {/* Apply / result */}
          {applyResult ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="flex items-center gap-2 text-sm font-black text-emerald-900 mb-1"><CheckCircle2 className="w-4 h-4" /> Records restored</div>
              <div className="text-[11px] text-emerald-900 leading-relaxed">
                Imported <b>{fmtNum(applyResult.totalInserted)}</b> record(s) · re-linked <b>{applyResult.linkedUsers}</b> user(s) · created <b>{applyResult.createdUsers}</b> restored placeholder(s).
                {applyResult.failedTables.length > 0 && <> Some tables reported issues: <span className="font-mono">{applyResult.failedTables.join(", ")}</span> — re-run the restore (it&apos;s additive and safe) or check the audit log.</>}
                {" "}Restored users are inactive — re-invite them to grant access.
              </div>
            </div>
          ) : !applying && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="flex items-start gap-3">
                <ShieldAlert className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <div className="flex-1 text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                  <b className="text-[var(--color-text)]">Applying writes to this live workspace.</b> It&apos;s additive (existing data is kept), re-runnable, and the plan above is exactly what runs. Restored users are created inactive (no seat).{zipRef.current ? " After records import, a second step can put the ZIP's files back into storage." : " Binaries aren't in a JSON backup — use the Full ZIP to also restore files."}
                </div>
              </div>
              <div className="mt-3 flex items-center justify-end">
                <button onClick={() => void applyRestore()} disabled={plan.counts.totalRows === 0}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold text-white bg-[var(--color-accent)] hover:opacity-90 disabled:opacity-40">
                  <Database className="w-4 h-4" /> Restore {fmtNum(plan.counts.totalRows)} records
                </button>
              </div>
            </div>
          )}

          {/* Put files back (ZIP only, after records) */}
          {applyResult && fileEntryCount > 0 && (
            <div className="rounded-2xl border border-violet-200 bg-violet-50/40 p-4">
              <div className="flex items-center gap-2 text-sm font-black text-[var(--color-text)] mb-1">
                <FolderArchive className="w-4 h-4 text-violet-600" /> Put the files back
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)] mb-3 max-w-2xl">
                Re-uploads this ZIP&apos;s <b>{fmtNum(fileEntryCount)}</b> embedded file(s) to live storage under their original keys, so drawings open normally instead of prompting for an archive. Files already in storage are skipped; files that belong to offline space archives stay offline by design.
              </p>
              {filesProgress.total > 0 && (
                <div className="mb-3">
                  <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                    <div className="h-full bg-violet-500 transition-all" style={{ width: `${filePct}%` }} />
                  </div>
                  <div className="text-[10.5px] text-[var(--color-text-muted)] mt-1">
                    {fmtNum(filesProgress.done)} / {fmtNum(filesProgress.total)} · {fmtNum(filesProgress.uploaded)} uploaded · {fmtNum(filesProgress.skipped)} already present
                    {filesProgress.offline > 0 && <> · {fmtNum(filesProgress.offline)} left to space archives</>}
                    {filesProgress.failed > 0 && <span className="text-red-600 font-bold"> · {fmtNum(filesProgress.failed)} failed — run again to retry</span>}
                  </div>
                </div>
              )}
              <div className="flex items-center justify-end">
                <button onClick={() => void putFilesBack()} disabled={filesProgress.running}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-40">
                  {filesProgress.running ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
                  {filesProgress.running ? "Uploading…" : filesProgress.done > 0 ? "Run again (retries failures)" : `Put ${fmtNum(fileEntryCount)} files back`}
                </button>
              </div>
            </div>
          )}
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
