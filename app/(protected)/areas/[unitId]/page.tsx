"use client";

// AREA DETAIL — click a unit, see the plant. The 3D laser-scan model IS the
// page: viewer first, everything else folds underneath. Multiple models per
// unit (e.g. full unit + a revamp scan) switch with one click; every model
// carries a version chain (upload → supersede → restore, all audited).
// Management is Admin/DocCtrl only — enforced by RLS, mirrored in the UI.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft, Loader2, Plus, UploadCloud, History, Pencil, Archive,
  ShieldCheck, RotateCcw, Download, FileBox, ScanLine, X, Check,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { uploadToPath, getSignedUrlForPath, storageSelfTest } from "@/lib/storage";
import {
  UnitModel, UnitModelVersion, NewVersionFiles,
  listModels, listVersions, createModel, addVersion, restoreVersion,
  updateModelMeta, archiveModel, makeModelStorageKey, classifyScanFile,
  renderKindForKey,
} from "@/lib/unitModels";
import PointCloudViewer from "@/components/viewer3d/PointCloudViewer";
import { appConfirm } from "@/components/providers/DialogProvider";

// One-time Windows converter helper: installs PDAL in a private folder via
// micromamba (no admin rights, doesn't touch the system) and converts an
// E57/LAS/LAZ export to the .copc.laz the viewer streams.
const CONVERT_PS1 = `# Manufacturing OS - scan converter (E57/LAS/LAZ -> .copc.laz)
#
# First run downloads its own tools (~2 min, no admin needed, nothing
# installed system-wide - everything lives in %LOCALAPPDATA%\\mos-convert).
#
# Usage (PowerShell):
#   powershell -ExecutionPolicy Bypass -File convert-scan.ps1 "C:\\scans\\unit.e57"
param([Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference = "Stop"
if (!(Test-Path $InputFile)) { Write-Error "File not found: $InputFile" }
$base = Join-Path $env:LOCALAPPDATA "mos-convert"
$mm = Join-Path $base "micromamba.exe"
$envdir = Join-Path $base "env"
if (!(Test-Path $mm)) {
  New-Item -ItemType Directory -Force -Path $base | Out-Null
  Write-Host "Downloading micromamba (one time)..."
  Invoke-WebRequest -Uri "https://micro.mamba.pm/api/micromamba/win-64/latest" -OutFile (Join-Path $base "mm.tar.bz2")
  tar -xjf (Join-Path $base "mm.tar.bz2") -C $base "Library/bin/micromamba.exe"
  Move-Item (Join-Path $base "Library\\bin\\micromamba.exe") $mm -Force
}
if (!(Test-Path $envdir)) {
  Write-Host "Installing PDAL (one time, ~2 min)..."
  & $mm create -y -p $envdir -c conda-forge pdal | Out-Null
}
$out = ($InputFile -replace '\\.[^.]+$','') + ".copc.laz"
Write-Host "Converting -> $out (large scans take a few minutes)"
& $mm run -p $envdir pdal translate "$InputFile" "$out"
Write-Host "Done. Upload $out in Operating Areas - it will render in 3D."
`;

