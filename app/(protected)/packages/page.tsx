"use client";

// /packages — self-watching work packages.
//
// A package is a job's document set with revisions pinned at assembly.
// FRESH (all green) means every drawing in the pack is still current;
// STALE (amber, loud) means at least one advanced — review the change and
// refresh the pack before execution. A tripwire, never a lock.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Package, Plus, X, Loader2, CheckCircle2, AlertTriangle,
  RefreshCw, Search, ChevronRight, Archive, Printer,
} from "lucide-react";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { supabase } from "@/lib/supabase";
import {
  listWorkPackages, createWorkPackage, refreshWorkPackage,
  setWorkPackageStatus, type WorkPackage,
} from "@/lib/workPackages";

interface DocPick { id: string; label: string; rev: string | null }

export default function PackagesPage() {
  const { activeOrgId, uid, userEmail } = useRole();
  const { showToast } = useToast();
  // Scan landing: the QR on a printed cover sheet lands here with ?pkg= —
  // highlight that package so the verdict is instant.
  const highlightId = useSearchParams().get("pkg");

  const [packages, setPackages] = useState<WorkPackage[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [printing, setPrinting] = useState<string | null>(null);

  // Create-modal state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<DocPick[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DocPick[]>([]);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    setPackages(await listWorkPackages(activeOrgId));
  }, [activeOrgId]);

  useEffect(() => { void load(); }, [load]);

  // Doc search for the create modal.
  useEffect(() => {
    if (!query.trim() || !activeOrgId) {
      void (async () => setResults([]))();
      return;
    }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("documents")
        .select("id, document_number, title, name, rev, status")
        .eq("org_id", activeOrgId)
        .or(`document_number.ilike.%${query}%,title.ilike.%${query}%`)
        .neq("status", "Archived")
        .neq("status", "Superseded")
        .limit(8);
      setResults(((data as Array<Record<string, unknown>>) ?? []).map((d) => ({
        id: String(d.id),
        label: String(d.document_number || d.title || d.name || "Document"),
        rev: (d.rev as string | null) ?? null,
      })));
    }, 250);
    return () => clearTimeout(t);
  }, [query, activeOrgId]);

  const handleCreate = async () => {
    if (!activeOrgId || !uid) return;
    if (!name.trim()) return showToast({ type: "warning", title: "Name the package", message: "e.g. \"E-204 bundle swap\"" });
    if (picked.length === 0) return showToast({ type: "warning", title: "Add documents", message: "A package needs at least one drawing." });
    setCreating(true);
    try {
      await createWorkPackage({
        orgId: activeOrgId,
        name,
        description,
        documentIds: picked.map((p) => p.id),
        actorUserId: uid,
        actorName: userEmail?.split("@")[0] || "User",
      });
      setShowCreate(false);
      setName(""); setDescription(""); setPicked([]); setQuery("");
      await load();
      showToast({ type: "success", title: "Package created", message: "Revisions pinned. You'll be told the moment any drawing advances." });
    } catch (e) {
      showToast({ type: "error", title: "Couldn't create package", message: (e as Error).message });
    } finally {
      setCreating(false);
    }
  };

  const handleRefresh = async (pkg: WorkPackage) => {
    setBusyId(pkg.id);
    try {
      await refreshWorkPackage(pkg.id);
      await load();
      showToast({ type: "success", title: "Package refreshed", message: "All pins moved to the current revisions. Re-print the pack." });
    } finally {
      setBusyId(null);
    }
  };

  const handleClose = async (pkg: WorkPackage) => {
    setBusyId(pkg.id);
    try {
      await setWorkPackageStatus(pkg.id, "closed", userEmail?.split("@")[0]);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  // Print the pack: cover sheet (contents + scan-before-starting QR) +
  // every drawing at its CURRENT revision, stamped. Pins auto-refresh to
  // match what was printed — the paper and the database agree by
  // construction, no separate "remember to refresh" step.
  const handlePrintPack = async (pkg: WorkPackage) => {
    if (!activeOrgId || !uid) return;
    setPrinting(pkg.id);
    try {
      await refreshWorkPackage(pkg.id);
      const { buildPackageCover } = await import("@/lib/physicalBridge");
      const { buildAndDownloadDocPack } = await import("@/lib/docPack");
      const fresh = (await listWorkPackages(activeOrgId)).find((p) => p.id === pkg.id) ?? pkg;
      const cover = await buildPackageCover({
        packageId: pkg.id,
        name: fresh.name,
        description: fresh.description,
        ownerName: fresh.ownerName,
        printedByName: userEmail?.split("@")[0] ?? null,
        docs: fresh.docs.map((d) => ({ label: d.docLabel, rev: d.currentRev ?? d.pinnedRevLabel })),
      });
      const result = await buildAndDownloadDocPack({
        orgId: activeOrgId,
        packLabel: fresh.name,
        documentIds: fresh.docs.map((d) => d.documentId),
        userId: uid,
        userEmail,
        cover,
      });
      await load();
      showToast({
        type: "success",
        title: "Pack printed & pins refreshed",
        message: result.skipped.length === 0
          ? `${result.included} drawings, cover sheet with live-status QR on top.`
          : `${result.included} included; skipped: ${result.skipped.map((s) => s.label).join(", ")}.`,
      });
    } catch (e) {
      showToast({ type: "error", title: "Couldn't print the pack", message: (e as Error).message });
    } finally {
      setPrinting(null);
    }
  };

  const staleTotal = useMemo(
    () => (packages ?? []).filter((p) => p.staleCount > 0).length,
    [packages],
  );

  return (
    <PageShell width="work">
      <ViewTabs title="Documents" tabs={DOCUMENT_VIEWS} />
      <PageHeaderBar
        icon={Package}
        title="Work Packages"
        subtitle={
          <>
            A job&apos;s document set with revisions pinned at assembly. If any drawing advances before
            the job closes, the package flags itself{staleTotal > 0 && <> — <b className="text-amber-700">{staleTotal} need attention now</b></>}.
          </>
        }
        actions={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="w-3.5 h-3.5" /> New package
          </Button>
        }
      />

      {packages === null ? (
        <div className="py-16 flex justify-center"><Spinner /></div>
      ) : packages.length === 0 ? (
        <div className="py-16 text-center">
          <Package className="w-10 h-10 mx-auto text-[var(--color-text-faint)] opacity-40 mb-3" />
          <div className="text-sm font-bold text-[var(--color-text)]">No work packages yet</div>
          <p className="text-xs text-[var(--color-text-muted)] mt-1 max-w-sm mx-auto">
            Bundle the drawings for a job — a pump swap, a tie-in, a turnaround task. The package
            watches every revision so a stale print never reaches the field.
          </p>
          <Button size="sm" className="mt-4" onClick={() => setShowCreate(true)}>
            <Plus className="w-3.5 h-3.5" /> Create the first one
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {packages.map((pkg) => {
            const stale = pkg.staleCount > 0;
            return (
              <div
                key={pkg.id}
                className={`rounded-2xl border-2 overflow-hidden transition-shadow hover:shadow-md ${
                  stale ? "border-amber-300 bg-amber-50/40" : "border-[var(--color-border)] bg-[var(--color-surface)]"
                } ${highlightId === pkg.id ? "ring-4 ring-blue-300 animate-in zoom-in-95" : ""}`}
              >
                <div className={`px-4 py-3 flex items-center gap-2 border-b ${stale ? "border-amber-200 bg-amber-100/50" : "border-[var(--color-border)]"}`}>
                  {stale
                    ? <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    : <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-black text-[var(--color-text)] truncate">{pkg.name}</div>
                    <div className="text-[10px] text-[var(--color-text-muted)]">
                      {pkg.ownerName || "—"} · {new Date(pkg.createdAt).toLocaleDateString()} · {pkg.docs.length} doc{pkg.docs.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <span className={`shrink-0 text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full ${
                    stale ? "bg-amber-500 text-white" : "bg-emerald-100 text-emerald-700"
                  }`}>
                    {stale ? `Stale · ${pkg.staleCount}` : "Fresh"}
                  </span>
                </div>

                <div className="px-3 py-2 space-y-0.5">
                  {pkg.docs.map((d) => (
                    <Link
                      key={d.id}
                      href={d.libraryId ? `/documents/${d.libraryId}?doc=${d.documentId}` : "#"}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] group"
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${d.drifted ? "bg-amber-500 animate-pulse" : "bg-emerald-400"}`} />
                      <span className="text-xs font-bold text-[var(--color-text)] group-hover:text-blue-700 truncate flex-1">{d.docLabel}</span>
                      {d.drifted ? (
                        <span className="text-[10px] font-bold text-amber-700 shrink-0">
                          pinned Rev {d.pinnedRevLabel ?? "?"} → now Rev {d.currentRev ?? "?"}
                        </span>
                      ) : (
                        <span className="text-[10px] text-[var(--color-text-faint)] shrink-0">Rev {d.pinnedRevLabel ?? "—"}</span>
                      )}
                      <ChevronRight className="w-3 h-3 text-[var(--color-text-faint)] opacity-0 group-hover:opacity-100 shrink-0" />
                    </Link>
                  ))}
                </div>

                <div className="px-3 pb-3 flex items-center gap-2">
                  {/* Print pack: cover sheet + all current drawings, stamped;
                      pins auto-refresh to match the paper. */}
                  <button
                    onClick={() => void handlePrintPack(pkg)}
                    disabled={printing === pkg.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
                    title="One PDF: cover sheet (contents + scan-before-starting QR) + every drawing at its current revision, stamped. Pins refresh to match."
                  >
                    {printing === pkg.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Printer className="w-3 h-3" />}
                    Print pack
                  </button>
                  {stale && (
                    <button
                      onClick={() => void handleRefresh(pkg)}
                      disabled={busyId === pkg.id}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-50"
                      title="Move every pin to the current revision — do this AFTER reviewing what changed"
                    >
                      {busyId === pkg.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                      Refresh pins
                    </button>
                  )}
                  <button
                    onClick={() => void handleClose(pkg)}
                    disabled={busyId === pkg.id}
                    className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                    title="Job done — stop watching"
                  >
                    <Archive className="w-3 h-3" /> Close
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* CREATE MODAL */}
      {showCreate && (
        <div className="fixed inset-0 z-[150] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in">
          <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
            <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg"><Package className="w-4 h-4 text-blue-700" /></div>
              <div className="flex-1">
                <div className="text-sm font-black text-[var(--color-text)]">New work package</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">Revisions are pinned as of right now.</div>
              </div>
              <button onClick={() => setShowCreate(false)} className="p-2 rounded-lg hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
            </div>

            <div className="p-5 space-y-4">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='Job name * — e.g. "E-204 bundle swap"'
                autoFocus
                className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none"
              />
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One-line scope (optional)"
                className="w-full px-3 py-2 border border-[var(--color-border)] rounded-lg text-xs focus:ring-2 focus:ring-blue-500 outline-none"
              />

              <div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search drawings by number or title…"
                    className="w-full pl-8 pr-3 py-2 border border-[var(--color-border)] rounded-lg text-xs focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                {results.length > 0 && (
                  <div className="mt-1 border border-[var(--color-border)] rounded-lg overflow-hidden divide-y divide-[var(--color-border)]">
                    {results.filter((r) => !picked.some((p) => p.id === r.id)).map((r) => (
                      <button
                        key={r.id}
                        onClick={() => { setPicked((prev) => [...prev, r]); setQuery(""); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-blue-50 text-xs"
                      >
                        <Plus className="w-3 h-3 text-blue-500" />
                        <span className="font-bold text-[var(--color-text)]">{r.label}</span>
                        <span className="ml-auto text-[10px] text-[var(--color-text-faint)]">Rev {r.rev ?? "—"}</span>
                      </button>
                    ))}
                  </div>
                )}
                {picked.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {picked.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[var(--color-surface-2)] text-xs">
                        <span className="font-bold text-[var(--color-text)] flex-1 truncate">{p.label}</span>
                        <span className="text-[10px] text-[var(--color-text-faint)]">pins Rev {p.rev ?? "—"}</span>
                        <button onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))} className="p-0.5 rounded hover:bg-[var(--color-surface)]">
                          <X className="w-3 h-3 text-[var(--color-text-faint)]" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="px-5 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex justify-end gap-2">
              <button onClick={() => setShowCreate(false)} className="px-3 py-2 rounded-lg text-xs font-bold border border-[var(--color-border)]">Cancel</button>
              <button
                onClick={() => void handleCreate()}
                disabled={creating || !name.trim() || picked.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
              >
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Package className="w-3.5 h-3.5" />}
                Create & start watching
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
