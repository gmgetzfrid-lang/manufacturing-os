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
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary } from "@/components/ui/PageHero";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { useEscapeClose } from "@/components/documents/useEscapeClose";
import { useDraft } from "@/hooks/useDraft";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { useRole } from "@/components/providers/RoleContext";
import { appConfirm } from "@/components/providers/DialogProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { supabase } from "@/lib/supabase";
import { orIlike } from "@/lib/orFilter";
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
  const linkedId = useSearchParams().get("pkg");
  // A package just made is shown the same way: outlined and scrolled to.
  const [justMade, setJustMade] = useState<string | null>(null);
  const highlightId = justMade ?? linkedId;
  const [loadErr, setLoadErr] = useState<string | null>(null);

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
  // The one-line scope is kept on this device until the package is made.
  useDraft<string>(showCreate && activeOrgId ? `package-new:${activeOrgId}` : null, description, setDescription, (v) => !v.trim());
  useEscapeClose(() => setShowCreate(false), showCreate);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      setPackages(await listWorkPackages(activeOrgId));
      setLoadErr(null);
    } catch (e) {
      setLoadErr((e as Error).message || "try again");
      setPackages((prev) => prev ?? []);
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (!highlightId || !packages) return;
    const el = document.querySelector(`[data-package-id="${CSS.escape(highlightId)}"]`);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, [highlightId, packages]);

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
        .or(orIlike(["document_number", "title"], query))
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
      const newId = await createWorkPackage({
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
      setJustMade(newId);
      showToast({ type: "success", title: "Package made", message: "Revisions are pinned. You'll be told when any drawing moves on." });
    } catch (e) {
      showToast({ type: "error", title: "Couldn't create package", message: (e as Error).message });
    } finally {
      setCreating(false);
    }
  };

  const handleRefresh = async (pkg: WorkPackage) => {
    const moving = pkg.staleCount;
    const ok = await appConfirm({
      title: "Refresh this pack's pins?",
      message: moving > 0
        ? `${moving} drawing${moving === 1 ? "" : "s"} will move to the current revision. Review what changed first if you haven't - then re-print the pack so the paper matches.`
        : "Every pin will be re-checked against the current revisions.",
      confirmLabel: "Refresh pins",
    });
    if (!ok) return;
    setBusyId(pkg.id);
    try {
      await refreshWorkPackage(pkg.id);
      await load();
      showToast({ type: "success", title: "Package refreshed", message: "All pins moved to the current revisions. Re-print the pack." });
    } catch (e) {
      showToast({ type: "error", title: "Refresh failed", message: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  const handleClose = async (pkg: WorkPackage) => {
    const ok = await appConfirm({
      title: `Close "${pkg.name}"?`,
      message: "A closed package stops watching its drawings and disappears from this list. Its record is kept.",
      confirmLabel: "Close package",
    });
    if (!ok) return;
    setBusyId(pkg.id);
    try {
      await setWorkPackageStatus(pkg.id, "closed", userEmail?.split("@")[0]);
      await load();
      showToast({ type: "success", title: "Package closed", message: `"${pkg.name}" is closed and no longer watching its drawings.` });
    } catch (e) {
      showToast({ type: "error", title: "Close failed", message: (e as Error).message });
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

  // The answer: is every job's pack still current?
  const nPk = packages?.length ?? 0;
  const answer = packages === null ? (loadErr ? "Packages didn't load." : "Work packages")
    : nPk === 0 ? (loadErr ? "Packages didn't load." : "No work packages yet.")
    : staleTotal > 0 ? `${staleTotal} package${staleTotal === 1 ? " has" : "s have"} a drawing that moved on.`
    : `${nPk} package${nPk === 1 ? "" : "s"}, all current.`;
  const answerSub = staleTotal > 0
    ? `${nPk} open. Check what changed, then refresh the pins before the work starts.`
    : "A job's drawings, pinned at their revisions. You're told when one moves on.";

  return (
    <PageShell width="work">
      <PageHero
        kicker="Document control · Work packages"
        title={answer}
        sub={answerSub}
        primary={
          <button type="button" onClick={() => setShowCreate(true)} className={heroPrimary}>
            <Plus className="w-4 h-4" /> New package
          </button>
        }
      >
        <ViewTabs tabs={DOCUMENT_VIEWS} variant="dark" />
      </PageHero>

      <PageBody>
      {loadErr && (
        <Card>
          <p role="alert" className="text-[14px] text-rose-700 dark:text-rose-300">Couldn&apos;t load the packages: {loadErr}</p>
        </Card>
      )}
      {packages === null ? (
        <Card><LoadingBlock what="the work packages" rows={4} /></Card>
      ) : packages.length === 0 ? (
        loadErr ? null : (
        <Card>
          <div className="py-8 text-center">
            <Package className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-3" />
            <p className="text-[14px] text-[var(--color-text-muted)] max-w-sm mx-auto">
              A package holds the drawings for one job at the revisions they were when you made it. Use New package to bundle the first one.
            </p>
          </div>
        </Card>
        )
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {packages.map((pkg) => {
            const stale = pkg.staleCount > 0;
            return (
              <div
                key={pkg.id}
                data-package-id={pkg.id}
                className={`rounded-2xl overflow-hidden bg-[var(--color-surface)] shadow-[var(--shadow-card)] scroll-mt-24 ${
                  highlightId === pkg.id ? "ring-2 ring-[var(--color-text)]" : ""
                }`}
              >
                <div className="px-4 sm:px-5 py-3.5 flex items-center gap-2.5 border-b border-[var(--color-border)]">
                  {stale
                    ? <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                    : <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[14px] font-bold text-[var(--color-text)] truncate">{pkg.name}</h2>
                    <div className="text-[12px] text-[var(--color-text-muted)]">
                      {pkg.ownerName || "-"} · {new Date(pkg.createdAt).toLocaleDateString()} · {pkg.docs.length} doc{pkg.docs.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <span className={`shrink-0 text-[12px] font-bold ${
                    stale ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"
                  }`}>
                    {stale ? `${pkg.staleCount} moved on` : "Current"}
                  </span>
                </div>

                <div className="px-2 sm:px-3 py-2 space-y-0.5">
                  {pkg.docs.map((d) => (
                    <Link
                      key={d.id}
                      href={d.libraryId ? `/documents/${d.libraryId}?doc=${d.documentId}` : "#"}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--color-surface-2)] group"
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${d.drifted ? "bg-amber-500" : "bg-[var(--color-border-strong)]"}`} />
                      <span className="text-[13px] font-semibold text-[var(--color-text)] truncate flex-1">{d.docLabel}</span>
                      {d.drifted ? (
                        <span className="text-[12px] font-bold text-amber-700 dark:text-amber-400 shrink-0">
                          pinned Rev {d.pinnedRevLabel ?? "?"}, now Rev {d.currentRev ?? "?"}
                        </span>
                      ) : (
                        <span className="text-[12px] text-[var(--color-text-muted)] shrink-0">Rev {d.pinnedRevLabel ?? "-"}</span>
                      )}
                      <ChevronRight className="w-3 h-3 text-[var(--color-text-faint)] opacity-60 sm:opacity-0 group-hover:opacity-100 shrink-0" />
                    </Link>
                  ))}
                </div>

                <div className="px-4 sm:px-5 pb-4 pt-1 flex items-center gap-2">
                  {/* Print pack: cover sheet + all current drawings, stamped;
                      pins auto-refresh to match the paper. */}
                  <button
                    onClick={() => void handlePrintPack(pkg)}
                    disabled={printing === pkg.id}
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] text-[13px] font-semibold border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                    title="One PDF: a cover sheet with a scan code, then every drawing at its current revision, stamped. The pins move to match."
                  >
                    {printing === pkg.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
                    Print pack
                  </button>
                  {stale && (
                    <button
                      onClick={() => void handleRefresh(pkg)}
                      disabled={busyId === pkg.id}
                      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] text-[13px] font-semibold border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                      title="Move every pin to the current revision. Check what changed first."
                    >
                      {busyId === pkg.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      Refresh pins
                    </button>
                  )}
                  <button
                    onClick={() => void handleClose(pkg)}
                    disabled={busyId === pkg.id}
                    className="ml-auto inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] text-[13px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"
                    title="Job done: stop watching"
                  >
                    <Archive className="w-3.5 h-3.5" /> Close
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </PageBody>

      {/* CREATE MODAL */}
      {showCreate && (
        <div className="fixed inset-0 z-[150] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] flex items-center justify-center p-4 animate-in fade-in" role="dialog" aria-modal="true" aria-label="New work package">
          <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
            <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
              <div className="p-2 bg-[var(--color-surface-2)] rounded-lg"><Package className="w-4 h-4 text-[var(--color-text-muted)]" /></div>
              <div className="flex-1">
                <h2 className="text-[15px] font-extrabold text-[var(--color-text)]">New work package</h2>
                <div className="text-[13px] text-[var(--color-text-muted)]">Revisions are pinned as of right now.</div>
              </div>
              <button aria-label="Close" onClick={() => setShowCreate(false)} className="p-2 rounded-lg hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
            </div>

            <div className="p-5 space-y-4">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='Job name * (e.g. "E-204 bundle swap")'
                autoFocus
                className="w-full h-10 px-3 border border-[var(--color-border-strong)] rounded-[10px] text-base sm:text-[14px] focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
              />
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One-line scope (optional)"
                className="w-full h-10 px-3 border border-[var(--color-border-strong)] rounded-[10px] text-base sm:text-[14px] focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
              />

              <div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search drawings by number or title…"
                    className="w-full h-10 pl-8 pr-3 border border-[var(--color-border-strong)] rounded-[10px] text-base sm:text-[14px] focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none"
                  />
                </div>
                {results.length > 0 && (
                  <div className="mt-1 border border-[var(--color-border)] rounded-lg overflow-hidden divide-y divide-[var(--color-border)]">
                    {results.filter((r) => !picked.some((p) => p.id === r.id)).map((r) => (
                      <button
                        key={r.id}
                        onClick={() => { setPicked((prev) => [...prev, r]); setQuery(""); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-surface-2)] text-[13px]"
                      >
                        <Plus className="w-3 h-3 text-[var(--color-text-muted)]" />
                        <span className="font-bold text-[var(--color-text)]">{r.label}</span>
                        <span className="ml-auto text-[11px] text-[var(--color-text-faint)]">Rev {r.rev ?? "-"}</span>
                      </button>
                    ))}
                  </div>
                )}
                {picked.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {picked.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-surface-2)] text-[13px]">
                        <span className="font-bold text-[var(--color-text)] flex-1 truncate">{p.label}</span>
                        <span className="text-[11px] text-[var(--color-text-faint)]">pins Rev {p.rev ?? "-"}</span>
                        <button aria-label="Remove" onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))} className="p-0.5 rounded hover:bg-[var(--color-surface)]">
                          <X className="w-3 h-3 text-[var(--color-text-faint)]" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="px-5 py-3 border-t border-[var(--color-border)] flex justify-end gap-2">
              <button onClick={() => setShowCreate(false)} className="h-10 px-4 rounded-xl text-[14px] font-bold border border-[var(--color-border-strong)]">Cancel</button>
              <button
                onClick={() => void handleCreate()}
                disabled={creating || !name.trim() || picked.length === 0}
                className="inline-flex items-center gap-1.5 h-10 px-4 rounded-xl text-[14px] font-extrabold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              >
                {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Package className="w-3.5 h-3.5" />}
                Make the package
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
