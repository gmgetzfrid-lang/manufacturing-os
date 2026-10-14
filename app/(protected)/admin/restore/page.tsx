"use client";

// /admin/restore — bring a workspace back from a backup, end to end.
//
//   1. Drop a backup — the Full ZIP part(s) (records + binaries) or the JSON
//      export. Parsed IN THE BROWSER (lib/dataRestore.ts readBackupArchive —
//      the one archive layout, plus the older data.json parts); the plan below
//      is computed locally, zero writes.
//   2. Review the plan — user reconciliation by email, org-name collision,
//      exactly which tables import.
//   3. Restore records — the plan is made again from this workspace's
//      members as they are NOW (an earlier stopped run may have made some of
//      its placeholders), then a read-only check (how many backup rows
//      already exist here, how many are new), then chunked through
//      /api/admin/restore/begin + /apply-table so any size of backup fits
//      under request limits. A restore only ADDS (DEC-75): an
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
  RESTORE_HELD_ELSEWHERE_NOTE, RESTORE_LINK_MEMBER_STATUSES, restoreRefusalLabel, isDanglingFlowRefusal, DANGLING_FLOW_CODE,
  type RestorePlan, type RestoreEnvelopeLike, type RestorePost, type ChunkedRestoreResult, type ChunkedRestorePreview,
  type BackupArchiveRead, clearSkippedNodeImagePointers, nodeImagePointerLabel, overflowLines, type SkippedNodeImage,
  restoreEnvelopeNodeIds, nodeIdsPresentBeforeRestore, addRestoredNodeIds, storageAnsweredInRun, RESTORE_FILES_POINTER_NOTE,
  meaningIndexRebuildList, MEANING_INDEX_REBUILD_NOTE,
} from "@/lib/dataRestore";
import { restoreUploadRequest, isWorkspaceLogoKey, isNodeImageKey } from "@/lib/storageKey";
import { withRestoreMembershipCheck, restoreMembershipSentence, type RestoreMembershipCheck } from "@/lib/restoreMembership";

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
  /** Why files failed: each distinct refusal, with how many files it hit. */
  reasons?: Array<{ reason: string; files: number }>;
  /** A workspace logo the server will not sign (ORG-5), named with why. */
  logoNotRestored?: string | null;
  /** Folder / library covers and backgrounds the server will not sign
   *  (ORG-16: an SVG, HEIC or TIFF from before the rule), by file name. */
  nodeImagesNotRestored?: string[];
  /** ORG-18: the folders / libraries whose pointer at such a file was
   *  cleared (the storage check reported it missing), one line each. */
  nodeImagesCleared?: string[];
  /** ORG-18: nodes that name such a file the storage check did not report
   *  missing — named, not changed. */
  nodeImagesKept?: string[];
  /** ORG-18: a read or write of those pointers that failed, in words. */
  nodeImagePointerErrors?: string[];
}

function fmtNum(n: number) { return n >= 1000 ? n.toLocaleString() : String(n); }

/** ORG-18: every line of a restore list, behind a "Show all" toggle, so a
 *  list longer than the panel's summary still names every node. */
