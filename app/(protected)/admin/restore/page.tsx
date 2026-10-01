"use client";

// /admin/restore — bring a workspace back from a backup, end to end.
//
//   1. Drop a backup — the Full ZIP part(s) (records + binaries) or the JSON
//      export. Parsed IN THE BROWSER (lib/dataRestore.ts readBackupArchive —
//      the one archive layout, plus the older data.json parts); the plan below
//      is computed locally, zero writes.
//   2. Review the plan — user reconciliation by email, org-name collision,
//      exactly which tables import.
//   3. Restore records — a read-only check first (how many backup rows
//      already exist here, how many are new), then chunked through
//      /api/admin/restore/begin + /apply-table so any size of backup fits
//      under request limits. A restore only ADDS (DEC-44 (A&O P1)): an
//      existing row is kept as it is, and the run STOPS at the first table
//      that fails (lib/dataRestore.ts runChunkedRestore).
//   4. Put files back (ZIP only) — re-uploads the /files payload of every
//      dropped part to storage under the (org-remapped) original keys,
//      skipping files that are already present and ones that belong to
//      offline space archives.

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
  planRestore, remapOrgPath, previewChunkedRestore, runChunkedRestore, readBackupArchive, RESTORE_ADDITIVE_NOTE,
  type RestorePlan, type RestoreEnvelopeLike, type RestorePost, type ChunkedRestoreResult, type ChunkedRestorePreview,
  type BackupArchiveRead,
} from "@/lib/dataRestore";

type ZipLike = {
  files: Record<string, { dir: boolean }>;
  file(path: string): { async(type: "string"): Promise<string>; async(type: "blob"): Promise<Blob> } | null;
};

interface ApplyProgress {
  phase: "idle" | "checking" | "begin" | "tables" | "done" | "error";
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
  const { activeOrgId, hasAnyRole } = useRole();
  // ADD-1: authority by the role COLLECTION, never the headline alone.
  const isAdmin = hasAnyRole(["Admin"]);

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
  // BKP-7: every dropped part, and every binary across them.
  const zipsRef = useRef<ZipLike[]>([]);
  const archiveFilesRef = useRef<BackupArchiveRead["files"]>([]);
  const [fileEntryCount, setFileEntryCount] = useState(0);

  const [applyProgress, setApplyProgress] = useState<ApplyProgress>({ phase: "idle", rowsDone: 0, rowsTotal: 0, tablesDone: 0, tablesTotal: 0 });
  const [applyResult, setApplyResult] = useState<ChunkedRestoreResult | null>(null);
  const [preview, setPreview] = useState<ChunkedRestorePreview | null>(null);
  const idRemapRef = useRef<RestorePlan["idRemap"] | null>(null);

  const [filesProgress, setFilesProgress] = useState<FilesProgress>({ running: false, done: 0, total: 0, uploaded: 0, skipped: 0, offline: 0, failed: 0 });

