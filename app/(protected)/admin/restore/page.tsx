"use client";

// /admin/restore: bring a workspace back from a backup, end to end.
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
import { UploadCloud, Loader2, Check } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { appConfirm } from "@/components/providers/DialogProvider";
import { useFileDrag } from "@/hooks/useFileDrag";
import FileThumb from "@/components/ui/FileThumb";
import { PageShell } from "@/components/ui/PageShell";
import { btnQuiet, link, sheet, Section, StatusTag, Problem } from "@/components/admin/kit";
import { plural } from "@/components/admin/band";
import { said, responseError } from "@/components/admin/said";
import { Button } from "@/components/ui/Button";
import HelpTooltip from "@/components/ui/HelpTooltip";
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
      setError("Pick the full backup ZIP or the JSON export (a .zip or .json file).");
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
        if (!manifestPath) throw new Error("This ZIP isn't a Manufacturing OS backup: it has no manifest file.");
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
        throw new Error("This file isn't a Manufacturing OS backup: it has no manifest or tables.");
      }

      // Current workspace context for the local plan.
      const [{ data: orgRow, error: orgErr }, { data: memberRows, error: memErr }] = await Promise.all([
        supabase.from("orgs").select("name").eq("id", activeOrgId).maybeSingle(),
        supabase.from("org_members").select("uid, email").eq("org_id", activeOrgId).eq("status", "active"),
      ]);
      if (orgErr || memErr) throw orgErr ?? memErr;
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
      setError(e instanceof SyntaxError ? `${file.name} isn't a backup the app can read. Pick the full backup ZIP or the JSON export.` : said(e, `Couldn't read ${file.name}.`));
    } finally {
      setBusy(false);
    }
  }, [activeOrgId]);

  // ── 3. Chunked apply: begin (users) → apply-table in FK order ─────────────
  const applyRestore = async () => {
    const envelope = envelopeRef.current;
    if (!activeOrgId || !envelope || !plan) return;
    const ok = await appConfirm({
      title: `Restore ${fmtNum(plan.counts.totalRows)} record(s) into this workspace?`,
      message: `${plan.counts.newUsers} restored placeholder user(s) will be created (inactive, no seat). Existing data is kept. This adds records and can't be undone automatically.`,
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
      if (!beginRes.ok) throw Object.assign(new Error(beginBody?.error || "It didn't go through."), beginBody?.error ? {} : { status: beginRes.status });
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
      setError(said(e, "The restore stopped."));
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
    if (!up.ok || !upBody?.url) throw Object.assign(new Error(upBody?.error || "Storage didn't give an upload address."), upBody?.error ? {} : { status: up.status });
    const put = await fetch(upBody.url as string, { method: "PUT", body: blob, headers: { "Content-Type": contentTypeFor(key) } });
    if (!put.ok) throw await responseError(put, "Storage didn't take the file.");
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
        failures.push({ entry: entryPath, key, error: said(e) });
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
      setFailedFiles((prev) => prev.map((f) => f.entry === entry ? { ...f, retrying: false, error: said(e) } : f));
    }
  };

  const drag = useFileDrag((files) => { if (files[0]) void handleFile(files[0]); }, busy);

  if (!isAdmin) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Storage · Restore" back={{ href: "/admin/storage", label: "Back to Storage" }}
          title="Admins only." size="md"
          sub="Restore is for admins only, since it can change the whole workspace." />
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
  const finished = step >= steps.length;

  // The answer: where the restore stands.
  const answer = step === 0 ? (busy ? "Reading the backup." : "Pick a backup to restore.")
    : step === 1 ? (plan && plan.counts.totalRows > 0 ? `${fmtNum(plan.counts.totalRows)} records ready to restore.` : "Nothing in this backup to restore.")
    : step === 2 ? `Restoring, ${pct}% done.`
    : hasFiles && !filesDone ? `Records restored. ${fmtNum(fileEntryCount)} files to put back.`
    : "Restore complete.";

  return (
    <PageShell width="work">
      <PageHero
        kicker={<>Admin · Storage · Restore{!finished && <span className="text-[var(--color-text-faint)]"> · Step {Math.min(step + 1, steps.length)} of {steps.length}</span>}</>}
        back={{ href: "/admin/storage", label: "Back to Storage" }}
        title={answer}
        sub="The full backup ZIP (records and files) or the JSON export. Nothing is written until you approve."
        factsHero="none"
        facts={plan ? [
          { label: "Records", value: fmtNum(plan.counts.totalRows) },
          { label: "People re-linked", value: fmtNum(plan.counts.matchedUsers) },
          { label: fileEntryCount ? "Files in the ZIP" : "Files", value: fmtNum(fileEntryCount || plan.counts.files) },
        ] : undefined}
        tools={step === 1 ? (
          <button type="button" className={heroQuiet} onClick={() => { setPlan(null); setPicked(null); setError(null); }}>
            Start over
          </button>
        ) : undefined}
      >
        {/* On a phone the kicker says "Step 1 of 3"; the path shows from sm up. */}
        <div className="max-sm:hidden">
          <div>
            <StepLine steps={steps.map((label, i) => ({
              label,
              state: (i < step ? "done" : i === step ? "now" : "next") as "done" | "now" | "next",
            }))} />
          </div>
        </div>
      </PageHero>

      <PageBody>
      {/* Step 1: the backup. The box answers while a file is dragged over it. */}
      <input ref={inputRef} type="file" accept=".json,.zip,application/json,application/zip" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ""; }} />
      {picked && !drag.over ? (
        <div className={`${sheet} p-4 flex items-center gap-3`} {...drag.bind}>
          <FileThumb file={picked} />
          <div className="min-w-0 flex-1">
            <div className="text-reading font-medium text-[var(--color-text)] truncate">{picked.name}</div>
            <div className="text-body text-[var(--color-text-muted)]">
              {formatBytes(picked.size)}
              {busy && <span className="inline-flex items-center gap-1 ml-2"><Loader2 aria-hidden className="w-3 h-3 animate-spin" /> Reading the backup and making the plan</span>}
              {plan && !busy && <>, {plural(plan.counts.tables.filter((t) => t.rows > 0).length, "table")}</>}
            </div>
          </div>
          {!busy && !applying && !applyResult && (
            <button type="button" onClick={() => inputRef.current?.click()} className={`shrink-0 ${btnQuiet}`}>
              Pick another
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          {...drag.bind}
          onClick={() => inputRef.current?.click()}
          className={`w-full rounded-xl border-2 border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] px-6 py-10 text-center transition-colors hover:bg-[var(--color-surface-2)] ${drag.ring}`}
        >
          {drag.over ? (
            <span className="block text-reading font-medium text-[var(--color-text)]">{drag.say}</span>
          ) : (
            <>
              <UploadCloud aria-hidden className="w-6 h-6 mx-auto mb-2.5 text-[var(--color-text-faint)]" />
              <span className="block text-reading font-medium text-[var(--color-text)]">Drop a backup .zip or .json here, or choose one</span>
              <span className="block text-body text-[var(--color-text-muted)] mt-1">Read in your browser. The full backup ZIP can also put the files back.</span>
            </>
          )}
        </button>
      )}

      {error && <Problem>{error}</Problem>}

      {plan && (
        <>
          {/* Step 2: the plan, to check before anything is written. */}
          {plan.warnings.length > 0 && (
            <div className={`${sheet} p-4 sm:p-5`}>
              <StatusTag tone="warn">Check before restoring</StatusTag>
              <ul className="mt-2 space-y-1 list-disc ml-5">
                {plan.warnings.map((w, i) => (
                  <li key={i} className="text-body text-[var(--color-text)]">{w}</li>
                ))}
              </ul>
            </div>
          )}

          {plan.orgNameCollision && (
            <Section label="Which name should the workspace keep?">
              <div role="radiogroup" aria-label="Workspace name" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {([["current", plan.orgNameCollision.currentName, "This workspace's name"], ["backup", plan.orgNameCollision.backupName, "The backup's name"]] as const).map(([val, name, hint]) => (
                  <button key={val} type="button" role="radio" aria-checked={keepName === val} onClick={() => setKeepName(val)}
                    className={`text-left rounded-xl border p-3.5 transition-colors bg-[var(--color-surface)] ${keepName === val ? "border-[var(--color-text)]" : "border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
                    <span className="flex items-center gap-2.5">
                      <span aria-hidden className={`w-4 h-4 rounded-full border-2 grid place-items-center shrink-0 ${keepName === val ? "border-[var(--color-text)]" : "border-[var(--color-border-control)]"}`}>
                        {keepName === val && <span className="w-2 h-2 rounded-full bg-[var(--color-text)]" />}
                      </span>
                      <span className="text-reading font-medium text-[var(--color-text)] truncate">{name}</span>
                    </span>
                    <span className="block text-body text-[var(--color-text-muted)] mt-0.5 pl-[26px]">{hint}</span>
                  </button>
                ))}
              </div>
            </Section>
          )}

          <div className={`grid grid-cols-1 gap-x-6 gap-y-8 items-start ${plan.users.length > 0 ? "lg:grid-cols-[minmax(0,62fr)_minmax(0,38fr)]" : ""}`}>
            {plan.users.length > 0 && (
              <Section label={<>People <HelpTooltip>Matched by email. Someone already in this workspace is re-linked to their records. Anyone else comes back as an inactive placeholder with no seat; re-invite them in Users to give access.</HelpTooltip></>}
                action={<span className="text-body text-[var(--color-text-muted)] tabular-nums">{fmtNum(plan.counts.matchedUsers)} re-linked, {fmtNum(plan.counts.newUsers)} placeholders</span>}>
                <ul className={`${sheet} divide-y divide-[var(--color-border)] max-h-80 overflow-y-auto`}>
                  {plan.users.map((u) => (
                    <li key={u.email} className="px-4 py-2.5 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-body font-medium text-[var(--color-text)] truncate">{u.displayName || u.email}</div>
                        <div className="text-body text-[var(--color-text-muted)] truncate">{u.email}{u.role ? `, ${u.role}` : ""}</div>
                      </div>
                      <span className="text-body text-[var(--color-text-muted)] shrink-0">{u.disposition === "linked" ? "Re-linked" : "Placeholder"}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            <Section label="What would import">
              <div className={`${sheet} max-h-80 overflow-y-auto`}>
                <table className="w-full text-body tabular-nums">
                  <thead className="sr-only"><tr><th>Table</th><th>Rows</th><th>Imports</th></tr></thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {plan.counts.tables.filter((t) => t.rows > 0).map((t) => (
                      <tr key={t.name} title={t.reason}>
                        <td className="px-4 py-2 font-mono text-body text-[var(--color-text)] max-w-0 w-full truncate">{t.name}</td>
                        <td className="px-2 py-2 text-right text-[var(--color-text-muted)] whitespace-nowrap">{fmtNum(t.rows)}</td>
                        <td className="px-4 py-2 text-right whitespace-nowrap text-body">{t.willImport ? <span className="text-[var(--color-text)]">Imports</span> : <span className="text-[var(--color-text-faint)]">Skipped</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          </div>

          {/* Step 3: write the records, with honest progress. */}
          {applying && (
            <div className={`${sheet} p-4 sm:p-5`} aria-live="polite">
              <div className="flex items-center gap-2 text-reading font-medium text-[var(--color-text)] mb-2">
                <Loader2 aria-hidden className="w-4 h-4 animate-spin text-[var(--color-text-muted)]" />
                {applyProgress.phase === "begin" ? "Matching people" : <>Restoring <span className="font-mono text-body">{applyProgress.currentTable}</span>, table {Math.min(applyProgress.tablesDone + 1, applyProgress.tablesTotal)} of {applyProgress.tablesTotal}</>}
              </div>
              <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Records restored">
                <div className="h-full rounded-full bg-[var(--color-text)] transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%` }} />
              </div>
              <div className="text-body text-[var(--color-text-muted)] mt-1 tabular-nums">{fmtNum(applyProgress.rowsDone)} of {fmtNum(applyProgress.rowsTotal)} records ({pct}%)</div>
            </div>
          )}

          {applyResult ? (
            <div className={`${sheet} p-4 sm:p-5`}>
              <p className="flex items-center gap-2 text-reading font-medium text-[var(--color-text)]"><Check aria-hidden className="w-4 h-4 text-[var(--state-released)]" /> Records restored</p>
              <p className="mt-1 text-body text-[var(--color-text)]">
                Imported {plural(applyResult.totalInserted, "record")}, re-linked {plural(applyResult.linkedUsers, "person", "people")}, and made {plural(applyResult.createdUsers, "placeholder")}.
                {" "}Placeholders are inactive. <Link href="/admin/users" className={link}>Re-invite them in Users</Link> to give access.
              </p>
              {applyResult.failedTables.length > 0 && (
                <p role="alert" className="mt-2 text-body text-[var(--state-overdue-text)]">
                  These tables didn&apos;t fully import: <span className="font-mono">{applyResult.failedTables.join(", ")}</span>. Run the restore again (it only adds, so it&apos;s safe) or check the audit log.
                </p>
              )}
            </div>
          ) : !applying && (
            <div className={`${sheet} p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4`}>
              <p className="flex-1 text-body text-[var(--color-text-muted)]">
                <b className="font-medium text-[var(--color-text)]">This writes to the live workspace.</b> It only adds (existing data is kept), can be run again, and does exactly the plan above.{zipRef.current ? " After the records, the next step puts the ZIP's files back." : " A JSON backup has no files; use the full backup ZIP to restore files too."}
              </p>
              <div className="shrink-0 flex flex-col items-start sm:items-end gap-1">
                <Button onClick={() => void applyRestore()} disabled={plan.counts.totalRows === 0}>
                  Restore {plural(plan.counts.totalRows, "record")}
                </Button>
                {plan.counts.totalRows === 0 && <span className="text-body text-[var(--color-text-muted)]">This backup has no records to add.</span>}
              </div>
            </div>
          )}

          {/* Step 4: put files back (ZIP only, after records). */}
          {applyResult && fileEntryCount > 0 && (
            <Section label={<>Put the files back <HelpTooltip>Uploads the ZIP&apos;s files to storage under their original names, so drawings open normally. Files already there are skipped. Files in offline space archives stay offline.</HelpTooltip></>}>
              <div className={`${sheet} p-4 sm:p-5`}>
                {filesProgress.total > 0 ? (
                  <div className="mb-3" aria-live="polite">
                    <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={filePct} aria-label="Files put back">
                      <div className="h-full rounded-full bg-[var(--color-text-muted)] transition-[width] motion-reduce:transition-none" style={{ width: `${filePct}%` }} />
                    </div>
                    <div className="text-body text-[var(--color-text-muted)] mt-1 tabular-nums">
                      {fmtNum(filesProgress.done)} of {fmtNum(filesProgress.total)}: {fmtNum(filesProgress.uploaded)} uploaded, {fmtNum(filesProgress.skipped)} already there
                      {filesProgress.offline > 0 && <>, {fmtNum(filesProgress.offline)} left in space archives</>}
                      {filesProgress.failed > 0 && <span className="text-[var(--state-overdue-text)] font-medium">, {fmtNum(filesProgress.failed)} didn&apos;t upload</span>}
                    </div>
                  </div>
                ) : (
                  <p className="mb-3 text-body text-[var(--color-text-muted)]">{plural(fileEntryCount, "file")} in this ZIP.</p>
                )}
                {failedFiles.length > 0 && !filesProgress.running && (
                  <ul className="mb-3 rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] max-h-64 overflow-y-auto">
                    {failedFiles.slice(0, 50).map((f) => (
                      <li key={f.entry} className="px-3 py-2 flex items-center gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block text-body font-mono font-medium text-[var(--color-text)] truncate" title={f.key}>{f.key.split("/").pop()}</span>
                          <span className="block text-body text-[var(--state-overdue-text)] truncate">{said(f.error)}</span>
                        </span>
                        <Button size="sm" variant="secondary" loading={!!f.retrying} onClick={() => void retryFile(f.entry, f.key)}>Try again</Button>
                      </li>
                    ))}
                    {failedFiles.length > 50 && <li className="px-3 py-2 text-body text-[var(--color-text-muted)]">And {fmtNum(failedFiles.length - 50)} more</li>}
                  </ul>
                )}
                <div className="flex items-center justify-end gap-4 flex-wrap">
                  {filesDone && <Link href="/documents" className={`text-reading ${link}`}>Open Documents</Link>}
                  {failedFiles.length > 0 && !filesProgress.running ? (
                    <Button onClick={() => void putFilesBack(failedFiles.map((f) => f.entry))}>
                      Try again for {plural(failedFiles.length, "file")}
                    </Button>
                  ) : !filesDone && (
                    <Button loading={filesProgress.running} onClick={() => void putFilesBack()}>
                      {filesProgress.running ? "Uploading" : `Put ${plural(fileEntryCount, "file")} back`}
                    </Button>
                  )}
                </div>
              </div>
            </Section>
          )}
        </>
      )}
      </PageBody>
    </PageShell>
  );
}