function ShowAllLines({ lines, testId }: { lines: string[]; testId: string }) {
  return (
    <details data-testid={testId} className="mt-1">
      <summary className="cursor-pointer font-bold underline">Show all {fmtNum(lines.length)}</summary>
      <ul className="mt-1 list-disc pl-4">
        {lines.map((l, i) => <li key={`${i}:${l}`}>{l}</li>)}
      </ul>
    </details>
  );
}

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
  const archiveWarningsRef = useRef<string[]>([]);
  // BKP-7: every dropped part, and every binary across them.
  const zipsRef = useRef<ZipLike[]>([]);
  const archiveFilesRef = useRef<BackupArchiveRead["files"]>([]);
  const [fileEntryCount, setFileEntryCount] = useState(0);

  const [applyProgress, setApplyProgress] = useState<ApplyProgress>({ phase: "idle", rowsDone: 0, rowsTotal: 0, tablesDone: 0, tablesTotal: 0 });
  const [applyResult, setApplyResult] = useState<ChunkedRestoreResult | null>(null);
  // NEDGE-16: the restore ends with the workspace's membership state.
  const [membershipCheck, setMembershipCheck] = useState<RestoreMembershipCheck | null>(null);
  const [preview, setPreview] = useState<ChunkedRestorePreview | null>(null);
  const idRemapRef = useRef<RestorePlan["idRemap"] | null>(null);
  // ORG-18 fix pass 2: the libraries / folders this session's restore runs
  // ADDED (absent before the records were applied). "Put the files back" may
  // clear a skipped image's pointer only on these; a row that was already
  // here is never changed. A failed "was it here" read is kept as a note and
  // adds nothing (fail-safe).
  const restoredNodesRef = useRef<{ libraries: Set<string>; collections: Set<string> } | null>(null);
  const restoredNodesNoteRef = useRef<string | null>(null);

  const [filesProgress, setFilesProgress] = useState<FilesProgress>({ running: false, done: 0, total: 0, uploaded: 0, skipped: 0, offline: 0, failed: 0 });

  const authToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? "";
  }, []);

  // The plan against this workspace as it is NOW. Members of every status
  // link by email, as /begin links them: a re-run finds the placeholders an
  // earlier run created (never a second set under new ids). Checked (fix
  // pass 4): a plan made against an unread member list would show every
  // backup person as new — it throws instead. Read-only.
  const readAndPlan = useCallback(async (envelope: RestoreEnvelopeLike, orgId: string): Promise<RestorePlan> => {
    const [{ data: orgRow, error: orgReadErr }, { data: memberRows, error: memberReadErr }] = await Promise.all([
      supabase.from("orgs").select("name").eq("id", orgId).maybeSingle(),
      supabase.from("org_members").select("uid, email, status").eq("org_id", orgId).in("status", [...RESTORE_LINK_MEMBER_STATUSES]),
    ]);
    const readErr = memberReadErr ? { what: "members", e: memberReadErr } : orgReadErr ? { what: "name", e: orgReadErr } : null;
    if (readErr) throw new Error(`Could not read this workspace's ${readErr.what} (${readErr.e.message}) — no plan was made and nothing was written.`);
    // Fix pass 5: a member with no address is passed too (it links by uid).
    const members = ((memberRows ?? []) as Array<{ uid: string; email: string | null; status: string | null }>)
      .map((m) => ({ uid: m.uid, email: m.email, status: m.status }));
    const p = planRestore(envelope, { orgId, orgName: ((orgRow as { name?: string } | null)?.name ?? ""), members });
    return { ...p, warnings: [...archiveWarningsRef.current, ...p.warnings] };
  }, []);

  // ── 1. Read + plan (all local — nothing is written) ───────────────────────
  const handleFiles = useCallback(async (dropped: File[]) => {
    if (!activeOrgId || dropped.length === 0) return;
    setError(null); setPlan(null); setApplyResult(null); setMembershipCheck(null); setPreview(null);
    setFileName(dropped.length === 1 ? dropped[0].name : `${dropped.length} files: ${dropped.map((f) => f.name).join(", ")}`);
    setApplyProgress({ phase: "idle", rowsDone: 0, rowsTotal: 0, tablesDone: 0, tablesTotal: 0 });
    setFilesProgress({ running: false, done: 0, total: 0, uploaded: 0, skipped: 0, offline: 0, failed: 0 });
    envelopeRef.current = null; zipsRef.current = []; archiveFilesRef.current = []; archiveWarningsRef.current = []; setFileEntryCount(0);
    idRemapRef.current = null;
    restoredNodesRef.current = null; restoredNodesNoteRef.current = null;

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

      // Current workspace context for the local plan (checked; see readAndPlan).
      archiveWarningsRef.current = archiveWarnings;
      const p = await readAndPlan(envelope, activeOrgId);
      envelopeRef.current = envelope;
      setPlan(p);
      setKeepName("current");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [activeOrgId, readAndPlan]);

  // ── 3. Re-plan, check, confirm, then the chunked apply (begin → apply-table, FK order) ─
  const applyRestore = async () => {
    const envelope = envelopeRef.current;
    if (!activeOrgId || !envelope || !plan) return;
    setError(null); setMembershipCheck(null);
    // Fix pass 5: plan again against the members as they are NOW — a run
    // /begin stopped (a refused placeholder) kept the placeholders it made,
    // and a re-run links them, so the plan made at drop time would overstate
    // the placeholders this run creates. The confirm's count is this plan's.
    let fresh: RestorePlan;
    try {
      fresh = await readAndPlan(envelope, activeOrgId);
    } catch (e) {
      setApplyProgress((p) => ({ ...p, phase: "error" }));
      setError((e as Error).message);
      return;
    }
    setPlan(fresh);
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
      // here (kept as they are), how many ids another workspace holds (cannot
      // be restored here) and how many would be new. Read-only.
      const check = await previewChunkedRestore({ orgId: activeOrgId, envelope, plan: fresh, post, onProgress });
      setPreview(check);
      setApplyProgress({ phase: "idle", rowsDone: 0, rowsTotal: 0, tablesDone: 0, tablesTotal: 0 });
      const ok = await appConfirm({
        title: "Apply restore",
        message:
          `Write ${fmtNum(check.wouldInsert)} new record(s) into this workspace. ` +
          (check.existing > 0
            ? `${fmtNum(check.existing)} record(s) in the backup already exist here and will be KEPT EXACTLY AS THEY ARE — not overwritten, not repaired (the one exception, a numbering counter, is described below). `
            : "") +
          (check.heldElsewhere > 0
            ? `${fmtNum(check.heldElsewhere)} record(s) will NOT be restored: ${RESTORE_HELD_ELSEWHERE_NOTE} `
            : "") +
          `${fresh.counts.newUsers} restored placeholder user(s) will be created (inactive, no seat). ` +
          (fresh.counts.unmappedUsers > 0
            ? `${fresh.counts.unmappedUsers} backup member(s) with no email address cannot be mapped to anyone here — every record naming one will be refused. `
            : "") +
          `${RESTORE_ADDITIVE_NOTE} This can't be auto-undone.`,
        tone: "danger",
        confirmLabel: "Apply restore",
      });
      if (!ok) return;
      // ORG-18 fix pass 2: which of the backup's libraries and folders are
      // already here, read before anything is written — the files step never
      // changes one of those. Read-only; a failure does not stop the restore.
      const backupNodeIds = restoreEnvelopeNodeIds(envelope);
      const nodesBefore = backupNodeIds.libraries.length + backupNodeIds.collections.length > 0
        ? await nodeIdsPresentBeforeRestore(supabase, activeOrgId, backupNodeIds)
        : null;
      // NEDGE-16: the completion step — who is active now (restored people
      // are inactive and hear nothing until reactivated), shown and audited
      // — runs once the run has started, whether it returns or throws.
      const result = await withRestoreMembershipCheck(activeOrgId, post,
        async () => await runChunkedRestore({ orgId: activeOrgId, envelope, plan: fresh, orgNameChoice: keepName, post, onProgress }),
        setMembershipCheck);
      idRemapRef.current = result.idRemap; // "Put the files back" follows the org remap
      if (nodesBefore?.ok) restoredNodesRef.current = addRestoredNodeIds(restoredNodesRef.current, backupNodeIds, nodesBefore);
      else if (nodesBefore && !nodesBefore.ok) restoredNodesNoteRef.current = nodesBefore.error;
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
    // ORG-5 fix pass: a failure keeps the route's (or storage's) reason, so
    // the panel says why instead of a bare count.
    const reasons = new Map<string, number>();
    let logoNotRestored: string | null = null;
    const nodeImagesNotRestored: string[] = [];
    // ORG-18: each skipped cover / background key, and whether the storage
    // check said it is not there (only then is a node's pointer cleared).
    const skippedNodeImages: SkippedNodeImage[] = [];
    const detail = () => ({
      reasons: [...reasons].map(([reason, files]) => ({ reason, files })),
      logoNotRestored,
      nodeImagesNotRestored: [...nodeImagesNotRestored],
    });
    const bump = () => setFilesProgress({ running: true, total: entries.length, ...counters, error: null, ...detail() });

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
        const state = await check.json().catch(() => null) as { archived?: boolean; archiveId?: string | null; missing?: boolean } | null;
        if (check.ok && state?.archived === false) { counters.skipped++; return; }
        if (check.ok && state?.archived === true && state?.archiveId) { counters.offline++; return; }

        const blob = await zips[item.zip].file(item.entry)!.async("blob");
        // ORG-5: upload-url signs a workspace logo only with its type AND its
        // size (both signed into the PUT), so the request carries the blob's
        // size and the PUT sends the type the request named. A logo it will
        // not sign (an SVG or GIF from before ORG-5, or over 5 MB) is not
        // asked for: the panel says to upload it again under Branding. A
        // logo's type is read from its first bytes — its key was once named
        // after the file (".jfif", or no extension), not after its type. A
        // folder's or library's cover / background likewise (ORG-16: signed
        // only as an image type now).
        const head = isWorkspaceLogoKey(key) || isNodeImageKey(key) ? new Uint8Array(await blob.slice(0, 12).arrayBuffer()) : null;
        const req = restoreUploadRequest(key, blob.size, head);
        if (req.logoProblem) {
          logoNotRestored = `${key.split("/").pop()}: ${req.logoProblem}`;
          return;
        }
        // ORG-16: a cover or background the server will not sign (an SVG,
        // HEIC or TIFF from before the rule) is not asked for either; the
        // panel names it so the node can be given its image again. ORG-18:
        // the key is kept, with whether the storage check reported it missing
        // (`missing: true` — the route's answer to a HEAD failure of any kind).
        if (req.nodeImageProblem) {
          nodeImagesNotRestored.push(key.split("/").slice(-2).join("/"));
          skippedNodeImages.push({ key, reportedMissing: check.ok && state?.missing === true });
          return;
        }
        const up = await fetch(`/api/storage/upload-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(req.body),
        });
        const upBody = await up.json().catch(() => null);
        if (!up.ok || !upBody?.url) throw new Error(upBody?.error || `HTTP ${up.status}`);
        const put = await fetch(upBody.url as string, { method: "PUT", body: blob, headers: { "Content-Type": req.contentType } });
        if (!put.ok) throw new Error(`Storage refused the upload (HTTP ${put.status})`);
        counters.uploaded++;
      } catch (e) {
        counters.failed++;
        const reason = (e instanceof Error && e.message) || "Upload failed";
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
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
    // ORG-18: no folder or library this restore added is left pointing at a
    // cover or background this run skipped — the pointer is cleared (when the
    // storage check reported the file missing and storage answered this run)
    // and each node is named; a node that was already here is named and kept.
    // The restored rows are in place: this step follows "Restore records".
    let pointers: { nodeImagesCleared: string[]; nodeImagesKept: string[]; nodeImagePointerErrors: string[] } | null = null;
    if (skippedNodeImages.length > 0) {
      try {
        // Fix pass 2 (DEC-90 fail-safe): only a row this restore added, and
        // only when storage answered at least once this run.
        const added = restoredNodesRef.current;
        const r = await clearSkippedNodeImagePointers(supabase, activeOrgId, skippedNodeImages, {
          restoredLibraryIds: added?.libraries ?? new Set<string>(),
          restoredFolderIds: added?.collections ?? new Set<string>(),
          storageAnswered: storageAnsweredInRun(counters),
        });
        pointers = {
          nodeImagesCleared: r.cleared.map(nodeImagePointerLabel),
          nodeImagesKept: r.kept.map(nodeImagePointerLabel),
          nodeImagePointerErrors: [...(restoredNodesNoteRef.current ? [restoredNodesNoteRef.current] : []), ...r.errors],
        };
      } catch (e) {
        pointers = { nodeImagesCleared: [], nodeImagesKept: [], nodeImagePointerErrors: [(e instanceof Error && e.message) || "The folders and libraries using these images could not be checked."] };
      }
    }
    setFilesProgress({ running: false, total: entries.length, ...counters, ...detail(), ...(pointers ?? {}) });
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
            <Stat icon={Database} tint="text-[var(--color-accent)]" value={preview ? preview.wouldInsert : plan.counts.totalRows} label={preview ? `new records (${fmtNum(preview.existing)} already here, kept as they are${preview.heldElsewhere > 0 ? ` · ${fmtNum(preview.heldElsewhere)} cannot be restored — ids in use elsewhere` : ""})` : "records to import"} />
            <Stat icon={FolderArchive} tint="text-violet-600" value={fileEntryCount || plan.counts.files} label={fileEntryCount ? "files in the dropped part(s)" : "files referenced"} />
          </div>

          {/* Users */}
          {plan.users.length > 0 && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[var(--color-border)] text-xs font-black text-[var(--color-text)] uppercase tracking-widest flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> User reconciliation (by email)</div>
              <div className="divide-y divide-[var(--color-border)] max-h-72 overflow-y-auto">
                {plan.users.map((u) => (
                  <div key={`${u.email}|${u.oldUid}`} className="px-4 py-2 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-[var(--color-text)] truncate">{u.displayName || u.email || u.oldUid}</div>
                      <div className="text-[10.5px] text-[var(--color-text-muted)] truncate">
                        {u.email || "no email address — matched by id"}{u.role ? ` · ${u.role}` : ""}
                        {u.aliasUids?.length ? ` · ${u.aliasUids.length + 1} membership rows in the backup` : ""}
                      </div>
                    </div>
                    {u.disposition === "linked" ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded"
                        title={u.linkedStatus && u.linkedStatus !== "active" ? `Linked to this workspace's ${u.linkedStatus} member with this email (a restore placeholder is inactive) — no new placeholder is created, and the member's status is not changed.` : undefined}>
                        <UserCheck className="w-3 h-3" /> re-link{u.linkedStatus && u.linkedStatus !== "active" ? ` (${u.linkedStatus})` : ""}
                      </span>
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
                      {preview.tables[t.name].heldElsewhere > 0 && <span className="text-red-700 font-bold"> · {fmtNum(preview.tables[t.name].heldElsewhere)} ids in use elsewhere</span>}
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

          {/* NEDGE-16: the membership check, shown whether the run returned or
              threw — a /begin that stopped part-way keeps the inactive
              placeholders it created. */}
          {membershipCheck && (
            <div
              role="status"
              data-testid="restore-membership-check"
              className={`mt-3 rounded-2xl border p-4 text-[11px] leading-relaxed ${
                !membershipCheck.ok || membershipCheck.summary.inactiveMembers > 0
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-emerald-200 bg-emerald-50 text-emerald-900"
              }`}
            >
              {membershipCheck.ok ? (
                <>
                  <b>Members:</b> {restoreMembershipSentence(membershipCheck.summary)}
                  {membershipCheck.summary.inactiveMembers > 0 && (
                    <> <Link href="/admin/users" className="font-bold underline">Open Users</Link>.</>
                  )}
                  {membershipCheck.auditError && (
                    <div className="mt-1 text-rose-800">The membership check could not be written to the audit log: {membershipCheck.auditError}</div>
                  )}
                </>
              ) : (
                <><b>Members:</b> {membershipCheck.error}</>
              )}
            </div>
          )}

          {/* intelligence ILIFE-11 (admin-and-org Round G, P14; DEC-90): each
              restored library whose passages had vectors needs a person's
              meaning-index Build. */}
          {applyResult && <MeaningIndexRebuildPrompt result={applyResult} envelope={envelopeRef.current} />}

          {/* Put files back (ZIP only, after records) */}
          {applyResult && fileEntryCount > 0 && (
            <div className="rounded-2xl border border-violet-200 bg-violet-50/40 p-4">
              <div className="flex items-center gap-2 text-sm font-black text-[var(--color-text)] mb-1">
                <FolderArchive className="w-4 h-4 text-violet-600" /> Put the files back
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)] mb-3 max-w-2xl">
                Re-uploads the <b>{fmtNum(fileEntryCount)}</b> file(s) embedded in the dropped part(s) to live storage under their original keys, so drawings open normally instead of prompting for an archive. Files already in storage are skipped; files that belong to offline space archives stay offline by design.{" "}
                <span data-testid="restore-files-pointer-note">{RESTORE_FILES_POINTER_NOTE}</span>
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
                  {(filesProgress.reasons ?? []).slice(0, 5).map((r) => (
                    <div key={r.reason} className="text-[10.5px] text-red-700 mt-0.5">
                      {fmtNum(r.files)} file(s): {r.reason}
                    </div>
                  ))}
                  {filesProgress.logoNotRestored && (
                    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
                      The workspace logo in this backup was not put back ({filesProgress.logoNotRestored}). Upload it again
                      as a PNG, JPEG or WebP of at most 5 MB under <Link href="/admin/branding" className="font-bold underline">Admin → Branding</Link>;
                      until then the workspace&apos;s logo does not load.
                    </div>
                  )}
                  {(filesProgress.nodeImagesNotRestored ?? []).length > 0 && (
                    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
                      {fmtNum(filesProgress.nodeImagesNotRestored!.length)} folder or library cover / background image(s) in this
                      backup were not put back ({filesProgress.nodeImagesNotRestored!.slice(0, 5).join(", ")}
                      {filesProgress.nodeImagesNotRestored!.length > 5 ? ", …" : ""}): a cover or background must now be a PNG, JPEG,
                      WebP, GIF, AVIF or BMP image (SVG, HEIC and TIFF are not accepted). Open the folder or library under{" "}
                      <Link href="/documents" className="font-bold underline">Documents</Link> → Customize and pick the image again;
                      until then it shows no cover or background.
                    </div>
                  )}
                  {(filesProgress.nodeImagesCleared ?? []).length > 0 && (() => {
                    const all = filesProgress.nodeImagesCleared!;
                    const { shown, more } = overflowLines(all, 10);
                    return (
                      <div data-testid="restore-node-images-cleared" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
                        So nothing points at a missing image, the cover or background was removed from{" "}
                        {fmtNum(all.length)} folder(s) / librar(ies): {shown.join("; ")}
                        {more > 0 ? `; and ${fmtNum(more)} more` : ""}. Pick a new image for each under Customize.
                        {more > 0 && <ShowAllLines lines={all} testId="restore-node-images-cleared-all" />}
                      </div>
                    );
                  })()}
                  {(filesProgress.nodeImagesKept ?? []).length > 0 && (() => {
                    const all = filesProgress.nodeImagesKept!;
                    const { shown, more } = overflowLines(all, 10);
                    return (
                      <div data-testid="restore-node-images-kept" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
                        These still point at a skipped image (nothing was changed), each with the reason it was kept:{" "}
                        {shown.join("; ")}{more > 0 ? `; and ${fmtNum(more)} more` : ""}.
                        Run again, or pick a new image under Customize (an SVG, HEIC or TIFF must be replaced by a PNG, JPEG, WebP, GIF, AVIF or BMP).
                        {more > 0 && <ShowAllLines lines={all} testId="restore-node-images-kept-all" />}
                      </div>
                    );
                  })()}
                  {(filesProgress.nodeImagePointerErrors ?? []).length > 0 && (() => {
                    const all = filesProgress.nodeImagePointerErrors!;
                    const { shown, more } = overflowLines(all, 5);
                    return (
                      <div data-testid="restore-node-image-errors" className="text-[10.5px] text-red-700">
                        {shown.map((e, i) => (
                          <div key={`${i}:${e}`} className="mt-0.5">{e}</div>
                        ))}
                        {more > 0 && (
                          <>
                            <div className="mt-0.5 font-bold">and {fmtNum(more)} more that failed</div>
                            <ShowAllLines lines={all} testId="restore-node-image-errors-all" />
                          </>
                        )}
                      </div>
                    );
                  })()}
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
 *  run that stopped, refused rows, cleared pointers, wrote nothing, wrote
 *  rows the server did not count, or met ids another workspace holds. */
function RestoreResultPanel({ result }: { result: ChunkedRestoreResult }) {
  const stopped = result.stoppedAt;
  // An uncounted write is unknown — never "nothing new" (fix pass 2).
  const nothingNew = result.totalInserted === 0 && result.totalUncounted === 0;
  const tone = stopped || result.totalHeldElsewhere > 0
    ? "border-red-200 bg-red-50 text-red-900"
    : result.totalDanglingFlows > 0 || result.totalRefused > 0 || result.totalCleared > 0 || result.totalUncounted > 0 || nothingNew ? "border-amber-200 bg-amber-50 text-amber-900" : "border-emerald-200 bg-emerald-50 text-emerald-900";
  // BKP-15: a process flow whose equipment or unit is gone is said on its own
  // line — it was dangling in the backup — never counted with real refusals.
  const refusedByTable = result.tables
    .map((t) => ({ ...t, refused: t.refused.filter((r) => !isDanglingFlowRefusal(r)) }))
    .filter((t) => t.refused.length > 0);
  const danglingByTable = result.tables
    .map((t) => ({ name: t.name, n: t.refused.filter(isDanglingFlowRefusal).length }))
    .filter((t) => t.n > 0);
  const clearedByTable = result.tables.filter((t) => t.cleared.length > 0);
  const elsewhereByTable = result.tables.filter((t) => t.heldElsewhere > 0);
  return (
    <div className={`rounded-2xl border p-4 ${tone}`}>
      <div className="flex items-center gap-2 text-sm font-black mb-1">
        {stopped
          ? <><AlertTriangle className="w-4 h-4" /> Restore stopped at <span className="font-mono">{stopped.table}</span> — {result.notAttempted.length} table(s) not attempted</>
          : result.totalHeldElsewhere > 0
            ? <><AlertTriangle className="w-4 h-4" /> {fmtNum(result.totalHeldElsewhere)} record(s) could NOT be restored — their ids are in use elsewhere</>
            : nothingNew
              ? <><AlertTriangle className="w-4 h-4" /> Nothing new was restored</>
              : result.totalRefused > 0
                ? <><AlertTriangle className="w-4 h-4" /> Records restored — {fmtNum(result.totalRefused)} row(s) refused</>
                : result.totalDanglingFlows > 0
                  ? <><AlertTriangle className="w-4 h-4" /> Records restored — {fmtNum(result.totalDanglingFlows)} dangling process flow(s) not restored</>
                  : result.totalUncounted > 0
                    ? <><AlertTriangle className="w-4 h-4" /> Restored — {fmtNum(result.totalUncounted)} record(s) the server did not count</>
                    : result.totalCleared > 0
                      ? <><AlertTriangle className="w-4 h-4" /> Records restored — {fmtNum(result.totalCleared)} pointer(s) cleared</>
                      : <><CheckCircle2 className="w-4 h-4" /> Records restored</>}
      </div>
      <div className="text-[11px] leading-relaxed space-y-1">
        <div>
          Imported <b>{fmtNum(result.totalInserted)}</b> new record(s) · <b>{fmtNum(result.totalExisting)}</b> already here, kept exactly as they were
          {result.totalHeldElsewhere > 0 && <> · <b>{fmtNum(result.totalHeldElsewhere)}</b> NOT restored (ids in use by another workspace)</>}
          {result.totalUncounted > 0 && <> · <b>{fmtNum(result.totalUncounted)}</b> not counted by the server</>}
          {result.totalFiltered > 0 && <> · <b>{fmtNum(result.totalFiltered)}</b> comment(s) on tickets archived since the backup left out</>}
          {result.totalAdvanced > 0 && <> · <b>{fmtNum(result.totalAdvanced)}</b> numbering counter(s) advanced past the restored numbers (never lowered; a gap, never a repeat, where this workspace&apos;s prefix differs)</>}
          {" "}· re-linked <b>{result.linkedUsers}</b> user(s) · created <b>{result.createdUsers}</b> restored placeholder(s).
        </div>
        {result.totalExisting > 0 && <div>{RESTORE_ADDITIVE_NOTE}</div>}
        {result.totalHeldElsewhere > 0 && (
          <div>
            <b>Not restored:</b> {RESTORE_HELD_ELSEWHERE_NOTE}{" "}
            {elsewhereByTable.map((t, i) => <React.Fragment key={t.name}>{i > 0 ? ", " : ""}<span className="font-mono">{t.name}</span> ({fmtNum(t.heldElsewhere)})</React.Fragment>)}.
          </div>
        )}
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
            {Array.from(new Set(t.refused.map((r) => restoreRefusalLabel(r.code)))).join("; ")} (see the audit log&apos;s RESTORE_CHUNK rows for each id).
          </div>
        ))}
        {danglingByTable.map((t) => (
          <div key={`dangling-${t.name}`}>
            <span className="font-mono">{t.name}</span>: {t.n} flow(s) not restored — {restoreRefusalLabel(DANGLING_FLOW_CODE)}. Draw them again once the equipment or unit exists.
          </div>
        ))}
        {clearedByTable.map((t) => (
          <div key={t.name}>
            <span className="font-mono">{t.name}</span>: {t.cleared.length} row(s) restored with a pointer cleared —{" "}
            {Array.from(new Set(t.cleared.map((r) => r.message.split(" ")[0]))).join(", ")} (
            {Array.from(new Set(t.cleared.map((r) => restoreRefusalLabel(r.code)))).join("; ")}).
          </div>
        ))}
        {result.tables.filter((t) => (t.notApplied ?? []).length > 0).map((t) => (
          <div key={`not-applied-${t.name}`} data-testid="restore-not-applied">
            <span className="font-mono">{t.name}</span>: {t.notApplied.length} backup decision(s) not applied — this workspace holds the same{" "}
            {t.name === "entity_mentions" ? "link" : "row"} under its key, and the live row was kept exactly as it is.
            {t.notApplied.slice(0, 5).map((r, i) => (
              <div key={`${t.name}-${r.id ?? i}`} className="ml-3">Backup row <span className="font-mono">{r.id ?? "(no id)"}</span>: {r.message}</div>
            ))}
            {t.notApplied.length > 5 && <div className="ml-3">…and {t.notApplied.length - 5} more (each is in the audit log&apos;s RESTORE_CHUNK rows).</div>}
          </div>
        ))}
        {result.unmappedMembers > 0 && (
          <div>
            <b>{fmtNum(result.unmappedMembers)}</b> backup member(s) have no email address and no membership here, so no person here could be found for them — every record naming one was refused (above). Add their address to the backup&apos;s org_members and restore again.
          </div>
        )}
        {result.placeholdersWithoutProfile > 0 && (
          <div>
            <b>{fmtNum(result.placeholdersWithoutProfile)}</b> restored placeholder(s) have no sign-in account yet, so a team membership naming one was not restored and a team creator / adder naming one was cleared — add them to their teams again once they accept the invitation.
          </div>
        )}
        <div>Restored users are inactive — re-invite them to grant access.</div>
      </div>
    </div>
  );
}

/** intelligence ILIFE-11 (admin-and-org Round G, P14; DEC-90): after a
 *  restore, each restored library whose passages had meaning-index vectors
 *  in the backup — and hold none here, since an export leaves them out — is
 *  named, with a link to the library, where a person starts the Build on
 *  their own embedding key. Nothing is started from here. */
function MeaningIndexRebuildPrompt({ result, envelope }: { result: ChunkedRestoreResult; envelope: RestoreEnvelopeLike | null }) {
  const libraries = meaningIndexRebuildList(result, envelope);
  const unchecked = result.meaningIndexUnchecked ?? [];
  if (libraries.length === 0 && unchecked.length === 0) return null;
  return (
    <div role="status" data-testid="restore-meaning-index-rebuild" className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-[11px] leading-relaxed text-amber-900">
      <div className="flex items-center gap-2 text-sm font-black mb-1">
        <AlertTriangle className="w-4 h-4" /> Meaning index needs a rebuild
      </div>
      {libraries.length > 0 && (
        <>
          <div>{MEANING_INDEX_REBUILD_NOTE}</div>
          <ul className="mt-1 list-disc ml-5">
            {libraries.map((l) => (
              <li key={l.libraryId}>
                <Link href={`/knowledge/${encodeURIComponent(l.libraryId)}`} className="font-bold underline">{l.name}</Link>
                {" "}— {fmtNum(l.passages)} restored passage(s) without their vectors. Open it and start a meaning-index Build.
              </li>
            ))}
          </ul>
        </>
      )}
      {unchecked.length > 0 && (
        <div className="mt-1">
          Which libraries need a meaning-index Build could not be checked ({unchecked[0]}). If meaning search is off for a restored library, open it and start a Build.
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