function downloadConvertKit() {
  const blob = new Blob([CONVERT_PS1], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "convert-scan.ps1";
  a.click();
  URL.revokeObjectURL(a.href);
}

function fmtBytes(n: number | null): string {
  if (!n) return "—";
  if (n > 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface UnitRow { id: string; name: string; code: string | null; description: string | null; plantName: string }

export default function AreaDetailPage() {
  const params = useParams<{ unitId: string }>();
  const unitId = params?.unitId;
  const { activeOrgId, uid, userEmail, hasAnyRole } = useRole();
  const canManage = hasAnyRole(["Admin", "DocCtrl"]);

  const [unit, setUnit] = useState<UnitRow | null>(null);
  const [models, setModels] = useState<UnitModel[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [versions, setVersions] = useState<UnitModelVersion[]>([]);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerKind, setViewerKind] = useState<"copc" | "las" | "pts">("copc");
  const [viewerState, setViewerState] = useState<"loading" | "ready" | "none" | "empty">("loading");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // Manage forms
  const [showAdd, setShowAdd] = useState(false);
  const [showVersion, setShowVersion] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editMeta, setEditMeta] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  // Form fields (shared by add-model and add-version)
  const [fName, setFName] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fCaptured, setFCaptured] = useState("");
  const [fNote, setFNote] = useState("");
  const [fCopc, setFCopc] = useState<File | null>(null);
  const [fSource, setFSource] = useState<File | null>(null);

  const actor = { uid: uid ?? "", email: userEmail ?? null };
  const selectedModel = models.find((m) => m.id === selected) ?? null;
  const currentVersion = versions.find((v) => v.id === selectedModel?.currentVersionId) ?? null;

  const refresh = useCallback(async () => {
    if (!activeOrgId || !unitId) return;
    setLoading(true);
    try {
      const [{ data: u }, ms] = await Promise.all([
        supabase.from("units").select("id, name, code, description, plant_id").eq("id", unitId).maybeSingle(),
        listModels(activeOrgId, unitId),
      ]);
      let plantName = "Plant";
      if (u?.plant_id) {
        const { data: p } = await supabase.from("plants").select("name").eq("id", u.plant_id as string).maybeSingle();
        plantName = (p?.name as string | null) ?? "Plant";
      }
      setUnit(u ? {
        id: String(u.id), name: String(u.name), code: (u.code as string | null) ?? null,
        description: (u.description as string | null) ?? null, plantName,
      } : null);
      setModels(ms);
      setSelected((prev) => (prev && ms.some((m) => m.id === prev)) ? prev : (ms[0]?.id ?? null));
    } finally { setLoading(false); }
  }, [activeOrgId, unitId]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Load versions + a signed streaming URL whenever the selected model changes.
  useEffect(() => {
    if (!selectedModel) { setVersions([]); setViewerUrl(null); setViewerState(models.length ? "loading" : "empty"); return; }
    let alive = true;
    setViewerState("loading");
    setViewerUrl(null);
    (async () => {
      const vs = await listVersions(selectedModel.id);
      if (!alive) return;
      setVersions(vs);
      const cur = vs.find((v) => v.id === selectedModel.currentVersionId) ?? vs[0] ?? null;
      const k = renderKindForKey(cur?.copcKey ?? null);
      if (cur?.copcKey && k) {
        try {
          const u = await getSignedUrlForPath(cur.copcKey, 7200);
          if (!alive) return;
          setViewerKind(k);
          setViewerUrl(u);
          setViewerState("ready");
        } catch {
          if (alive) setViewerState("none");
        }
      } else {
        setViewerState("none");
      }
    })();
    return () => { alive = false; };
  }, [selectedModel, models.length]);

  const resetForm = () => {
    setFName(""); setFDesc(""); setFCaptured(""); setFNote("");
    setFCopc(null); setFSource(null); setProgress(null);
  };

  /** Route a chosen file to the right slot by what it actually is:
   *  .copc.laz → the stream the viewer plays; everything else (.rcs, .rcp,
   *  .e57, .las…) → original-file custody. No format knowledge required. */
  const addFiles = (list: FileList | null) => {
    if (!list) return;
    for (const f of Array.from(list)) {
      if (classifyScanFile(f.name).renderable) setFCopc(f);
      else setFSource(f);
    }
  };

  /** Upload the chosen files to R2, return the version file facts. */
  const uploadFiles = async (): Promise<NewVersionFiles | null> => {
    if (!activeOrgId || !unitId) return null;
    if (!fCopc && !fSource) { setMsg({ tone: "err", text: "Add at least one file — your scan file (.rcs / .e57 / .las) and/or the viewable .copc.laz stream." }); return null; }
    let copcKey: string | null = null;
    let sourceKey: string | null = null;
    try {
      if (fCopc) {
        copcKey = makeModelStorageKey(activeOrgId, unitId, "copc", fCopc.name);
        await uploadToPath(fCopc, copcKey, {
          contentType: "application/octet-stream",
          onProgress: (p) => setProgress(fSource ? p.percent / 2 : p.percent),
        });
      }
      if (fSource) {
        sourceKey = makeModelStorageKey(activeOrgId, unitId, "source", fSource.name);
        await uploadToPath(fSource, sourceKey, {
          contentType: "application/octet-stream",
          onProgress: (p) => setProgress(fCopc ? 50 + p.percent / 2 : p.percent),
        });
      }
    } catch (e) {
      // Turn "network error" into a diagnosis: probe storage with a tiny
      // test write so the message says WHAT is broken, not just that it is.
      let hint = "";
      try {
        const probe = await storageSelfTest(activeOrgId);
        hint = probe.ok
          ? " (A small test upload just succeeded, so your connection to storage works — the failure is specific to the big file. Large files now upload in retried chunks; try again.)"
          : ` (A small test upload ALSO failed: ${probe.reason}. Storage is refusing uploads from this site — admin fix: Cloudflare R2 → bucket → Settings → CORS: allow this site's origin with methods GET/PUT/HEAD, all headers, and ExposeHeaders ["ETag"]. Also make sure you're on the production site URL, not a preview link.)`;
      } catch { /* probe unavailable — plain message */ }
      throw new Error(`The file upload failed — ${(e as Error).message}.${hint} Nothing was created; your file is untouched on your machine.`);
    }
    return {
      copcKey, copcSize: fCopc?.size ?? null, pointCount: null,
      sourceKey, sourceName: fSource?.name ?? null,
      sourceFormat: fSource ? classifyScanFile(fSource.name).format : (fCopc ? "copc" : null),
      sourceSize: fSource?.size ?? null,
      capturedAt: fCaptured || null,
      changeNote: fNote.trim() || null,
    };
  };

  const submitAddModel = async () => {
    if (!activeOrgId || !unitId) return;
    if (!fName.trim()) { setMsg({ tone: "err", text: "Give the model a name." }); return; }
    setBusy(true); setMsg(null);
    try {
      const files = await uploadFiles();
      if (!files) return;
      const res = await createModel({ orgId: activeOrgId, unitId, name: fName, description: fDesc || null, files, actor });
      if (!res.ok) throw new Error(res.error);
      setShowAdd(false); resetForm();
      await refresh();
      if (res.modelId) setSelected(res.modelId);
      setMsg(files.copcKey
        ? { tone: "ok", text: `Model "${fName.trim()}" added — rendering below.` }
        : { tone: "ok", text: `"${fName.trim()}" saved — your original file is in custody and fully tracked. It is NOT viewable in 3D yet — export PTS from ReCap (or get a LAS from your vendor) and attach it: those render directly, no conversion. Details in the yellow panel below.` });
    } catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    finally { setBusy(false); setProgress(null); }
  };

  const submitAddVersion = async () => {
    if (!activeOrgId || !selectedModel) return;
    setBusy(true); setMsg(null);
    try {
      const files = await uploadFiles();
      if (!files) return;
      const res = await addVersion({ orgId: activeOrgId, modelId: selectedModel.id, files, actor });
      if (!res.ok) throw new Error(res.error);
      setShowVersion(false); resetForm();
      await refresh();
      setMsg(files.copcKey
        ? { tone: "ok", text: "New version published — the previous one is superseded (nothing deleted; restore any time from History)." }
        : { tone: "ok", text: "New version saved with the original file in custody. Still not viewable in 3D — attach a PTS/LAS export (renders directly) or converted .copc.laz when you have it (yellow panel below)." });
    } catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    finally { setBusy(false); setProgress(null); }
  };

  const submitRestore = async (v: UnitModelVersion) => {
    if (!activeOrgId || !selectedModel) return;
    if (!(await appConfirm({ message: `Make v${v.versionNo} the current model again? The present current version becomes superseded (fully reversible).` }))) return;
    setBusy(true); setMsg(null);
    try {
      const res = await restoreVersion({ orgId: activeOrgId, modelId: selectedModel.id, versionId: v.id, actor });
      if (!res.ok) throw new Error(res.error);
      await refresh();
      setMsg({ tone: "ok", text: `Restored v${v.versionNo} as current.` });
    } catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const submitMeta = async () => {
    if (!activeOrgId || !selectedModel) return;
    if (!fName.trim()) { setMsg({ tone: "err", text: "Name can't be empty." }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await updateModelMeta({ orgId: activeOrgId, modelId: selectedModel.id, name: fName, description: fDesc || null, actor });
      if (!res.ok) throw new Error(res.error);
      setEditMeta(false); resetForm();
      await refresh();
    } catch (e) { setMsg({ tone: "err", text: (e as Error).message }); }
    finally { setBusy(false); }
  };

  const submitArchive = async () => {
    if (!activeOrgId || !selectedModel) return;
    if (!(await appConfirm({ message: `Archive "${selectedModel.name}"? It disappears from this page but nothing is deleted — files and full history stay on the record.`, tone: "danger" }))) return;
    setBusy(true);
    try {
      await archiveModel({ orgId: activeOrgId, modelId: selectedModel.id, actor });
      await refresh();
    } finally { setBusy(false); }
  };

  const downloadSource = async (v: UnitModelVersion) => {
    if (!v.sourceKey) return;
    try {
      const u = await getSignedUrlForPath(v.sourceKey, 900);
      window.open(u, "_blank", "noopener");
    } catch { setMsg({ tone: "err", text: "Couldn't fetch the source file." }); }
  };

  const fileForm = (
    <div className="space-y-2">
      {/* ONE drop zone — we work out what each file is. */}
      <label className="flex items-center gap-2 rounded-xl border-2 border-dashed border-[var(--color-border-strong)] px-3 py-3.5 cursor-pointer hover:border-[var(--color-accent-ring)] bg-[var(--color-surface-2)]/30">
        <UploadCloud className="w-5 h-5 text-[var(--color-accent)] shrink-0" />
        <span className="text-xs text-[var(--color-text-muted)]">
          <b className="text-[var(--color-text)]">Add your scan files</b> — <b>.las, .pts, and .copc.laz render in 3D directly</b>; .rcs / .e57 / .laz are kept safe in custody. Pick one or several; we sort out which is which.
        </span>
        <input type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      </label>

      {(fCopc || fSource) && (
        <ul className="space-y-1">
          {fCopc && (
            <li className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/[0.06] px-2.5 py-1.5 text-xs">
              <ScanLine className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span className="font-bold text-[var(--color-text)] truncate">{fCopc.name}</span>
              <span className="text-[10px] font-black text-emerald-700 dark:text-emerald-300 shrink-0">3D STREAM — the viewer plays this</span>
              <span className="text-[var(--color-text-faint)] shrink-0">{fmtBytes(fCopc.size)}</span>
              <button onClick={() => setFCopc(null)} className="ml-auto p-0.5 text-[var(--color-text-faint)] hover:text-rose-600 shrink-0"><X className="w-3.5 h-3.5" /></button>
            </li>
          )}
          {fSource && (
            <li className="flex items-center gap-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)]/40 px-2.5 py-1.5 text-xs">
              <FileBox className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
              <span className="font-bold text-[var(--color-text)] truncate">{fSource.name}</span>
              <span className="text-[10px] font-black text-[var(--color-text-muted)] shrink-0">ORIGINAL — kept in custody, exactly as-is</span>
              <span className="text-[var(--color-text-faint)] shrink-0">{fmtBytes(fSource.size)}</span>
              <button onClick={() => setFSource(null)} className="ml-auto p-0.5 text-[var(--color-text-faint)] hover:text-rose-600 shrink-0"><X className="w-3.5 h-3.5" /></button>
            </li>
          )}
        </ul>
      )}

      {fSource && !fCopc && (
        <div className="rounded-lg border border-sky-500/40 bg-sky-500/[0.06] px-2.5 py-2 text-[11px] text-[var(--color-text)] leading-relaxed">
          <b>Heads up:</b> this saves and tracks your original file, but the 3D viewer can&apos;t read {classifyScanFile(fSource.name).format.toUpperCase()} directly.
          Fastest route to 3D: in <b>ReCap Pro → Export → PTS</b> (or E57), then upload the <b>.pts here — it renders with no conversion</b>. E57 needs the one-time converter script (shown after saving).
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input type="date" value={fCaptured} onChange={(e) => setFCaptured(e.target.value)} className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs [color-scheme:light] dark:[color-scheme:dark]" title="Scan capture date" />
        <input value={fNote} onChange={(e) => setFNote(e.target.value)} placeholder="Change note (what's different in this scan)" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
      </div>
      {progress !== null && (
        <div className="space-y-1">
          <div className="h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
            <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${progress}%` }} />
          </div>
          <div className="text-[10px] font-bold text-[var(--color-text-muted)] tabular-nums">Uploading… {Math.round(progress)}%</div>
        </div>
      )}
    </div>
  );

  if (loading && !unit) {
    return <div className="py-20 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-[var(--color-accent)]" /></div>;
  }
  if (!unit) {
    return (
      <div className="max-w-xl mx-auto py-20 text-center">
        <div className="text-sm font-bold text-[var(--color-text)]">Unit not found</div>
        <Link href="/areas" className="text-xs underline text-[var(--color-text-muted)]">Back to Operating Areas</Link>
      </div>
    );
  }

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-5">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <Link href="/areas" className="p-1.5 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent-ring)] text-[var(--color-text-muted)]"><ArrowLeft className="w-4 h-4" /></Link>
        <div className="min-w-0">
          <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{unit.plantName}</div>
          <h1 className="text-lg font-black text-[var(--color-text)] truncate">
            {unit.name}{unit.code ? <span className="ml-2 text-xs font-bold text-[var(--color-text-muted)]">{unit.code}</span> : null}
          </h1>
        </div>
        {/* Model switcher */}
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => setSelected(m.id)}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition-colors ${selected === m.id
                ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)] border-transparent"
                : "border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:border-[var(--color-accent-ring)]"}`}
            >
              {m.name}
            </button>
          ))}
          {canManage && (
            <button onClick={() => { resetForm(); setShowAdd(true); setShowVersion(false); setEditMeta(false); }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)]">
              <Plus className="w-3.5 h-3.5" /> Add area / model
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div className={`mb-3 rounded-xl border px-3 py-2.5 text-xs font-bold ${msg.tone === "err"
          ? "border-rose-500/50 bg-rose-500/[0.08] text-rose-700 dark:text-rose-300"
          : "border-emerald-500/40 bg-emerald-500/[0.07] text-emerald-800 dark:text-emerald-300"}`}>
          {msg.text}
        </div>
      )}

      {/* THE VIEWER — first thing you see. */}
      {viewerState === "ready" && viewerUrl && <PointCloudViewer url={viewerUrl} kind={viewerKind} height={580} />}
      {viewerState === "loading" && models.length > 0 && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-black/90 h-[580px] flex items-center justify-center text-white/80 text-sm gap-2">
          <Loader2 className="w-5 h-5 animate-spin" /> Preparing model…
        </div>
      )}
      {viewerState === "none" && selectedModel && (
        <div className="rounded-2xl border-2 border-amber-500/50 bg-amber-500/[0.06] p-6">
          <div className="flex items-start gap-3">
            <FileBox className="w-7 h-7 text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-base font-black text-[var(--color-text)]">
                {currentVersion?.sourceName ?? "Your scan"} is saved and tracked — but not viewable in 3D yet
              </div>
              <div className="text-xs text-[var(--color-text-muted)] mt-1 leading-relaxed">
                {(currentVersion?.sourceFormat ?? "this").toUpperCase()} can&apos;t be drawn by any browser — Autodesk keeps the format closed. Your original is safe in custody; the viewer just needs the same points exported in an open format. <b>Fastest path — no conversion at all:</b>
              </div>
              {canManage && (
                <ol className="mt-3 space-y-1.5 text-xs text-[var(--color-text)] list-decimal list-inside">
                  <li><b>ReCap Pro</b> → open your scan → Export → <b>PTS</b> (or ask your scan vendor for a <b>LAS</b> deliverable — worth requesting on every scan going forward).</li>
                  <li>Back here: <b>New version</b> → drop the .pts (or .las) in → <b>it renders — done.</b></li>
                </ol>
              )}
              {canManage && (
                <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                  If you have an <b>E57</b> or <b>LAZ</b> instead: run it through the converter script below once (<code className="text-[10px] bg-[var(--color-surface-2)] rounded px-1 py-0.5">powershell -ExecutionPolicy Bypass -File convert-scan.ps1 &quot;C:\scans\export.e57&quot;</code>) and upload the .copc.laz it produces — that format also streams fastest for huge scans.
                </div>
              )}
              {!canManage && (
                <div className="mt-2 text-xs text-[var(--color-text-muted)]">Document Control can attach the viewable conversion.</div>
              )}
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                {canManage && (
                  <>
                    <button onClick={downloadConvertKit} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-black hover:bg-amber-700">
                      <Download className="w-3.5 h-3.5" /> Download converter script
                    </button>
                    <button onClick={() => { resetForm(); setShowVersion(true); setShowAdd(false); setEditMeta(false); }} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-600/50 text-amber-700 dark:text-amber-400 text-xs font-black hover:bg-amber-500/10">
                      <UploadCloud className="w-3.5 h-3.5" /> I have the export — attach it
                    </button>
                  </>
                )}
                {currentVersion?.sourceKey && (
                  <button onClick={() => void downloadSource(currentVersion)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-border-strong)] text-xs font-bold text-[var(--color-text-muted)] hover:border-[var(--color-accent-ring)]">
                    <Download className="w-3.5 h-3.5" /> Original file
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {models.length === 0 && (
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] h-[320px] flex items-center justify-center p-6">
          <div className="text-center max-w-md">
            <ScanLine className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-2" />
            <div className="text-sm font-bold text-[var(--color-text)]">No 3D models on {unit.name} yet</div>
            {canManage
              ? <div className="text-xs text-[var(--color-text-muted)] mt-1">Use <b>Add area / model</b> above. One model can be the whole unit, or add one per area — e.g. &ldquo;Sulfur rundown&rdquo;, &ldquo;Incinerator&rdquo; — and switch between them up top.</div>
              : <div className="text-xs text-[var(--color-text-muted)] mt-1">Document Control can add laser-scan models here.</div>}
          </div>
        </div>
      )}

      {/* Model facts bar */}
      {selectedModel && (
        <div className="mt-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="flex items-start gap-2 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-black text-[var(--color-text)]">{selectedModel.name}</span>
                {currentVersion && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-black text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-1.5 py-0.5">
                    <ShieldCheck className="w-3 h-3" /> v{currentVersion.versionNo} current
                  </span>
                )}
                {currentVersion?.capturedAt && (
                  <span className="text-[11px] text-[var(--color-text-muted)]">scanned {new Date(currentVersion.capturedAt).toLocaleDateString()}</span>
                )}
                {currentVersion && (
                  <span className="text-[11px] text-[var(--color-text-faint)]">
                    {currentVersion.copcKey ? `stream ${fmtBytes(currentVersion.copcSize)}` : "no stream"}
                    {currentVersion.sourceKey ? ` · source ${currentVersion.sourceName ?? ""} ${fmtBytes(currentVersion.sourceSize)}` : ""}
                  </span>
                )}
              </div>
              {selectedModel.description && <div className="mt-1 text-xs text-[var(--color-text-muted)]">{selectedModel.description}</div>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
              <button onClick={() => setShowHistory((s) => !s)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-xs font-bold text-[var(--color-text-muted)] hover:border-[var(--color-accent-ring)]">
                <History className="w-3.5 h-3.5" /> History ({versions.length})
              </button>
              {currentVersion?.sourceKey && (
                <button onClick={() => void downloadSource(currentVersion)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--color-border-strong)] text-xs font-bold text-[var(--color-text-muted)] hover:border-[var(--color-accent-ring)]">
                  <Download className="w-3.5 h-3.5" /> Source file
                </button>
              )}
              {canManage && (
                <>
                  <button onClick={() => { resetForm(); setShowVersion(true); setShowAdd(false); setEditMeta(false); }} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)]">
                    <UploadCloud className="w-3.5 h-3.5" /> New version
                  </button>
                  <button onClick={() => { setFName(selectedModel.name); setFDesc(selectedModel.description ?? ""); setEditMeta(true); setShowAdd(false); setShowVersion(false); }} className="p-1.5 rounded-lg border border-[var(--color-border-strong)] text-[var(--color-text-muted)] hover:border-[var(--color-accent-ring)]" title="Edit name / description">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => void submitArchive()} disabled={busy} className="p-1.5 rounded-lg border border-rose-500/40 text-rose-700 dark:text-rose-300 hover:bg-rose-500/10" title="Archive model">
                    <Archive className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Version history — the full tracking record. */}
          {showHistory && (
            <ul className="mt-3 pt-3 border-t border-[var(--color-border)] space-y-1.5">
              {versions.map((v) => (
                <li key={v.id} className={`flex items-center gap-2 flex-wrap rounded-lg border px-2.5 py-1.5 text-xs ${v.id === selectedModel.currentVersionId ? "border-emerald-500/40 bg-emerald-500/[0.05]" : "border-[var(--color-border)]"}`}>
                  <span className="font-black text-[var(--color-text)]">v{v.versionNo}</span>
                  {v.id === selectedModel.currentVersionId
                    ? <span className="text-[10px] font-black text-emerald-700 dark:text-emerald-300">CURRENT</span>
                    : <span className="text-[10px] font-bold text-[var(--color-text-faint)]">superseded{v.supersededAt ? ` ${new Date(v.supersededAt).toLocaleDateString()}` : ""}</span>}
                  <span className="text-[var(--color-text-muted)]">
                    {new Date(v.createdAt).toLocaleDateString()}{v.createdByName ? ` · ${v.createdByName}` : ""}
                    {v.capturedAt ? ` · scanned ${new Date(v.capturedAt).toLocaleDateString()}` : ""}
                    {v.copcKey ? ` · stream ${fmtBytes(v.copcSize)}` : " · custody only"}
                  </span>
                  {v.changeNote && <span className="italic text-[var(--color-text-muted)]">&ldquo;{v.changeNote}&rdquo;</span>}
                  <span className="ml-auto flex items-center gap-1">
                    {v.sourceKey && (
                      <button onClick={() => void downloadSource(v)} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--color-border-strong)] font-bold text-[var(--color-text-muted)] hover:border-[var(--color-accent-ring)]">
                        <Download className="w-3 h-3" /> Source
                      </button>
                    )}
                    {canManage && v.id !== selectedModel.currentVersionId && (
                      <button onClick={() => void submitRestore(v)} disabled={busy} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--color-border-strong)] font-bold text-[var(--color-text-muted)] hover:border-[var(--color-accent-ring)]">
                        <RotateCcw className="w-3 h-3" /> Restore
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Add-model form */}
      {showAdd && canManage && (
        <div className="mt-3 rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-black text-[var(--color-text)]">Add area / 3D model to {unit.name}</span>
            <button onClick={() => { setShowAdd(false); resetForm(); }} className="ml-auto p-1 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="Area or model name (e.g. Sulfur rundown, Full unit scan)" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
            <input value={fDesc} onChange={(e) => setFDesc(e.target.value)} placeholder="Description (scope, vendor, notes)" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          </div>
          {fileForm}
          <button onClick={() => void submitAddModel()} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Create model
          </button>
        </div>
      )}

      {/* Add-version form */}
      {showVersion && canManage && selectedModel && (
        <div className="mt-3 rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-black text-[var(--color-text)]">New version of {selectedModel.name}</span>
            <span className="text-[11px] text-[var(--color-text-muted)]">supersedes v{currentVersion?.versionNo ?? "—"} (kept in history)</span>
            <button onClick={() => { setShowVersion(false); resetForm(); }} className="ml-auto p-1 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
          </div>
          {fileForm}
          <button onClick={() => void submitAddVersion()} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />} Publish version
          </button>
        </div>
      )}

      {/* Edit meta form */}
      {editMeta && canManage && selectedModel && (
        <div className="mt-3 rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-black text-[var(--color-text)]">Edit model details</span>
            <button onClick={() => { setEditMeta(false); resetForm(); }} className="ml-auto p-1 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="Model name" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
            <input value={fDesc} onChange={(e) => setFDesc(e.target.value)} placeholder="Description" className="h-8 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-xs" />
          </div>
          <button onClick={() => void submitMeta()} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-xs font-black hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save
          </button>
        </div>
      )}

      {unit.description && (
        <div className="mt-3 text-xs text-[var(--color-text-muted)]">{unit.description}</div>
      )}
    </div>
  );
}
