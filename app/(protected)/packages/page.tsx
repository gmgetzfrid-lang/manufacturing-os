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
  Package, Plus, X, Loader2, AlertTriangle,
  RefreshCw, Search, ChevronRight, Archive, Printer,
} from "lucide-react";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { StatusTag, humanDate } from "@/components/documents/StatusTag";
import MoreMenu from "@/components/ui/MoreMenu";
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
  // Which packages show their drawings. Packages with a drawing that moved
  // on start open; the rest start folded.
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [closedIds, setClosedIds] = useState<Set<string>>(new Set());

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
    ? "Check what changed, then refresh the pins before the work starts."
    : "A job's drawings, pinned at their revisions. You're told when one moves on.";
  const driftedDocs = (packages ?? []).reduce((n, p) => n + p.staleCount, 0);
  const answerFacts = nPk === 0 ? undefined : [
    { label: "Open", value: nPk.toLocaleString() },
    { label: "Moved on", value: driftedDocs.toLocaleString(), tone: driftedDocs > 0 ? "warn" as const : undefined },
    { label: "Pinned", value: (packages ?? []).reduce((n, p) => n + p.docs.length, 0).toLocaleString() },
  ];

  return (
    <PageShell width="work">
      <PageHero
        kicker="Document control"
        title={answer}
        sub={answerSub}
        facts={answerFacts}
        primary={
          <button type="button" onClick={() => setShowCreate(true)} className={heroPrimary}>
            <Plus className="w-4 h-4" /> New package
          </button>
        }
      >
        <ViewTabs tabs={DOCUMENT_VIEWS} />
      </PageHero>

      <PageBody>
      {loadErr && (
        <Card>
          <p role="alert" className="text-[15px] font-semibold text-[var(--state-overdue)]">Couldn&apos;t load the packages: {loadErr}</p>
        </Card>
      )}
      {packages === null ? (
        <Card><LoadingBlock what="the work packages" rows={4} /></Card>
      ) : packages.length === 0 ? (
        loadErr ? null : (
        <Card>
          <p className="flex items-center gap-2.5 text-[15px] text-[var(--color-text-muted)]">
            <span className="ui-icon-tile" aria-hidden><Package className="w-5 h-5" /></span>
            No packages yet. Use New package to bundle the drawings for a job.
          </p>
        </Card>
        )
      ) : (
        <section>
          <h2 className="flex items-center gap-2.5 font-display text-[19px] leading-tight font-semibold text-[var(--color-heading)] mb-2.5">
            <span className="ui-icon-tile is-sm is-solid" aria-hidden><Package className="w-4 h-4" /></span>
            Open packages <span className="ui-count is-solid font-sans">{packages.length}</span>
          </h2>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            <table className="w-full text-[15px]">
              <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left max-md:hidden">
                <tr>
                  <th className="font-semibold px-4 h-10">Package</th>
                  <th className="font-semibold px-4 hidden lg:table-cell">Owner</th>
                  <th className="font-semibold px-4 w-28">Made</th>
                  <th className="font-semibold px-4 text-right w-28">Drawings</th>
                  <th className="font-semibold px-4 w-40">State</th>
                  <th className="w-[17rem]"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
          {packages.map((pkg) => {
            const stale = pkg.staleCount > 0;
            const open = openIds.has(pkg.id) || (stale && !closedIds.has(pkg.id));
            const toggle = () => {
              if (open) { setOpenIds((s) => { const n = new Set(s); n.delete(pkg.id); return n; }); setClosedIds((s) => new Set(s).add(pkg.id)); }
              else { setOpenIds((s) => new Set(s).add(pkg.id)); setClosedIds((s) => { const n = new Set(s); n.delete(pkg.id); return n; }); }
            };
            const small = "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors";
            return (
              <tbody key={pkg.id} data-package-id={pkg.id} className={`border-t border-[var(--color-border)] first-of-type:border-t-0 scroll-mt-24 ${highlightId === pkg.id ? "bg-[var(--color-accent-soft)]" : ""}`}>
                <tr className="hover:bg-[var(--color-surface-2)] max-md:block max-md:relative">
                  <td className="px-4 pt-3 md:py-3 relative max-md:block max-md:pr-12">
                    {(stale || highlightId === pkg.id) && <span aria-hidden className={`absolute left-0 inset-y-0 w-[3px] ${stale ? "bg-[var(--state-held)]" : "bg-[var(--color-main)]"}`} />}
                    <button type="button" onClick={toggle} aria-expanded={open}
                      className="inline-flex items-center gap-1.5 text-left font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">
                      <ChevronRight className={`w-4 h-4 shrink-0 text-[var(--color-main)] transition-transform ${open ? "rotate-90" : ""}`} />
                      {pkg.name}
                    </button>
                    {pkg.description && <div className="pl-[22px] text-[13px] text-[var(--color-text-muted)] truncate max-w-[60ch]">{pkg.description}</div>}
                    {/* Phone: the facts under the name. */}
                    <div className="md:hidden pl-[22px] mt-0.5 flex flex-wrap gap-x-3 text-[13px] text-[var(--color-text-muted)]">
                      <span className="inline-flex items-center gap-1"><span className="ui-count !h-5 !text-[12px]">{pkg.docs.length}</span> drawing{pkg.docs.length === 1 ? "" : "s"}</span>
                      <span>{humanDate(pkg.createdAt)}</span>
                      <StatusTag tone={stale ? "warn" : "good"}>{stale ? `${pkg.staleCount} moved on` : "Current"}</StatusTag>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[14px] hidden lg:table-cell">{pkg.ownerName || "-"}</td>
                  <td className="px-4 py-3 text-[14px] whitespace-nowrap max-md:hidden">{humanDate(pkg.createdAt)}</td>
                  <td className="px-4 py-3 text-right max-md:hidden"><span className="ui-count">{pkg.docs.length}</span></td>
                  <td className="px-4 py-3 max-md:hidden">
                    <StatusTag tone={stale ? "warn" : "good"}>{stale ? `${pkg.staleCount} moved on` : "Current"}</StatusTag>
                  </td>
                  <td className="px-3 pb-3 md:py-3 max-md:block max-md:pl-[38px]">
                    <div className="flex items-center gap-1.5 md:justify-end flex-wrap">
                      {/* Print pack: cover sheet + all current drawings, stamped;
                          pins auto-refresh to match the paper. */}
                      <button
                        type="button"
                        onClick={() => void handlePrintPack(pkg)}
                        disabled={printing === pkg.id}
                        className={small}
                        title="One PDF: a cover sheet with a scan code, then every drawing at its current revision, stamped. The pins move to match."
                      >
                        {printing === pkg.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5 text-[var(--color-main)]" />}
                        Print pack
                      </button>
                      {stale && (
                        <button
                          type="button"
                          onClick={() => void handleRefresh(pkg)}
                          disabled={busyId === pkg.id}
                          className={small}
                          title="Move every pin to the current revision. Check what changed first."
                        >
                          {busyId === pkg.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 text-[var(--color-main)]" />}
                          Refresh pins
                        </button>
                      )}
                      <MoreMenu
                        iconOnly
                        label={`More for ${pkg.name}`}
                        triggerClass="inline-grid place-items-center w-8 h-8 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                        items={[{ icon: <Archive className="w-4 h-4" />, label: busyId === pkg.id ? "Closing…" : "Close package (job done)", onClick: () => { if (busyId !== pkg.id) void handleClose(pkg); } }]}
                      />
                    </div>
                  </td>
                </tr>
                {open && pkg.docs.map((d) => (
                  <tr key={d.id} className="bg-[var(--color-surface-2)]/50 hover:bg-[var(--color-surface-2)] max-md:block">
                    <td colSpan={6} className="pl-[38px] pr-4 py-2 border-t border-[var(--color-border)] max-md:block">
                      <Link
                        href={d.libraryId ? `/documents/${d.libraryId}?doc=${d.documentId}` : "#"}
                        className="flex items-center gap-3 group"
                      >
                        <span className="ui-id text-[15px] group-hover:underline underline-offset-2 truncate min-w-0">{d.docLabel}</span>
                        {d.drifted ? (
                          <span className="ui-pill is-warn shrink-0">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            Pinned Rev {d.pinnedRevLabel ?? "?"}, now Rev {d.currentRev ?? "?"}
                          </span>
                        ) : (
                          <span className="ui-pill is-good shrink-0">Rev {d.pinnedRevLabel ?? "-"}</span>
                        )}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            );
          })}
            </table>
          </div>
        </section>
      )}
      </PageBody>

      {/* CREATE MODAL */}
      {showCreate && (
        <div className="fixed inset-0 z-[150] bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] flex items-center justify-center p-4 animate-in fade-in" role="dialog" aria-modal="true" aria-label="New work package">
          <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
            <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
              <div className="flex-1">
                <h2 className="font-display text-[19px] font-semibold text-[var(--color-text)]">New work package</h2>
                <div className="text-[13px] text-[var(--color-text-muted)]">Revisions are pinned as of right now.</div>
              </div>
              <button aria-label="Close" onClick={() => setShowCreate(false)} className="w-9 h-9 grid place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
            </div>

            <div className="p-5 space-y-4">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='Job name * (e.g. "E-204 bundle swap")'
                autoFocus
                className="w-full h-10 px-3 border border-[var(--color-border-strong)] rounded-md text-base sm:text-[15px] bg-[var(--color-surface)] text-[var(--color-text)] focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 outline-none"
              />
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One-line scope (optional)"
                className="w-full h-10 px-3 border border-[var(--color-border-strong)] rounded-md text-base sm:text-[15px] bg-[var(--color-surface)] text-[var(--color-text)] focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 outline-none"
              />

              <div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search drawings by number or title…"
                    className="w-full h-10 pl-8 pr-3 border border-[var(--color-border-strong)] rounded-md text-base sm:text-[15px] bg-[var(--color-surface)] text-[var(--color-text)] focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40 outline-none"
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
                        <Plus className="w-3 h-3 text-[var(--color-main)]" />
                        <span className="ui-id text-[15px]">{r.label}</span>
                        <span className="ml-auto ui-pill !h-5 !px-2 !text-[12px]">Rev {r.rev ?? "-"}</span>
                      </button>
                    ))}
                  </div>
                )}
                {picked.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {picked.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-surface-2)] text-[13px]">
                        <span className="ui-id text-[15px] flex-1 truncate">{p.label}</span>
                        <span className="ui-pill !h-5 !px-2 !text-[12px]">Pins Rev {p.rev ?? "-"}</span>
                        <button aria-label={`Remove ${p.label}`} onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))} className="w-7 h-7 grid place-items-center rounded text-[var(--color-text-muted)] hover:text-[var(--state-overdue)] hover:bg-[var(--color-surface)]">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="px-5 py-3 border-t border-[var(--color-border)] flex justify-end gap-2">
              <button onClick={() => setShowCreate(false)} className={`${heroQuiet} !h-10`}>Cancel</button>
              <button
                onClick={() => void handleCreate()}
                disabled={creating || !name.trim() || picked.length === 0}
                className={heroPrimary}
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