  const authToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }, []);

  // ── 1. Read + plan (all local — nothing is written) ───────────────────────
  const handleFiles = useCallback(async (dropped: File[]) => {
    if (!activeOrgId || dropped.length === 0) return;
    setError(null); setPlan(null); setApplyResult(null); setPreview(null);
    setFileName(dropped.length === 1 ? dropped[0].name : `${dropped.length} files: ${dropped.map((f) => f.name).join(", ")}`);
    setApplyProgress({ phase: "idle", rowsDone: 0, rowsTotal: 0, tablesDone: 0, tablesTotal: 0 });
    setFilesProgress({ running: false, done: 0, total: 0, uploaded: 0, skipped: 0, offline: 0, failed: 0 });
    envelopeRef.current = null; zipsRef.current = []; archiveFilesRef.current = []; setFileEntryCount(0);
    idRemapRef.current = null;

    const zips = dropped.filter((f) => /\.zip$/i.test(f.name));
    const jsons = dropped.filter((f) => /\.json$/i.test(f.name));
    if (zips.length + jsons.length !== dropped.length || (jsons.length > 0 && dropped.length > 1)) {
      setError("Drop the Full ZIP backup — every part of it together — or one JSON export.");
      return;
    }
    setBusy(true);
    try {
      let envelope: RestoreEnvelopeLike;
      let archiveWarnings: string[] = [];
      if (zips.length > 0) {
        const JSZip = (await import("jszip")).default;
        const loaded = await Promise.all(zips.map(async (f) => ({ name: f.name, zip: await JSZip.loadAsync(f) as unknown as ZipLike })));
        // The one archive layout (manifest.json + tables/), or an older
        // browser backup's data.json — refused with the reason otherwise.
        const read = await readBackupArchive(loaded);
        envelope = read.envelope;
        archiveWarnings = read.warnings;
        zipsRef.current = loaded.map((l) => l.zip);
        archiveFilesRef.current = read.files;
        setFileEntryCount(read.files.length);
      } else {
        const text = await jsons[0].text();
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
      setPlan({ ...p, warnings: [...archiveWarnings, ...p.warnings] });
      setKeepName("current");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [activeOrgId]);

  // ── 3. Check, confirm, then the chunked apply (begin → apply-table, FK order) ─
  const applyRestore = async () => {
    const envelope = envelopeRef.current;
    if (!activeOrgId || !envelope || !plan) return;
    setError(null);
    const token = await authToken();
    const post: RestorePost = async (path, body) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
    };
    const onProgress = (p: { phase: "checking" | "begin" | "tables"; currentTable?: string; rowsDone: number; rowsTotal: number; tablesDone: number; tablesTotal: number }) =>
      setApplyProgress({ ...p });
    try {
      // BKP-5: before anything is written, how many backup rows already exist
      // here (kept as they are) and how many would be new. Read-only.
      const check = await previewChunkedRestore({ orgId: activeOrgId, envelope, plan, post, onProgress });
      setPreview(check);
      setApplyProgress({ phase: "idle", rowsDone: 0, rowsTotal: 0, tablesDone: 0, tablesTotal: 0 });
      const ok = await appConfirm({
        title: "Apply restore",
        message:
          `Write ${fmtNum(check.wouldInsert)} new record(s) into this workspace. ` +
          (check.existing > 0
            ? `${fmtNum(check.existing)} record(s) in the backup already exist here and will be KEPT EXACTLY AS THEY ARE — not overwritten, not repaired. `
            : "") +
          `${plan.counts.newUsers} restored placeholder user(s) will be created (inactive, no seat). ${RESTORE_ADDITIVE_NOTE} This can't be auto-undone.`,
        tone: "danger",
        confirmLabel: "Apply restore",
      });
      if (!ok) return;
      const result = await runChunkedRestore({ orgId: activeOrgId, envelope, plan, orgNameChoice: keepName, post, onProgress });
      setApplyProgress((p) => ({ ...p, phase: "done" }));
      setApplyResult(result);
    } catch (e) {
      setApplyProgress((p) => ({ ...p, phase: "error" }));
      setError((e as Error).message);
    }
  };

  // ── 4. Put files back (ZIP only) ───────────────────────────────────────────
  const putFilesBack = async () => {
    const zips = zipsRef.current;
    if (!activeOrgId || zips.length === 0) return;
    const orgPairs = Object.entries(idRemapRef.current?.orgId ?? {}).filter(([o, n]) => o && n && o !== n) as Array<[string, string]>;
    // Every part's files/<storage-key> entries (BKP-7: multi-part backups).
    const entries = archiveFilesRef.current;
    if (entries.length === 0) return;
    setFilesProgress({ running: true, done: 0, total: entries.length, uploaded: 0, skipped: 0, offline: 0, failed: 0 });
    const token = await authToken();

    const counters = { done: 0, uploaded: 0, skipped: 0, offline: 0, failed: 0 };
    const bump = () => setFilesProgress({ running: true, total: entries.length, ...counters, error: null });

    const uploadOne = async (item: BackupArchiveRead["files"][number]) => {
      try {
        // Zip entries live under files/<storage-key>; the key must follow the
        // org remap so it lands under THIS workspace's prefix.
        const key = remapOrgPath(item.key, orgPairs);

        // Skip what's already live; never resurrect space-archived binaries —
        // those intentionally live in their own offline zips.
        const check = await fetch(`/api/storage/resolve?path=${encodeURIComponent(key)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const state = await check.json().catch(() => null) as { archived?: boolean; archiveId?: string | null } | null;
        if (check.ok && state?.archived === false) { counters.skipped++; return; }
        if (check.ok && state?.archived === true && state?.archiveId) { counters.offline++; return; }

        const blob = await zips[item.zip].file(item.entry)!.async("blob");
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
    const dropped = Array.from(e.dataTransfer.files ?? []);
    if (dropped.length) void handleFiles(dropped);
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

  const applying = applyProgress.phase === "checking" || applyProgress.phase === "begin" || applyProgress.phase === "tables";
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
        <input ref={inputRef} type="file" multiple accept=".json,.zip,application/json,application/zip" className="hidden"
          onChange={(e) => { const dropped = Array.from(e.target.files ?? []); if (dropped.length) void handleFiles(dropped); }} />
        {busy ? (
          <div className="inline-flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Reading backup &amp; planning…</div>
        ) : (
          <>
            <UploadCloud className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-2" />
            <div className="text-sm font-bold text-[var(--color-text)]">{fileName ?? "Drop a backup's .zip part(s) or a .json export here, or click to choose"}</div>
            <div className="text-[11px] text-[var(--color-text-muted)] mt-1">The Full ZIP restores records <b>and</b> can put the files back — drop every part together (part 1 carries the records). Read locally in your browser.</div>
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
            <Stat icon={Database} tint="text-[var(--color-accent)]" value={preview ? preview.wouldInsert : plan.counts.totalRows} label={preview ? `new records (${fmtNum(preview.existing)} already here, kept as they are)` : "records to import"} />
            <Stat icon={FolderArchive} tint="text-violet-600" value={fileEntryCount || plan.counts.files} label={fileEntryCount ? "files in the dropped part(s)" : "files referenced"} />
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
                  {t.willImport && preview?.tables[t.name] && (
                    <span className="text-[10.5px] text-[var(--color-text-muted)]">
                      {fmtNum(preview.tables[t.name].wouldInsert)} new · {fmtNum(preview.tables[t.name].existing)} already here
                    </span>
                  )}
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
                {applyProgress.phase === "checking"
                  ? <>Checking what already exists — <span className="font-mono">{applyProgress.currentTable}</span> (nothing is written)</>
                  : applyProgress.phase === "begin" ? "Reconciling users…" : <>Restoring <span className="font-mono">{applyProgress.currentTable}</span> — table {Math.min(applyProgress.tablesDone + 1, applyProgress.tablesTotal)} of {applyProgress.tablesTotal}</>}
              </div>
              <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="text-[10.5px] text-[var(--color-text-muted)] mt-1">{fmtNum(applyProgress.rowsDone)} / {fmtNum(applyProgress.rowsTotal)} records ({pct}%)</div>
            </div>
          )}

          {/* Apply / result */}
          {applyResult ? (
            <RestoreResultPanel result={applyResult} />
          ) : !applying && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="flex items-start gap-3">
                <ShieldAlert className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <div className="flex-1 text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                  <b className="text-[var(--color-text)]">Applying writes to this live workspace.</b> {RESTORE_ADDITIVE_NOTE} Before anything is written, the restore checks how many records already exist here and shows you both counts. It stops at the first table that fails. Restored users are created inactive (no seat).{zipsRef.current.length > 0 ? " After records import, a second step can put the ZIP's files back into storage." : " Binaries aren't in a JSON backup — use the Full ZIP to also restore files."}
                </div>
              </div>
              <div className="mt-3 flex items-center justify-end">
                <button onClick={() => void applyRestore()} disabled={plan.counts.totalRows === 0}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-bold text-white bg-[var(--color-accent)] hover:opacity-90 disabled:opacity-40">
                  <Database className="w-4 h-4" /> Check &amp; restore {fmtNum(plan.counts.totalRows)} records
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
                Re-uploads the <b>{fmtNum(fileEntryCount)}</b> file(s) embedded in the dropped part(s) to live storage under their original keys, so drawings open normally instead of prompting for an archive. Files already in storage are skipped; files that belong to offline space archives stay offline by design.
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

/** BKP-5: what the restore did, said plainly — never a green panel over a
 *  run that stopped, refused rows, or skipped existing ones silently. */
function RestoreResultPanel({ result }: { result: ChunkedRestoreResult }) {
  const stopped = result.stoppedAt;
  const tone = stopped
    ? "border-red-200 bg-red-50 text-red-900"
    : result.totalRefused > 0 ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900";
  const refusedByTable = result.tables.filter((t) => t.refused.length > 0);
  return (
    <div className={`rounded-2xl border p-4 ${tone}`}>
      <div className="flex items-center gap-2 text-sm font-black mb-1">
        {stopped
          ? <><AlertTriangle className="w-4 h-4" /> Restore stopped at <span className="font-mono">{stopped.table}</span> — {result.notAttempted.length} table(s) not attempted</>
          : result.totalRefused > 0
            ? <><AlertTriangle className="w-4 h-4" /> Records restored — {fmtNum(result.totalRefused)} row(s) refused</>
            : <><CheckCircle2 className="w-4 h-4" /> Records restored</>}
      </div>
      <div className="text-[11px] leading-relaxed space-y-1">
        <div>
          Imported <b>{fmtNum(result.totalInserted)}</b> new record(s) · <b>{fmtNum(result.totalExisting)}</b> already here, kept exactly as they were
          {result.totalUncounted > 0 && <> · <b>{fmtNum(result.totalUncounted)}</b> not counted by the server</>}
          {" "}· re-linked <b>{result.linkedUsers}</b> user(s) · created <b>{result.createdUsers}</b> restored placeholder(s).
        </div>
        {result.totalExisting > 0 && <div>{RESTORE_ADDITIVE_NOTE}</div>}
        {stopped && (
          <div>
            <b>Why it stopped:</b> {stopped.error}. Tables restore parents-first, so nothing after <span className="font-mono">{stopped.table}</span> was attempted
            {result.notAttempted.length > 0 && <> (<span className="font-mono">{result.notAttempted.join(", ")}</span>)</>}.
            Records already written stay. Fix the cause and run the restore again — rows already restored are skipped, not duplicated.
          </div>
        )}
        {refusedByTable.map((t) => (
          <div key={t.name}>
            <span className="font-mono">{t.name}</span>: {t.refused.length} row(s) refused —{" "}
            {Array.from(new Set(t.refused.map((r) => r.code))).join(", ")} (see the audit log&apos;s RESTORE_CHUNK rows for each id).
          </div>
        ))}
        <div>Restored users are inactive — re-invite them to grant access.</div>
      </div>
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
