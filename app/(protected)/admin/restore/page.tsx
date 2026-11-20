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
  UploadCloud, Loader2, AlertTriangle, Users, UserCheck, UserPlus,
  Building2, FileWarning, Database, ShieldAlert, CheckCircle2, FolderArchive,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { appConfirm } from "@/components/providers/DialogProvider";
import { useFileDrag } from "@/hooks/useFileDrag";
import FileThumb from "@/components/ui/FileThumb";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, StepLine, heroQuiet } from "@/components/ui/PageHero";
import { tryUpload } from "@/lib/uploadRetry";
import {
  planRestore, orderTablesForRestore, remapOrgPath,
  type RestorePlan, type RestoreEnvelopeLike,
} from "@/lib/dataRestore";
import { formatBytes } from "@/lib/formatBytes";

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

  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [keepName, setKeepName] = useState<"backup" | "current">("current");
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
  // Files that didn't go back, each with its own reason and Try again.
  const [failedFiles, setFailedFiles] = useState<Array<{ entry: string; key: string; error: string; retrying?: boolean }>>([]);

  const authToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }, []);

  // ── 1. Read + plan (all local — nothing is written) ───────────────────────
  const handleFile = useCallback(async (file: File) => {
    if (!activeOrgId) return;
    setError(null); setPlan(null); setPicked(file); setApplyResult(null); setFailedFiles([]);
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
        if (!manifestPath) throw new Error("No manifest.json. This doesn't look like a Manufacturing OS backup ZIP.");
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
      const [{ data: orgRow, error: orgErr }, { data: memberRows, error: memErr }] = await Promise.all([
        supabase.from("orgs").select("name").eq("id", activeOrgId).maybeSingle(),
        supabase.from("org_members").select("uid, email").eq("org_id", activeOrgId).eq("status", "active"),
      ]);
      if (orgErr || memErr) throw new Error(`Couldn't read this workspace's members: ${(orgErr ?? memErr)?.message}`);
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
      message: `Write ${fmtNum(plan.counts.totalRows)} record(s) into this workspace? ${plan.counts.newUsers} restored placeholder user(s) will be created (inactive, no seat). Existing data is kept. This adds records and can't be undone automatically.`,
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
            body: JSON.stringify({ table, rows: chunk, idRemap }),
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
  // One file: skip what's already live, leave space-archived ones offline,
  // else upload it to its (org-remapped) key. Safe to repeat: a second try
  // writes the same key.
  const sendFile = useCallback(async (zip: ZipLike, entryPath: string, key: string, token: string): Promise<"uploaded" | "skipped" | "offline"> => {
    const check = await fetch(`/api/storage/resolve?path=${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const state = await check.json().catch(() => null) as { archived?: boolean; archiveId?: string | null } | null;
    if (check.ok && state?.archived === false) return "skipped";
    if (check.ok && state?.archived === true && state?.archiveId) return "offline";

    const blob = await zip.file(entryPath)!.async("blob");
    const up = await fetch(`/api/storage/upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: key, contentType: contentTypeFor(key) }),
    });
    const upBody = await up.json().catch(() => null);
    if (!up.ok || !upBody?.url) throw new Error(upBody?.error || `HTTP ${up.status}`);
    const put = await fetch(upBody.url as string, { method: "PUT", body: blob, headers: { "Content-Type": contentTypeFor(key) } });
    if (!put.ok) throw new Error(`Storage said ${put.status}`);
    return "uploaded";
  }, []);

  const putFilesBack = async (only?: string[]) => {
    const zip = zipRef.current;
    if (!activeOrgId || !zip) return;
    const orgPairs = Object.entries(idRemapRef.current?.orgId ?? {}).filter(([o, n]) => o && n && o !== n) as Array<[string, string]>;
    const entries = only ?? Object.keys(zip.files).filter((p) => /^\/?files\//i.test(p) && !zip.files[p].dir);
    if (entries.length === 0) return;
    setFilesProgress({ running: true, done: 0, total: entries.length, uploaded: 0, skipped: 0, offline: 0, failed: 0 });
    if (only) setFailedFiles((prev) => prev.filter((f) => !only.includes(f.entry)));
    else setFailedFiles([]);
    const token = await authToken();

    const counters = { done: 0, uploaded: 0, skipped: 0, offline: 0, failed: 0 };
    const bump = () => setFilesProgress({ running: true, total: entries.length, ...counters, error: null });
    const failures: Array<{ entry: string; key: string; error: string }> = [];

    const uploadOne = async (entryPath: string) => {
      // Zip entries live under files/<storage-key>; the key must follow the
      // org remap so it lands under THIS workspace's prefix.
      const key = remapOrgPath(entryPath.replace(/^\/?files\//i, ""), orgPairs);
      try {
        counters[await sendFile(zip, entryPath, key, token)]++;
      } catch (e) {
        counters.failed++;
        failures.push({ entry: entryPath, key, error: (e as Error).message || "It didn't go through." });
      } finally {
        counters.done++;
        bump();
      }
    };

    // Bounded concurrency: steady progress without hammering the presigner.
    // One file failing never stops the others.
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
    setFailedFiles((prev) => [...prev, ...failures]);
  };

  // Try one file again. Wrapped so the corner card can offer Try again too.
  const retryFile = async (entry: string, key: string) => {
    const zip = zipRef.current;
    if (!zip) return;
    setFailedFiles((prev) => prev.map((f) => f.entry === entry ? { ...f, retrying: true } : f));
    const name = key.split("/").pop() || key;
    const drop = () => setFailedFiles((prev) => prev.filter((f) => f.entry !== entry));
    try {
      const token = await authToken();
      await tryUpload(name, () => sendFile(zip, entry, key, token), { onRetried: drop });
      drop();
    } catch (e) {
      setFailedFiles((prev) => prev.map((f) => f.entry === entry ? { ...f, retrying: false, error: (e as Error).message || f.error } : f));
    }
  };

  const drag = useFileDrag((files) => { if (files[0]) void handleFile(files[0]); }, busy);

  if (!isAdmin) {
    return (
      <PageShell width="form">
        <PageHero kicker="Admin · Storage · Restore" back={{ href: "/admin/storage", label: "Back to Storage" }}
          title="Admins only." size="md" overlap={false}
          sub={<span className="inline-flex items-center gap-2"><ShieldAlert className="w-4 h-4 shrink-0" /> Restore is for Admins only, since it can change the whole workspace.</span>} />
      </PageShell>
    );
  }

  const applying = applyProgress.phase === "begin" || applyProgress.phase === "tables";
  const pct = applyProgress.rowsTotal > 0 ? Math.round((applyProgress.rowsDone / applyProgress.rowsTotal) * 100) : 0;
  const filePct = filesProgress.total > 0 ? Math.round((filesProgress.done / filesProgress.total) * 100) : 0;
  const hasFiles = fileEntryCount > 0;
  const steps = hasFiles
    ? ["Pick the backup", "Check the plan", "Restore records", "Put files back"]
    : ["Pick the backup", "Check the plan", "Restore records"];
  const filesDone = !filesProgress.running && filesProgress.done > 0 && filesProgress.done === filesProgress.total && failedFiles.length === 0;
  const step = !plan ? 0 : !applyResult ? (applying ? 2 : 1) : hasFiles ? (filesDone ? 4 : 3) : 3;

  // The answer: where the restore stands.
  const answer = step === 0 ? (busy ? "Reading the backup…" : "Pick a backup to restore.")
    : step === 1 ? (plan && plan.counts.totalRows > 0 ? `${fmtNum(plan.counts.totalRows)} records ready to restore.` : "Nothing in this backup to restore.")
    : step === 2 ? `Restoring, ${pct}% done.`
    : hasFiles && !filesDone ? `Records restored. ${fmtNum(fileEntryCount)} files to put back.`
    : "Restore complete.";

  return (
    <PageShell width="form">
      <PageHero
        kicker="Admin · Storage · Restore from backup"
        back={{ href: "/admin/storage", label: "Back to Storage" }}
        size="md"
        title={answer}
        sub="The Full ZIP (records and files) or the JSON export. Nothing is written until you approve."
        tools={step === 1 ? (
          <button type="button" className={heroQuiet} onClick={() => { setPlan(null); setPicked(null); setError(null); }}>
            Start over
          </button>
        ) : undefined}
      >
        <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="min-w-[420px]">
            <StepLine onDark steps={steps.map((label, i) => ({
              label,
              state: (i < step ? "done" : i === step ? "now" : "next") as "done" | "now" | "next",
            }))} />
          </div>
        </div>
      </PageHero>

      <PageBody>
      {/* Dropzone */}
      {picked && !drag.over ? (
        <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 flex items-center gap-3" {...drag.bind}>
          <FileThumb file={picked} />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-bold text-[var(--color-text)] truncate">{picked.name}</div>
            <div className="text-[12px] text-[var(--color-text-muted)]">
              {formatBytes(picked.size)}
              {busy && <span className="inline-flex items-center gap-1 ml-2"><Loader2 className="w-3 h-3 animate-spin" /> Reading the backup and planning…</span>}
            </div>
          </div>
          {!busy && !applying && !applyResult && (
            <button type="button" onClick={() => inputRef.current?.click()}
              className="shrink-0 h-9 px-3 rounded-lg border border-[var(--color-border)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
              Pick another
            </button>
          )}
          <input ref={inputRef} type="file" accept=".json,.zip,application/json,application/zip" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ""; }} />
        </div>
      ) : (
        <div
          {...drag.bind}
          onClick={() => inputRef.current?.click()}
          className={`rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-10 text-center cursor-pointer transition-colors hover:bg-[var(--color-surface-2)] ${drag.ring}`}
        >
          <input ref={inputRef} type="file" accept=".json,.zip,application/json,application/zip" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ""; }} />
          {drag.over ? (
            <div className="text-sm font-bold text-[var(--color-text)]">{drag.say}</div>
          ) : (
            <>
              <UploadCloud className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-2" />
              <div className="text-[14px] font-bold text-[var(--color-text)]">Drop a backup .zip or .json here, or tap to choose</div>
              <div className="text-[13px] text-[var(--color-text-muted)] mt-1">Read in your browser. The Full ZIP can also put the files back.</div>
            </>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="px-1 border-l-2 border-red-500 pl-3 text-[13px] text-red-700 dark:text-red-400 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
        </p>
      )}

      {plan && (
        <>
          {/* Warnings */}
          {plan.warnings.length > 0 && (
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="text-[14px] font-bold text-amber-800 dark:text-amber-300 mb-1 flex items-center gap-1.5"><FileWarning className="w-4 h-4" /> Check before restoring</div>
              <ul className="space-y-1 list-disc ml-4">
                {plan.warnings.map((w, i) => (
                  <li key={i} className="text-[13px] text-amber-800 dark:text-amber-300">{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Org-name collision */}
          {plan.orgNameCollision && (
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="text-[14px] font-bold text-[var(--color-text)] flex items-center gap-2 mb-1"><Building2 className="w-4 h-4 text-[var(--color-text-muted)]" /> Which organization name should win?</div>
              <p className="text-[11px] text-[var(--color-text-muted)] mb-3">The backup and this workspace have different names. Pick the one to keep.</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {([["current", plan.orgNameCollision.currentName, "Keep this workspace’s name"], ["backup", plan.orgNameCollision.backupName, "Use the backup’s name"]] as const).map(([val, name, hint]) => (
                  <button key={val} type="button" aria-pressed={keepName === val} onClick={() => setKeepName(val)}
                    className={`text-left rounded-xl border p-3 transition-colors ${keepName === val ? "border-[var(--color-border-strong)] bg-[var(--color-surface-2)]" : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
                    <div className="flex items-center gap-2">
                      <span className={`w-3.5 h-3.5 rounded-full border-2 ${keepName === val ? "border-[var(--color-text)] bg-[var(--color-text)]" : "border-[var(--color-border-strong)]"}`} />
                      <span className="text-sm font-bold text-[var(--color-text)] truncate">{name}</span>
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 pl-[22px]">{hint}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* What matters, in one line. */}
          <p className="px-1 text-[14px] text-[var(--color-text)]">
            <b>{fmtNum(plan.counts.totalRows)}</b> records to import · <b>{fmtNum(plan.counts.matchedUsers)}</b> users re-linked · <b>{fmtNum(plan.counts.newUsers)}</b> restored placeholders · <b>{fmtNum(fileEntryCount || plan.counts.files)}</b> {fileEntryCount ? "files in this ZIP" : "files referenced"}
          </p>

          {/* Users */}
          {plan.users.length > 0 && (
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] overflow-hidden">
              <div className="px-4 sm:px-5 py-3 border-b border-[var(--color-border)] text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)] flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> User reconciliation (by email)</div>
              <div className="divide-y divide-[var(--color-border)] max-h-72 overflow-y-auto">
                {plan.users.map((u) => (
                  <div key={u.email} className="px-4 py-2 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-[var(--color-text)] truncate">{u.displayName || u.email}</div>
                      <div className="text-[11px] text-[var(--color-text-muted)] truncate">{u.email}{u.role ? ` · ${u.role}` : ""}</div>
                    </div>
                    {u.disposition === "linked" ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-400"><UserCheck className="w-3 h-3" /> re-link</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text-muted)]"><UserPlus className="w-3 h-3" /> restore and re-invite</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tables */}
          <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] overflow-hidden">
            <div className="px-4 sm:px-5 py-3 border-b border-[var(--color-border)] text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)] flex items-center gap-1.5"><Database className="w-3.5 h-3.5" /> What would import</div>
            <div className="divide-y divide-[var(--color-border)] max-h-72 overflow-y-auto">
              {plan.counts.tables.filter((t) => t.rows > 0).map((t) => (
                <div key={t.name} className="px-4 py-1.5 flex items-center gap-3" title={t.reason}>
                  <span className="font-mono text-[11px] text-[var(--color-text)] flex-1 truncate">{t.name}</span>
                  <span className="text-[11px] text-[var(--color-text-muted)]">{fmtNum(t.rows)} rows</span>
                  {t.willImport
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    : <span className="text-[11px] text-[var(--color-text-faint)] italic shrink-0">skipped</span>}
                </div>
              ))}
            </div>
          </div>

          {/* Apply progress */}
          {applying && (
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="flex items-center gap-2 text-[14px] font-bold text-[var(--color-text)] mb-2">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" />
                {applyProgress.phase === "begin" ? "Matching users…" : <>Restoring <span className="font-mono">{applyProgress.currentTable}</span>: table {Math.min(applyProgress.tablesDone + 1, applyProgress.tablesTotal)} of {applyProgress.tablesTotal}</>}
              </div>
              <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                <div className="h-full bg-[var(--color-text)] transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)] mt-1">{fmtNum(applyProgress.rowsDone)} / {fmtNum(applyProgress.rowsTotal)} records ({pct}%)</div>
            </div>
          )}

          {/* Apply / result */}
          {applyResult ? (
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="flex items-center gap-2 text-[14px] font-bold text-emerald-700 dark:text-emerald-400 mb-1"><CheckCircle2 className="w-4 h-4" /> Records restored</div>
              <div className="text-[13px] text-[var(--color-text)] leading-relaxed">
                Imported <b>{fmtNum(applyResult.totalInserted)}</b> record(s) · re-linked <b>{applyResult.linkedUsers}</b> user(s) · created <b>{applyResult.createdUsers}</b> restored placeholder(s).
                {" "}Restored users are inactive. <Link href="/admin/users" className="font-bold underline underline-offset-2">Re-invite them in Users</Link> to give access.
              </div>
              {applyResult.failedTables.length > 0 && (
                <p role="alert" className="mt-2 border-l-2 border-red-500 pl-2.5 text-[11px] text-red-700 dark:text-red-400">
                  These tables didn&apos;t fully import: <span className="font-mono">{applyResult.failedTables.join(", ")}</span>. Run the restore again (it only adds, so it&apos;s safe) or check the audit log.
                </p>
              )}
            </div>
          ) : !applying && (
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <ShieldAlert className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                <div className="flex-1 text-[13px] text-[var(--color-text-muted)] leading-relaxed">
                  <b className="text-[var(--color-text)]">This writes to the live workspace.</b> It only adds (existing data is kept), can be run again, and does exactly the plan above. Restored users are inactive (no seat).{zipRef.current ? " After the records, the next step can put the ZIP's files back." : " A JSON backup has no files. Use the Full ZIP to restore files too."}
                </div>
              </div>
              <div className="mt-3 flex items-center justify-end">
                <button type="button" onClick={() => void applyRestore()} disabled={plan.counts.totalRows === 0}
                  className="inline-flex items-center gap-1.5 h-11 px-5 rounded-xl text-[14px] font-extrabold shadow-[0_12px_24px_-12px_var(--color-accent)] text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40">
                  <Database className="w-4 h-4" /> Restore {fmtNum(plan.counts.totalRows)} records
                </button>
              </div>
            </div>
          )}

          {/* Put files back (ZIP only, after records) */}
          {applyResult && fileEntryCount > 0 && (
            <div className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-muted)] mb-1">
                <FolderArchive className="w-4 h-4" /> Put the files back
              </div>
              <p className="text-[13px] text-[var(--color-text-muted)] mb-3 max-w-2xl">
                Uploads this ZIP&apos;s <b>{fmtNum(fileEntryCount)}</b> file(s) back to storage under their original names, so drawings open normally. Files already there are skipped. Files in offline space archives stay offline.
              </p>
              {filesProgress.total > 0 && (
                <div className="mb-3">
                  <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                    <div className="h-full bg-[var(--color-text-muted)] transition-all" style={{ width: `${filePct}%` }} />
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)] mt-1">
                    {fmtNum(filesProgress.done)} / {fmtNum(filesProgress.total)} · {fmtNum(filesProgress.uploaded)} uploaded · {fmtNum(filesProgress.skipped)} already present
                    {filesProgress.offline > 0 && <> · {fmtNum(filesProgress.offline)} left to space archives</>}
                    {filesProgress.failed > 0 && <span className="text-red-700 dark:text-red-400 font-bold"> · {fmtNum(filesProgress.failed)} didn&apos;t upload</span>}
                  </div>
                </div>
              )}
              {failedFiles.length > 0 && !filesProgress.running && (
                <ul className="mb-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)] max-h-64 overflow-y-auto">
                  {failedFiles.slice(0, 50).map((f) => (
                    <li key={f.entry} className="px-3 py-2 flex items-center gap-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-red-600 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] font-mono font-bold text-[var(--color-text)] truncate" title={f.key}>{f.key.split("/").pop()}</span>
                        <span className="block text-[11px] text-red-700 dark:text-red-400 truncate" title={f.error}>{f.error}</span>
                      </span>
                      <button type="button" onClick={() => void retryFile(f.entry, f.key)} disabled={!!f.retrying}
                        className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md border border-[var(--color-border-strong)] text-[11px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">
                        {f.retrying ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Try again
                      </button>
                    </li>
                  ))}
                  {failedFiles.length > 50 && <li className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]">and {fmtNum(failedFiles.length - 50)} more</li>}
                </ul>
              )}
              <div className="flex items-center justify-end gap-3">
                {filesDone && (
                  <Link href="/documents" className="text-[14px] font-bold text-[var(--color-text)] underline underline-offset-2">Open Documents</Link>
                )}
                {failedFiles.length > 0 && !filesProgress.running ? (
                  <button type="button" onClick={() => void putFilesBack(failedFiles.map((f) => f.entry))}
                    className="inline-flex items-center gap-1.5 h-11 px-5 rounded-xl text-[14px] font-extrabold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]">
                    <UploadCloud className="w-4 h-4" /> Try again for {fmtNum(failedFiles.length)}
                  </button>
                ) : !filesDone && (
                  <button type="button" onClick={() => void putFilesBack()} disabled={filesProgress.running}
                    className="inline-flex items-center gap-1.5 h-11 px-5 rounded-xl text-[14px] font-extrabold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40">
                    {filesProgress.running ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
                    {filesProgress.running ? "Uploading…" : `Put ${fmtNum(fileEntryCount)} files back`}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
      </PageBody>
    </PageShell>
  );
}

