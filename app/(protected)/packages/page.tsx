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
  Plus, X, Loader2,
  RefreshCw, Search, ChevronRight, Archive, Printer,
} from "lucide-react";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary } from "@/components/ui/PageHero";
import { StatusTag, humanDate } from "@/components/documents/StatusTag";
import MoreMenu from "@/components/ui/MoreMenu";
import { SkeletonRows } from "@/components/ui/Skeleton";
import ErrorNote from "@/components/ui/ErrorNote";
import { Button } from "@/components/ui/Button";
import { field as kitField, label as kitLabel } from "@/components/admin/kit";
import { friendlyError } from "@/lib/friendlyError";
import { useEscapeClose } from "@/components/documents/useEscapeClose";
import { useDraft } from "@/hooks/useDraft";
import DocViewTabs from "@/components/documents/DocViewTabs";
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
      setLoadErr(friendlyError(e));
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
      showToast({ type: "error", title: "Couldn't create package", message: friendlyError(e) });
    } finally {
      setCreating(false);
    }
  };

  const handleRefresh = async (pkg: WorkPackage) => {
    const moving = pkg.staleCount;
    const ok = await appConfirm({
      title: "Refresh this pack's pins?",
      message: moving > 0
        ? `${moving} drawing${moving === 1 ? "" : "s"} will move to the current revision. Review what changed first if you haven't. Then re-print the pack so the paper matches.`
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
      showToast({ type: "error", title: "Refresh failed", message: friendlyError(e) });
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
      showToast({ type: "error", title: "Close failed", message: friendlyError(e) });
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
      showToast({ type: "error", title: "Couldn't print the pack", message: friendlyError(e) });
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
    // None moved on is already the title ("all current"): no "0" cell (B7).
    ...(driftedDocs > 0 ? [{ label: "Drawings that moved on", value: driftedDocs.toLocaleString(), tone: "warn" as const, hero: true }] : []),
    { label: "Open packages", value: nPk.toLocaleString() },
    { label: "Pinned", value: (packages ?? []).reduce((n, p) => n + p.docs.length, 0).toLocaleString() },
  ];

  return (
    <PageShell width="work">
      <PageHero
        kicker="Document control"
        title={answer}
        sub={answerSub}
        facts={answerFacts}
        factsHero={driftedDocs > 0 ? "auto" : "none"}
        primary={
          <button type="button" onClick={() => setShowCreate(true)} className={heroPrimary}>
            <Plus className="w-4 h-4" /> New package
          </button>
        }
      >
        <DocViewTabs />
      </PageHero>

      <PageBody>
      {loadErr && (
        <ErrorNote error={loadErr} title="The packages didn't load." onRetry={() => void load()} />
      )}
      {packages === null ? (
        loadErr ? null : <SkeletonRows rows={3} cols={3} what="work packages" />
      ) : packages.length === 0 ? (
        loadErr ? null : (
        <Card>
          <p className="text-reading text-[var(--color-text)]">
            No packages yet. A package pins a job&apos;s drawings at their revisions and tells you when one moves on.
          </p>
        </Card>
        )
      ) : (
        <section>
          <h2 className="flex items-baseline gap-2 font-display text-section leading-tight font-semibold text-[var(--color-heading)] mb-3">
            Open packages <span className="font-sans text-body font-normal tabular-nums text-[var(--color-text-muted)]">{packages.length}</span>
          </h2>
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            <table className="w-full text-body">
              <thead className="text-body text-[var(--color-text-muted)] text-left max-md:hidden border-b border-[var(--color-border)]">
                <tr>
                  <th className="font-medium px-4 h-10">Package</th>
                  <th className="font-medium px-4 hidden lg:table-cell">Owner</th>
                  <th className="font-medium px-4 w-28">Made</th>
                  <th className="font-medium px-4 text-right w-28">Drawings</th>
                  <th className="font-medium px-4 w-40">State</th>
                  <th className="w-48"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
          {packages.map((pkg) => {
            const stale = pkg.staleCount > 0;
            const open = openIds.has(pkg.id) || (stale && !closedIds.has(pkg.id));
            const toggle = () => {
              if (open) { setOpenIds((s) => { const n = new Set(s); n.delete(pkg.id); return n; }); setClosedIds((s) => new Set(s).add(pkg.id)); }
              else { setOpenIds((s) => new Set(s).add(pkg.id)); setClosedIds((s) => { const n = new Set(s); n.delete(pkg.id); return n; }); }
            };
            const small = "inline-flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-2.5 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-body font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 transition-colors";
            return (
              <tbody key={pkg.id} data-package-id={pkg.id} className={`border-t border-[var(--color-border)] first-of-type:border-t-0 scroll-mt-24 ${highlightId === pkg.id ? "bg-[var(--color-accent-soft)]" : ""}`}>
                <tr className="hover:bg-[var(--color-surface-2)] max-md:block max-md:relative">
                  <td className="px-4 pt-3 md:py-3 relative max-md:block max-md:pr-12">
                    {(stale || highlightId === pkg.id) && <span aria-hidden className={`absolute left-0 inset-y-0 w-[3px] ${stale ? "bg-[var(--state-held)]" : "bg-[var(--color-main)]"}`} />}
                    <button type="button" onClick={toggle} aria-expanded={open}
                      className="inline-flex items-center gap-1.5 pointer-coarse:py-2.5 pointer-coarse:-my-2.5 text-left text-reading font-medium text-[var(--color-text)] hover:text-[var(--color-accent-text)]">
                      <ChevronRight aria-hidden className={`ui-chevron w-4 h-4 shrink-0 text-[var(--color-text-muted)] ${open ? "rotate-90" : ""}`} />
                      {pkg.name}
                    </button>
                    {pkg.description && <div className="pl-[22px] text-body text-[var(--color-text-muted)] truncate max-w-[60ch]">{pkg.description}</div>}
                    {/* Phone: the facts under the name. */}
                    <div className="md:hidden pl-[22px] mt-0.5 flex flex-wrap gap-x-3 text-body text-[var(--color-text-muted)]">
                      <span className="tabular-nums">{pkg.docs.length} drawing{pkg.docs.length === 1 ? "" : "s"}</span>
                      <span>{humanDate(pkg.createdAt)}</span>
                      <StatusTag tone={stale ? "warn" : "good"}>{stale ? `${pkg.staleCount} moved on` : "Current"}</StatusTag>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-body hidden lg:table-cell">{pkg.ownerName || "-"}</td>
                  <td className="px-4 py-3 text-body whitespace-nowrap max-md:hidden">{humanDate(pkg.createdAt)}</td>
                  <td className="px-4 py-3 text-right max-md:hidden tabular-nums text-[var(--color-text)]">{pkg.docs.length}</td>
                  <td className="px-4 py-3 max-md:hidden">
                    <StatusTag tone={stale ? "warn" : "good"}>{stale ? `${pkg.staleCount} moved on` : "Current"}</StatusTag>
                  </td>
                  <td className="px-3 pb-3 md:py-3 max-md:block max-md:pl-[38px]">
                    <div className="flex items-center gap-1.5 md:justify-end flex-wrap">
                      {/* Print pack: cover sheet + all current drawings, stamped;
                          pins auto-refresh to match the paper. */}
                      {!stale && (
                        <button
                          type="button"
                          onClick={() => void handlePrintPack(pkg)}
                          disabled={printing === pkg.id}
                          className={small}
                          title="One PDF: a cover sheet with a scan code, then every drawing at its current revision, stamped. The pins move to match."
                        >
                          {printing === pkg.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />}
                          Print pack
                        </button>
                      )}
                      {stale && (
                        <button
                          type="button"
                          onClick={() => void handleRefresh(pkg)}
                          disabled={busyId === pkg.id}
                          className={small}
                          title="Move every pin to the current revision. Check what changed first."
                        >
                          {busyId === pkg.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />}
                          Refresh pins
                        </button>
                      )}
                      <MoreMenu
                        iconOnly
                        label={`More for ${pkg.name}`}
                        triggerClass="inline-grid place-items-center w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                        items={[
                          ...(stale ? [{ icon: <Printer className="w-4 h-4" />, label: printing === pkg.id ? "Printing…" : "Print pack", onClick: () => { if (printing !== pkg.id) void handlePrintPack(pkg); } }] : []),
                          { icon: <Archive className="w-4 h-4" />, label: busyId === pkg.id ? "Closing…" : "Close package (job done)", line: stale, onClick: () => { if (busyId !== pkg.id) void handleClose(pkg); } },
                        ]}
                      />
                    </div>
                  </td>
                </tr>
                {open && pkg.docs.map((d) => (
                  <tr key={d.id} className="hover:bg-[var(--color-surface-2)] max-md:block">
                    <td colSpan={6} className="pl-[38px] pr-4 py-2 pointer-coarse:py-0 border-t border-[var(--color-border)] max-md:block">
                      <Link
                        href={d.libraryId ? `/documents/${d.libraryId}?doc=${d.documentId}` : "#"}
                        className="flex items-center gap-3 pointer-coarse:min-h-11 group"
                      >
                        <span className="ui-id text-reading group-hover:underline underline-offset-2 truncate min-w-0">{d.docLabel}</span>
                        {d.drifted ? (
                          <span className="ui-pill is-warn shrink-0">
                            Pinned rev {d.pinnedRevLabel ?? "?"}, now rev {d.currentRev ?? "?"}
                          </span>
                        ) : (
                          <span className="ui-pill is-muted shrink-0">Rev {d.pinnedRevLabel ?? "-"}, current</span>
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
          <div className="ui-float ui-float-in w-full max-w-lg bg-[var(--color-surface)] rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
              <div className="flex-1">
                <h2 className="font-display text-section font-semibold text-[var(--color-heading)]">New work package</h2>
                <div className="text-body text-[var(--color-text-muted)]">Revisions are pinned as of right now.</div>
              </div>
              <button aria-label="Close" onClick={() => setShowCreate(false)} className="ui-hit w-10 h-10 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><X className="w-5 h-5" /></button>
            </div>

            <div className="p-5 space-y-4">
              <label className="block">
                <span className={kitLabel}>Job name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="E-204 bundle swap"
                  autoFocus
                  required
                  className={kitField}
                />
              </label>
              <label className="block">
                <span className={kitLabel}>Scope <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></span>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Pull and replace the tube bundle"
                  className={kitField}
                />
              </label>

              <div>
                <label htmlFor="pkg-find" className={kitLabel}>Drawings</label>
                <div className="relative">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)] pointer-events-none" />
                  <input type="search"
                    id="pkg-find"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by number or title"
                    className={`${kitField} !pl-9`}
                  />
                </div>
                {results.length > 0 && (
                  <div className="mt-1 border border-[var(--color-border)] rounded-lg overflow-hidden divide-y divide-[var(--color-border)]">
                    {results.filter((r) => !picked.some((p) => p.id === r.id)).map((r) => (
                      <button
                        key={r.id}
                        onClick={() => { setPicked((prev) => [...prev, r]); setQuery(""); }}
                        className="w-full flex items-center gap-2 px-3 min-h-11 text-left hover:bg-[var(--color-surface-2)] text-body"
                      >
                        <Plus className="w-4 h-4 text-[var(--color-text-faint)]" />
                        <span className="ui-id text-reading">{r.label}</span>
                        <span className="ml-auto text-body text-[var(--color-text-muted)]">Rev <span className="ui-id text-[var(--color-text)]">{r.rev ?? "-"}</span></span>
                      </button>
                    ))}
                  </div>
                )}
                {picked.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {picked.map((p) => (
                      <div key={p.id} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-body">
                        <span className="ui-id text-reading flex-1 truncate">{p.label}</span>
                        <span className="text-body text-[var(--color-text-muted)]">Pins rev <span className="ui-id text-[var(--color-text)]">{p.rev ?? "-"}</span></span>
                        <button aria-label={`Remove ${p.label}`} onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))} className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--state-overdue-text)] hover:bg-[var(--color-surface-2)]">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="px-5 py-3 border-t border-[var(--color-border)] flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
              {/* Why the main button waits, said where it waits. */}
              {(!name.trim() || picked.length === 0) && (
                <span className="mr-auto text-body text-[var(--color-text-muted)]">
                  {!name.trim() ? "Name the job" : "Add at least one drawing"} to make the package.
                </span>
              )}
              <Button variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button
                onClick={() => void handleCreate()}
                disabled={!name.trim() || picked.length === 0}
                loading={creating}
              >
                Make the package
              </Button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
