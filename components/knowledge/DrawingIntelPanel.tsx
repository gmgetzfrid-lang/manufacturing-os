"use client";

// Drawing intelligence — the deterministic panel under a P&ID/drawing
// library. Everything here is COMPUTED from extracted tags, never guessed
// by a model: the equipment census by category, the drawing-reference audit
// (what resolves in-library vs what's referenced but missing), the CSV
// register export, and the "give me X and I can do more" suggestions.

import React, { useEffect, useState } from "react";
import {
  Loader2, Download, RefreshCw, ChevronRight, Lightbulb, ArrowRight, ClipboardCheck, ScanSearch,
} from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { appConfirm } from "@/components/providers/DialogProvider";
import HelpTooltip from "@/components/ui/HelpTooltip";
import MoreMenu from "@/components/ui/MoreMenu";
import { Section, tbl, sheet, btnQuiet } from "@/components/admin/kit";
import { StatusTag, type DocTone } from "@/components/documents/StatusTag";
import { Note, Cells } from "@/components/knowledge/panelKit";

/** The ⋯ trigger, ruled like a secondary button. */
const btnIconRuled = "inline-flex items-center justify-center w-9 h-9 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]";
import {
  getDrawingIntel, rebuildDrawingIndex, downloadEquipmentRegister, recordDrawingAudit,
  type DrawingIntel, type RecordedAuditSheet,
} from "@/lib/knowledge";

export default function DrawingIntelPanel({ orgId, libraryId, isController, refreshKey, onRebuilt }: {
  orgId: string;
  libraryId: string;
  isController: boolean;
  /** Bump when documents finish indexing so the panel refetches. */
  refreshKey: number;
  onRebuilt: () => void;
}) {
  const { showToast } = useToast();
  const [intel, setIntel] = useState<DrawingIntel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"rebuild" | "export" | "record" | null>(null);
  const [recorded, setRecorded] = useState<{
    recorded: number;
    counts: Partial<Record<RecordedAuditSheet["status"], number>>;
  } | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  const [showScope, setShowScope] = useState(false);
  const [showOneWay, setShowOneWay] = useState(false);
  const [showOpc, setShowOpc] = useState(false);
  const [showNoRef, setShowNoRef] = useState(false);
  const [showSheets, setShowSheets] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDrawingIntel(orgId, libraryId)
      .then((i) => { if (!cancelled) { setIntel(i); setLoadError(null); } })
      .catch((e) => { if (!cancelled) setLoadError((e as Error).message); });
    return () => { cancelled = true; };
  }, [orgId, libraryId, refreshKey]);

  // A missing migration must be VISIBLE, not a silently absent panel;
  // otherwise "why is there no census" is undiagnosable from the UI.
  if (loadError) {
    return (
      <Section label="Drawing intelligence" icon={ScanSearch}>
        <div className={`${sheet} px-4 sm:px-5 py-4`}>
          {/migration/i.test(loadError)
            ? <Note tone="warn" title="Waiting on a database migration.">{loadError}</Note>
            : <Note tone="bad" title="Couldn't load drawing intelligence.">{loadError}</Note>}
        </div>
      </Section>
    );
  }
  if (!intel) {
    return (
      <Section label="Drawing intelligence" icon={ScanSearch}>
        <div className={`${sheet} px-4 sm:px-5 py-4 text-[14px] text-[var(--color-text-muted)] flex items-center gap-2`}><Loader2 className="w-4 h-4 animate-spin" /> Loading drawing intelligence…</div>
      </Section>
    );
  }
  const { census, audit, suggestions } = intel;
  // Nothing extracted and nothing to suggest = not a drawing library; stay out
  // of the way.
  if (census.totalDistinct === 0 && audit.totalRefs === 0 && suggestions.length === 0) return null;
  // No tags and no refs = not a drawing set; the panel stays neutral (it's
  // probably a scanned prose library that needs vision indexing).
  const isDrawingSet = census.totalDistinct > 0 || audit.totalRefs > 0;
  const outOfScopeRefs = audit.outOfScope.reduce((a, o) => a + o.count, 0);

  const rebuild = async () => {
    const ok = await appConfirm({
      title: "Rebuild the index?",
      message:
        "Every document is read again from scratch: text, tags and titles. Do this after an " +
        "upgrade, or when indexing missed things. Indexing runs on this page; keep it open.",
      confirmLabel: "Rebuild",
    });
    if (!ok) return;
    setBusy("rebuild");
    try {
      const res = await rebuildDrawingIndex(orgId, libraryId);
      showToast({ type: "success", title: `${res.docs} document${res.docs === 1 ? "" : "s"} queued. Indexing starts now.` });
      onRebuilt();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  // Commit the audit. The value isn't the verdict on screen — that's already
  // here — it's the RECORD: next time somebody asks whether this sheet was
  // checked at this revision, there's an answer instead of a re-read.
  const record = async () => {
    setBusy("record");
    try {
      const res = await recordDrawingAudit(orgId, libraryId);
      setRecorded({ recorded: res.recorded, counts: res.counts });
      showToast({
        type: "success",
        title: `Audit recorded for ${res.recorded} sheet${res.recorded === 1 ? "" : "s"}.`,
      });
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const exportCsv = async () => {
    setBusy("export");
    try {
      await downloadEquipmentRegister(orgId, libraryId);
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  // The checks, one row each; a row opens its list.
  type Check = { key: string; label: string; count: number; tone: DocTone; open: boolean; toggle: () => void; body: React.ReactNode };
  const sub = "max-h-64 overflow-y-auto rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-surface)]";
  const checks: Check[] = [];
  if (audit.missingInSeries.length > 0) checks.push({
    key: "missing", label: "Sheets in this set referenced but not loaded", count: audit.missingInSeries.length, tone: "bad", open: showMissing, toggle: () => setShowMissing((v) => !v),
    body: (
      <ul className={sub}>
        {audit.missingInSeries.slice(0, 25).map((m) => (
          <li key={m.ref} className="px-3 py-1.5 text-[14px] flex items-baseline gap-3">
            <span className="font-display font-semibold tabular-nums text-[var(--color-text)] shrink-0">{m.ref}</span>
            <span className="min-w-0 truncate text-[var(--color-text-muted)]" title={m.referencedBy.join("; ")}>{m.count}× from {m.referencedBy.join("; ")}</span>
          </li>
        ))}
        {audit.missingInSeries.length > 25 && <li className="px-3 py-1.5 text-[13px] text-[var(--color-text-muted)]">And {audit.missingInSeries.length - 25} more</li>}
      </ul>
    ),
  });
  if (audit.outOfScope.length > 0) checks.push({
    key: "scope", label: `Connectors that leave this set, to ${audit.outOfScope.length} other series`, count: outOfScopeRefs, tone: "none", open: showScope, toggle: () => setShowScope((v) => !v),
    body: (
      <>
        <p className="mb-1.5 text-[13px] text-[var(--color-text-muted)]">Not broken: the set ends at its battery limits. Load a series and its connectors join the audit.</p>
        <ul className={sub}>
          {audit.outOfScope.slice(0, 20).map((o) => (
            <li key={o.series} className="px-3 py-1.5 text-[14px] grid grid-cols-[minmax(0,9rem)_1fr_auto] gap-3 items-baseline">
              <span className="min-w-0">
                <span className="block font-display font-semibold tabular-nums text-[var(--color-text)] truncate" title={o.series}>{o.series}</span>
                {o.unitName && <span className="block text-[13px] text-[var(--color-text-muted)] truncate" title={o.unitName}>{o.unitName}</span>}
              </span>
              <span className="min-w-0 truncate text-[var(--color-text-muted)]" title={o.refs.join(", ")}>{o.refs.slice(0, 6).join(", ")}{o.refs.length > 6 ? `, +${o.refs.length - 6}` : ""}</span>
              <span className="font-display font-semibold tabular-nums text-[var(--color-text)]">{o.count}×</span>
            </li>
          ))}
        </ul>
      </>
    ),
  });
  if (audit.oneWay.length > 0) checks.push({
    key: "oneway", label: "One-way connectors inside this set", count: audit.oneWay.length, tone: "warn", open: showOneWay, toggle: () => setShowOneWay((v) => !v),
    body: (
      <>
        <p className="mb-1.5 text-[13px] text-[var(--color-text-muted)]">Both sheets are loaded but the reference runs one way. Some continuation notes are; drafting misses hide here.</p>
        <ul className={sub}>
          {audit.oneWay.slice(0, 25).map((o, i) => (
            <li key={i} className="px-3 py-1.5 text-[14px] flex items-center gap-2">
              <span className="font-display font-semibold tabular-nums truncate flex-1" title={o.from}>{o.from}</span>
              <ArrowRight className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
              <span className="font-display font-semibold tabular-nums truncate flex-1" title={o.to}>{o.to}</span>
              <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{o.count}×</span>
            </li>
          ))}
        </ul>
      </>
    ),
  });
  if ((intel.opcUnreturned?.length ?? 0) > 0) checks.push({
    key: "opc", label: "Connector boxes missing on their continuation sheet", count: intel.opcUnreturned!.length, tone: "warn", open: showOpc, toggle: () => setShowOpc((v) => !v),
    body: (
      <>
        <p className="mb-1.5 text-[13px] text-[var(--color-text-muted)]">The numbered box should reappear on the sheet it points to. Box numbers come from AI-read sheets, so a misread can show up here too.</p>
        <ul className={sub}>
          {intel.opcUnreturned!.map((o, i) => (
            <li key={i} className="px-3 py-1.5 text-[14px] flex items-start gap-3">
              <span className="shrink-0 font-display font-semibold tabular-nums px-1.5 rounded border border-[var(--color-border-strong)]">{o.box}</span>
              <span className="min-w-0">
                <span className="font-display font-semibold tabular-nums">{o.from}</span> <span className="text-[var(--color-text-muted)]">to</span> <span className="font-display font-semibold tabular-nums">{o.to}</span>
                <span className="block truncate text-[13px] text-[var(--color-text-muted)]" title={o.line}>{o.line}</span>
              </span>
            </li>
          ))}
        </ul>
      </>
    ),
  });
  if ((intel.opcNoRef?.length ?? 0) > 0) checks.push({
    key: "noref", label: "Connectors with no drawing number", count: intel.opcNoRef!.length, tone: "bad", open: showNoRef, toggle: () => setShowNoRef((v) => !v),
    body: (
      <>
        <p className="mb-1.5 text-[13px] text-[var(--color-text-muted)]">An off-page connector must say which drawing it continues on. These carry a box and a stream but no drawing number: a drafting defect to fix on the sheet.</p>
        <ul className={sub}>
          {intel.opcNoRef!.map((o, i) => (
            <li key={i} className="px-3 py-1.5 text-[14px] flex items-start gap-3">
              <span className="shrink-0 font-display font-semibold tabular-nums px-1.5 rounded border border-[var(--color-border-strong)]">{o.box}</span>
              <span className="min-w-0">
                <span className="font-display font-semibold tabular-nums">{o.sheet}</span> <span className="text-[var(--color-text-muted)]">page {o.page}</span>
                <span className="block truncate text-[13px] text-[var(--color-text-muted)]" title={o.line}>{o.line}</span>
              </span>
            </li>
          ))}
        </ul>
      </>
    ),
  });
  if ((intel.sheets?.length ?? 0) > 0) checks.push({
    key: "sheets", label: "What each document produced", count: intel.sheets!.length, tone: "none", open: showSheets, toggle: () => setShowSheets((v) => !v),
    body: (
      <>
        <div className="max-h-80 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
          <table className="w-full text-[14px]">
            <thead className={`${tbl.thead} sticky top-0`}>
              <tr>
                <th className="font-semibold px-3 h-9">Document</th>
                <th className="font-semibold px-3 text-right max-sm:hidden">Pages</th>
                <th className="font-semibold px-3 text-right max-sm:hidden">Text</th>
                <th className="font-semibold px-3 text-right">Tags</th>
                <th className="font-semibold px-3">How read</th>
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {intel.sheets!.map((sh) => {
                const how: { label: string; tone: DocTone } =
                  sh.verdict === "vision" ? { label: "AI vision", tone: "good" }
                  : sh.verdict === "text" ? { label: "Text layer", tone: "good" }
                  : sh.verdict === "text-no-tags" ? { label: "Text, no tags", tone: "warn" }
                  : sh.verdict === "empty" ? { label: "Nothing read", tone: "bad" }
                  : sh.verdict === "error" ? { label: "Error", tone: "bad" }
                  : { label: "Indexing", tone: "none" };
                return (
                  <tr key={sh.id}>
                    <td className="px-3 py-1.5 max-w-0 w-1/2">
                      <div className="truncate font-semibold" title={sh.error ?? sh.name}>{sh.name}</div>
                      {(sh.gapPages?.length ?? 0) > 0 && sh.status === "ready" && (
                        // The exact pages the index knows nothing about.
                        // Without this line, a skipped page surfaces days
                        // later as "X-35 is not in the tag index" on a
                        // trace, with no visible reason anywhere.
                        <div className="truncate text-[13px] font-semibold text-[var(--state-overdue)]"
                          title={`No tags from page ${sh.gapPages!.join(", ")}: AI reading did not finish. Rebuild the index and keep this tab open until it does.`}>
                          {sh.gapPages!.length} page{sh.gapPages!.length === 1 ? "" : "s"} unread: {sh.gapPages!.slice(0, 8).join(", ")}{sh.gapPages!.length > 8 ? "…" : ""}
                        </div>
                      )}
                      {sh.declared && <div className="truncate font-display tabular-nums text-[13px] text-[var(--color-text-muted)]" title="Read from this sheet's own title block">Title block: {sh.declared}</div>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[var(--color-text-muted)] max-sm:hidden">{sh.pagesIndexed}{sh.pages ? `/${sh.pages}` : ""}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-[var(--color-text-muted)] max-sm:hidden">{sh.chars >= 1000 ? `${Math.round(sh.chars / 1000)}k` : sh.chars}</td>
                    <td className={`px-3 py-1.5 text-right font-display font-semibold tabular-nums ${sh.tags > 0 ? "text-[var(--color-text)]" : "text-[var(--state-overdue)]"}`}>{sh.tags}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap"><StatusTag tone={how.tone}>{how.label}</StatusTag></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[13px] text-[var(--color-text-muted)]">
          Text, no tags on an AutoCAD export usually means SHX fonts. Turn on reading every page with AI vision in Library AI setup and rebuild.
        </p>
      </>
    ),
  });

  return (
    <Section
      icon={ScanSearch}
      label={<span className="inline-flex items-center gap-2">{isDrawingSet ? "Drawing intelligence" : "What indexing got out of these documents"}
        {isDrawingSet && <span className="font-sans font-normal text-[14px] leading-snug"><HelpTooltip>Counted from every sheet&apos;s extracted tags, not guessed by AI: the equipment census, the cross-reference audit and the register export.</HelpTooltip></span>}
      </span>}
      action={(census.totalDistinct > 0 || isController) ? (
        <div className="flex items-center gap-2">
          {census.totalDistinct > 0 && (
            <button type="button" className={btnQuiet} onClick={() => void exportCsv()} disabled={busy !== null}>
              {busy === "export" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              <span className="max-sm:hidden">Equipment register (CSV)</span><span className="sm:hidden">Register</span>
            </button>
          )}
          {isController && isDrawingSet && (
            <button type="button" className={btnQuiet} onClick={() => void record()} disabled={busy !== null}>
              {busy === "record" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardCheck className="w-4 h-4" />}
              Record audit
            </button>
          )}
          {isController && (
            <MoreMenu iconOnly label="More drawing actions" triggerClass={btnIconRuled} items={[
              { icon: busy === "rebuild" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />, label: "Rebuild the index", onClick: () => { if (busy === null) void rebuild(); } },
            ]} />
          )}
        </div>
      ) : undefined}
    >
      <div className={`${sheet} overflow-hidden`}>
        {isDrawingSet && (
          <Cells cells={[
            { label: "Sheets", value: intel.sheetCount.toLocaleString() },
            { label: "Equipment tags", value: census.totalDistinct.toLocaleString() },
            { label: "References resolved", value: <>{audit.resolved.toLocaleString()}<span className="text-[var(--color-text-muted)] font-medium text-[18px]"> of {audit.totalRefs.toLocaleString()}</span></> },
            audit.missingInSeries.length > 0
              ? { label: "Missing sheets", value: audit.missingInSeries.length.toLocaleString(), tone: "bad" as const }
              : { label: "Point to other units", value: outOfScopeRefs.toLocaleString(), hint: audit.outOfScope.length ? audit.outOfScope.slice(0, 3).map((o) => o.series).join(", ") : undefined },
          ]} />
        )}

        {recorded && (
          <div className="border-t border-[var(--color-border)] px-4 sm:px-5 py-3">
            <Note tone="good" title={`Audit recorded for ${recorded.recorded} sheet${recorded.recorded === 1 ? "" : "s"}.`}>
              {(["passed", "flagged", "broken_connectors", "skipped"] as const)
                .filter((k) => (recorded.counts[k] ?? 0) > 0)
                .map((k) => `${recorded.counts[k]} ${k.replace(/_/g, " ")}`)
                .join(", ")}
              {" "}Sheets recorded at this revision won&rsquo;t need auditing again until they&rsquo;re revised.
            </Note>
          </div>
        )}

        {census.totalDistinct > 0 && (
          <div className="border-t border-[var(--color-border)]">
            <table className="w-full text-[14px]">
              <thead className={tbl.thead}>
                <tr>
                  <th className="font-semibold px-4 sm:px-5 h-10 w-20">Prefix</th>
                  <th className="font-semibold px-4">Equipment type</th>
                  <th className="font-semibold px-4 max-md:hidden">Examples</th>
                  <th className="font-semibold px-4 sm:px-5 text-right">Tags</th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {census.categories.slice(0, 10).map((c) => (
                  <tr key={c.prefix}>
                    <td className="px-4 sm:px-5 py-2 font-display font-semibold tabular-nums text-[var(--color-text)]">{c.prefix}-</td>
                    <td className="px-4 py-2">
                      {c.known ? <span className="font-semibold text-[var(--color-text)]">{c.label}</span> : <StatusTag tone="warn">{c.label}</StatusTag>}
                    </td>
                    <td className="px-4 py-2 max-md:hidden font-display tabular-nums text-[var(--color-text-muted)] truncate max-w-0 w-1/2" title={c.sample.join(", ")}>
                      {c.sample.slice(0, 3).join(", ")}{c.distinctTags > 3 ? ", …" : ""}
                    </td>
                    <td className="px-4 sm:px-5 py-2 text-right font-display text-[16px] font-semibold tabular-nums text-[var(--color-text)]">{c.distinctTags}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {census.categories.length > 10 && <p className="px-4 sm:px-5 py-2 border-t border-[var(--color-border)] text-[13px] text-[var(--color-text-muted)]">Top 10 of {census.categories.length} types. The register export has every tag.</p>}
          </div>
        )}

        {checks.length > 0 && (
          <div className="border-t border-[var(--color-border)]">
            <table className="w-full text-[14px]">
              <thead className={tbl.thead}>
                <tr>
                  <th className="font-semibold px-4 sm:px-5 h-10">Check</th>
                  <th className="font-semibold px-4 sm:px-5 text-right">Found</th>
                </tr>
              </thead>
              <tbody className={tbl.tbody}>
                {checks.map((c) => (
                  <React.Fragment key={c.key}>
                    <tr className={`${tbl.tr} cursor-pointer`} onClick={c.toggle}>
                      <td className="px-4 sm:px-5 py-2.5 relative">
                        {c.tone !== "none" && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px]" style={{ background: c.tone === "bad" ? "var(--state-overdue)" : "var(--state-held)" }} />}
                        <button type="button" aria-expanded={c.open} onClick={(e) => { e.stopPropagation(); c.toggle(); }} className="inline-flex items-center gap-1.5 text-left font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">
                          <ChevronRight className={`w-4 h-4 shrink-0 text-[var(--color-text-muted)] ui-chevron${(c.open) ? " rotate-90" : ""}`} />
                          {c.label}
                        </button>
                      </td>
                      <td className="px-4 sm:px-5 py-2.5 text-right">
                        {c.tone === "none"
                          ? <span className="font-display text-[16px] font-semibold tabular-nums text-[var(--color-text)]">{c.count.toLocaleString()}</span>
                          : <StatusTag tone={c.tone}>{c.count.toLocaleString()}</StatusTag>}
                      </td>
                    </tr>
                    {c.open && (
                      <tr><td colSpan={2} className="px-4 sm:px-5 pb-3 pt-0">{c.body}</td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="border-t border-[var(--color-border)] px-4 sm:px-5 py-3 space-y-2">
            {suggestions.map((sg, i) => (
              <Note key={i} tone="none" title={i === 0 ? <span className="inline-flex items-center gap-1.5"><Lightbulb className="w-4 h-4" /> Give it more and it can do more</span> : undefined}>{sg}</Note>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}
