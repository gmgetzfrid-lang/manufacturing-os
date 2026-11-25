"use client";

import Link from "next/link";

// /admin/codebook — the Site Codebook: teach the app your site's language
// ONCE and every feature reads it (knowledge AI decoder, drafting request
// unit lists, the equipment registry's unit-first browsing, and the
// drawing→equipment bridge). Nothing here is required: an empty codebook
// leaves the app exactly as it was.
//
// Three ways in, one editable truth:
//   * type rows by hand,
//   * AI-import a written standard (proposal → review → apply; your manual
//     edits are never steamrolled),
//   * or mix both — imported rows are just rows.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  Plus, Trash2, Sparkles, Check, X, FileText, AlertTriangle,
  GraduationCap, Pencil, Square,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import EquipmentFilesDialog from "@/components/assets/EquipmentFilesDialog";
import { useEquipmentFilesSync } from "@/components/assets/useEquipmentFilesSync";
import { loadTree } from "@/lib/equipmentLibraryPush";
import type { EquipmentTree } from "@/lib/equipmentLibrary";
import { supabase } from "@/lib/supabase";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, StepLine, heroPrimary } from "@/components/ui/PageHero";
import { tbl, fieldBox, link, btnIcon, btnQuiet, btnLink, Section, Problem } from "@/components/admin/kit";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonRows } from "@/components/ui/Skeleton";
import MoreMenu from "@/components/ui/MoreMenu";
import { friendlyError } from "@/lib/friendlyError";
import { withViewTransition } from "@/lib/viewTransition";
import StepPath from "@/components/ui/StepPath";
import FileThumb from "@/components/ui/FileThumb";
import { useDraft } from "@/hooks/useDraft";
import { appConfirm } from "@/components/providers/DialogProvider";
import {
  loadCodebook, upsertEntry, deleteEntry, saveConfig, applyImport, diffImport, parseDrawingNumber,
  type Codebook, type CodebookEntry, type CodebookKind, type DrawingSegment, type ProposedEntry, type ImportDiff,
} from "@/lib/codebook";
import CodebookLearn from "@/components/admin/CodebookLearn";
import { useFileDrag } from "@/hooks/useFileDrag";
import { formatBytes } from "@/lib/formatBytes";

/** Full-screen overlays live on <body>, above the top bar (the page is its
 *  own stacking layer while it animates between views). */
const onBody = (node: React.ReactNode) => (typeof document === "undefined" ? node : createPortal(node, document.body));

const WRITER_ROLES = new Set(["Admin", "DocCtrl"]);


type Tab = "units" | "equipment" | "drawings" | "numbering" | "legend";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "units", label: "Units" },
  { key: "equipment", label: "Equipment types" },
  { key: "drawings", label: "Drawing types" },
  { key: "numbering", label: "Drawing numbers" },
  { key: "legend", label: "Legend" },
];

export default function CodebookPage() {
  const { activeOrgId, uid, activeRole, userEmail } = useRole();
  const canWrite = !!activeRole && WRITER_ROLES.has(activeRole);
  const [book, setBook] = useState<Codebook | null>(null);
  // The operating areas pushed to a library (Equipment Files), asked here once units exist.
  const [efTree, setEfTree] = useState<EquipmentTree | null | undefined>(undefined);
  const [efOpen, setEfOpen] = useState(false);
  useEffect(() => {
    if (!activeOrgId) return;
    let on = true;
    void loadTree(activeOrgId).then((t) => { if (on) setEfTree(t); }, () => { if (on) setEfTree(null); });
    return () => { on = false; };
  }, [activeOrgId]);
  // Units and type codes added or renamed here: their Equipment Files folders follow.
  const efSync = useEquipmentFilesSync({ orgId: activeOrgId, uid, email: userEmail, can: canWrite && !!efTree?.assets, trigger: efTree?.assets ? book : null, onSynced: setEfTree });
  const [tab, setTabNow] = useState<Tab>("units");
  // Switching sections cross-fades (instant under reduced motion).
  const setTab = (t: Tab) => withViewTransition(() => flushSync(() => setTabNow(t)));
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const next = await loadCodebook(activeOrgId);
      setBook(next);
      setLoadError(null);
    } catch (e) { setLoadError(e ?? true); }
  }, [activeOrgId]);

  useEffect(() => {
    const t = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(t);
  }, [refresh]);

  if (!book) {
    return (
      <PageShell width="work">
        <PageHero kicker="Admin · Site codebook" title={loadError ? "Couldn't load the codebook." : "Site codebook"} overlap={false} />
        <PageBody>
          {loadError ? (
            <ErrorNote error={loadError} title="Couldn't load the Site Codebook." onRetry={() => void refresh()} />
          ) : <SkeletonRows rows={6} cols={2} what="the Site Codebook" />}
        </PageBody>
      </PageShell>
    );
  }

  // Setup, in order. The page leads with the one step that's next.
  const setup: Array<{ done: boolean; label: string; tab: Tab; say: React.ReactNode; optional?: boolean }> = [
    { done: book.units.length > 0, label: "Units", tab: "units",
      say: <>Add your <b>units</b> (20 = Crude, 25 = DHT…), or use “Build from a document”.</> },
    { done: book.equipmentTypes.length > 0, label: "Equipment types", tab: "equipment",
      say: <>Add <b>equipment type codes</b> with their tag prefixes (30 = Exchangers, prefix E, so E-22 becomes 2030.22).</> },
    { done: !!book.drawingNumber, label: "Drawing numbers", tab: "numbering",
      say: <>Describe your <b>drawing numbers</b> and check the preview with a real one, like 2002-D-10001 SHT.4.</> },
    { done: book.legendDocIds.length > 0, label: "Legend", tab: "legend", optional: true,
      say: <>Attach your P&amp;ID <b>legend</b> sheets (optional). The AI reads them on every question.</> },
  ];
  const nextStep = setup.find((x) => !x.done) ?? null;
  const doneCount = setup.filter((x) => x.done).length;

  // The answer: how far the setup is, or (once set up) what it knows.
  const answer = nextStep
    ? `${doneCount} of ${setup.length} setup steps done.`
    : "Your site's codes are taught.";

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · Site codebook"
        title={answer}
        sub={
          <>
            {nextStep ? (
              <>Next: {nextStep.say}{nextStep.optional && " (optional)"}{" "}
                {tab !== nextStep.tab && (
                  <button type="button" onClick={() => setTab(nextStep.tab)} className={link}>Go to {nextStep.label}</button>
                )}
              </>
            ) : (
              <>Last step: in your P&amp;ID library, open Equipment, pick the equipment column, then Sweep and Apply.</>
            )}
            {!canWrite && <> Read only: Admins and Document Controllers edit the codebook.</>}
          </>
        }
        // A row of zeros says nothing (the path below says what's missing):
        // a count shows once there is one.
        facts={[
          ...(book.units.length > 0 ? [{ label: "Units", value: book.units.length }] : []),
          ...(book.equipmentTypes.length > 0 ? [{ label: "Equipment types", value: book.equipmentTypes.length }] : []),
          ...(book.drawingTypes.length > 0 ? [{ label: "Drawing types", value: book.drawingTypes.length }] : []),
        ]}
        factsHero="none"
        primary={canWrite ? (
          <button type="button" className={heroPrimary} onClick={() => setImportOpen(true)}>
            <Sparkles className="w-4 h-4" /> Build from a document
          </button>
        ) : undefined}
      >
        {/* Setup, in order, as one path. Step 5 happens in the P&ID library. */}
        <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="min-w-[560px]">
            <StepLine onDark steps={[
              ...setup.map((x) => ({
                label: x.label,
                note: x.done ? "Done" : x.optional ? "Optional" : undefined,
                state: (x.done ? "done" : x === nextStep ? "now" : "next") as "done" | "now" | "next",
              })),
              { label: "Sweep drawings", note: "In the P&ID library", state: (nextStep ? "next" : "now") as "done" | "now" | "next" },
            ]} />
          </div>
        </div>
        {/* The codebook's sections, as an underline row of tabs; a count is
            plain muted figures after the label. */}
        <div className="mt-6 flex items-end gap-6 overflow-x-auto border-b border-[var(--color-border)]" role="tablist" aria-label="Codebook sections"
          onKeyDown={(e) => {
            const i = TABS.findIndex((t) => t.key === tab);
            const j = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length : -1;
            if (j < 0) return;
            e.preventDefault();
            setTab(TABS[j].key);
            (e.currentTarget.querySelectorAll("[role=tab]")[j] as HTMLElement | undefined)?.focus();
          }}>
          {TABS.map((t) => {
            const n = t.key === "units" ? book.units.length : t.key === "equipment" ? book.equipmentTypes.length : t.key === "drawings" ? book.drawingTypes.length : null;
            const on = tab === t.key;
            return (
              <button key={t.key} type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => setTab(t.key)}
                className={`shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-10 pointer-coarse:h-11 -mb-px border-b-2 text-reading transition-colors ${on ? "border-[var(--color-current)] font-medium text-[var(--color-text)]" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                {t.label}
                {n !== null && n > 0 && <span className="ui-count">{n}</span>}
              </button>
            );
          })}
        </div>
      </PageHero>

      <PageBody>
      {error && <Problem>{error}</Problem>}

      {tab !== "units" && efSync.error && <Problem>Couldn&apos;t bring Equipment Files up to date: {efSync.error}</Problem>}
      {tab === "units" && canWrite && book.units.length > 0 && efTree !== undefined && (
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="min-w-0 flex-1 basis-64 text-body text-[var(--color-text)]">
            {efTree?.assets
              ? <><b>Equipment files</b> are in {efTree.libraryName ?? "their library"}, laid out like these units and type codes and kept in step with them: a unit or type added or renamed here gets its folder or new name.
                {efSync.busy ? <span role="status" className="block text-[var(--color-text-muted)]">Bringing it up to date: {efSync.busy.toLowerCase()}…</span>
                  : efSync.error ? <span role="alert" className="block text-[var(--state-overdue-text)]">Couldn&apos;t bring it up to date: {efSync.error}</span>
                  : efSync.words ? <span role="status" className="block text-[var(--color-text-muted)]">Just brought up to date: {efSync.words}.</span> : null}</>
              : <><b>Push a library for these operating areas?</b> Equipment Files mirrors them: a folder for each unit, equipment type and piece of equipment, linked to each unit&apos;s page and each piece of equipment. You pick its own library or a folder in one, and its name.</>}
          </p>
          <Button variant="secondary" onClick={() => setEfOpen(true)}>{efTree?.assets ? "Update the folders" : "Set it up"}</Button>
        </div>
      )}
      {efOpen && activeOrgId && uid && (
        <EquipmentFilesDialog orgId={activeOrgId} uid={uid} onClose={() => setEfOpen(false)} onDone={(t) => { setEfTree(t); refresh(); }} />
      )}
      {tab === "units" && (
        <EntryTable kind="unit" title="Operating areas / units" entries={book.units} canWrite={canWrite}
          codeHint="Unit number, e.g. 20" labelHint="Name, e.g. Crude Unit"
          orgId={activeOrgId!} uid={uid!} onChanged={refresh} onError={setError} />
      )}
      {tab === "equipment" && (
        <EntryTable kind="equipment_type" title="Equipment type codes" entries={book.equipmentTypes} canWrite={canWrite}
          codeHint="Type code, e.g. 30" labelHint="Label, e.g. Exchangers" withPrefixes
          orgId={activeOrgId!} uid={uid!} onChanged={refresh} onError={setError} />
      )}
      {tab === "drawings" && (
        <EntryTable kind="drawing_type" title="Drawing / document type codes" entries={book.drawingTypes} canWrite={canWrite}
          codeHint="Type code, e.g. 02" labelHint="Label, e.g. P&ID"
          orgId={activeOrgId!} uid={uid!} onChanged={refresh} onError={setError} />
      )}
      {tab === "numbering" && (
        <NumberingTab book={book} canWrite={canWrite} orgId={activeOrgId!} uid={uid!} onChanged={refresh} onError={setError} />
      )}
      {tab === "legend" && (
        <LegendTab book={book} canWrite={canWrite} orgId={activeOrgId!} uid={uid!} onChanged={refresh} onError={setError} />
      )}

      {/* What the site's own numbers already show, for a person to accept. */}
      <CodebookLearn orgId={activeOrgId!} uid={uid!} book={book} canWrite={canWrite} onChanged={refresh} onError={setError} />
      </PageBody>

      {importOpen && activeOrgId && uid && (
        <ImportModal orgId={activeOrgId} uid={uid} book={book}
          onClose={() => setImportOpen(false)}
          onApplied={() => { setImportOpen(false); void refresh(); }} />
      )}
    </PageShell>
  );
}

// ─── Vocabulary tables (units / equipment types / drawing types) ────────────

function EntryTable({ kind, title, entries, canWrite, codeHint, labelHint, withPrefixes, orgId, uid, onChanged, onError }: {
  kind: CodebookKind; title: string; entries: CodebookEntry[]; canWrite: boolean;
  codeHint: string; labelHint: string; withPrefixes?: boolean;
  orgId: string; uid: string; onChanged: () => void; onError: (m: string | null) => void;
}) {
  const [draft, setDraft] = useState({ code: "", label: "", prefixes: "" });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!draft.code.trim() || !draft.label.trim() || busy) return;
    setBusy(true); onError(null);
    try {
      await upsertEntry(orgId, {
        kind, code: draft.code, label: draft.label,
        meta: withPrefixes ? { tagPrefixes: draft.prefixes.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean) } : {},
        sort: entries.length, origin: "manual",
      }, uid);
      setDraft({ code: "", label: "", prefixes: "" });
      onChanged();
    } catch (e) { onError(`Couldn't add ${draft.code}. ${friendlyError(e)}`); }
    finally { setBusy(false); }
  };

  const remove = async (e: CodebookEntry) => {
    const ok = await appConfirm({
      title: `Remove ${e.code} (${e.label})?`,
      message: "Features stop recognizing this code. Nothing else is deleted.",
      confirmLabel: "Remove code",
      tone: "danger",
    });
    if (!ok) return;
    try { await deleteEntry(e.id); onChanged(); } catch (err) { onError(`Couldn't remove ${e.code}. ${friendlyError(err)}`); }
  };

  return (
    <Section label={title} count={entries.length}>
    <div className={tbl.wrap}>
      <table className={tbl.table}>
        <thead className={tbl.thead}>
          <tr>
            <th className={`${tbl.th} w-28`}>Code</th>
            <th className={tbl.th}>Means</th>
            {withPrefixes && <th className={`${tbl.th} max-sm:hidden`}>Tag prefixes</th>}
            <th className={`${tbl.th} max-sm:hidden w-28`}>From</th>
            {canWrite && <th className={`${tbl.th} w-24`}><span className="sr-only">Actions</span></th>}
          </tr>
        </thead>
        <tbody className={tbl.tbody}>
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} withPrefixes={withPrefixes} canWrite={canWrite}
              orgId={orgId} uid={uid} onChanged={onChanged} onError={onError} onRemove={() => void remove(e)} />
          ))}
          {entries.length === 0 && (
            <tr><td colSpan={5} className="px-4 py-5 text-[var(--color-text-muted)]">
              Nothing here yet. Add a row below, or use Build from a document.
            </td></tr>
          )}
        </tbody>
      </table>
      {canWrite && (
        <div className="px-4 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center gap-2 flex-wrap">
          <input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder={codeHint} aria-label="Code" className={`${fieldBox} h-10 text-reading w-44`} />
          <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder={labelHint} aria-label="Label" className={`${fieldBox} h-10 text-reading flex-1 min-w-[180px]`} />
          {withPrefixes && (
            <input value={draft.prefixes} onChange={(e) => setDraft({ ...draft, prefixes: e.target.value })} placeholder="Prefixes, e.g. E or EA, E" aria-label="Tag prefixes" className={`${fieldBox} h-10 text-reading w-52`} />
          )}
          <Button variant="secondary" loading={busy} onClick={() => void add()} disabled={!draft.code.trim() || !draft.label.trim()}>
            <Plus aria-hidden className="w-4 h-4" /> Add
          </Button>
        </div>
      )}
    </div>
    </Section>
  );
}

function EntryRow({ entry, withPrefixes, canWrite, orgId, uid, onChanged, onError, onRemove }: {
  entry: CodebookEntry; withPrefixes?: boolean; canWrite: boolean;
  orgId: string; uid: string; onChanged: () => void; onError: (m: string | null) => void; onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(entry.label);
  const [prefixes, setPrefixes] = useState((entry.meta.tagPrefixes ?? []).join(", "));

  const save = async () => {
    try {
      await upsertEntry(orgId, {
        ...entry, label,
        meta: withPrefixes ? { tagPrefixes: prefixes.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean) } : entry.meta,
      }, uid);
      setEditing(false);
      onChanged();
    } catch (e) { onError(`Couldn't save ${entry.code}. ${friendlyError(e)}`); }
  };

  return (
    <tr className={tbl.tr}>
      <td className={tbl.td}><span className="ui-id text-reading">{entry.code}</span></td>
      <td className={tbl.td}>
        {editing
          ? <input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label" className={`${fieldBox} h-9 pointer-coarse:h-11 text-reading w-full`} autoFocus />
          : canWrite
            // Tap the meaning to change it, as before.
            ? <button type="button" onClick={() => setEditing(true)} title="Change what this code means" className="text-left text-[var(--color-text)] hover:text-[var(--color-accent-text)] hover:underline underline-offset-2">{entry.label}</button>
            : <span className="text-[var(--color-text)]">{entry.label}</span>}
      </td>
      {withPrefixes && (
        <td className={`${tbl.td} max-sm:hidden`}>
          {editing
            ? <input value={prefixes} onChange={(e) => setPrefixes(e.target.value)} aria-label="Tag prefixes" className={`${fieldBox} h-9 pointer-coarse:h-11 text-reading w-full`} />
            : (
              <span className="flex flex-wrap gap-1">
                <span className="font-display font-semibold tabular-nums text-[var(--color-text)]">{(entry.meta.tagPrefixes ?? []).slice(0, 4).map((p) => `${p}-`).join(", ")}</span>
                {(entry.meta.tagPrefixes ?? []).length > 4 && (
                  <button type="button" onClick={() => canWrite && setEditing(true)} title={(entry.meta.tagPrefixes ?? []).map((p) => `${p}-`).join(", ")} className="text-body text-[var(--color-text-muted)] hover:underline underline-offset-2">and {(entry.meta.tagPrefixes ?? []).length - 4} more</button>
                )}
              </span>
            )}
        </td>
      )}
      <td className={`${tbl.td} max-sm:hidden text-body text-[var(--color-text-muted)]`}>
        {entry.origin === "import" ? "Imported" : "Typed in"}
      </td>
      {canWrite && (
        <td className={`${tbl.td} text-right`}>
          <div className="flex items-center justify-end gap-1">
            {editing ? (
              <>
                <button type="button" onClick={() => void save()} className={btnIcon} title="Save" aria-label="Save"><Check className="w-4 h-4" /></button>
                <button type="button" onClick={() => { setEditing(false); setLabel(entry.label); setPrefixes((entry.meta.tagPrefixes ?? []).join(", ")); }} className={btnIcon} title="Cancel" aria-label="Cancel"><X className="w-4 h-4" /></button>
              </>
            ) : (
              <MoreMenu iconOnly label={`More for ${entry.code}`} triggerClass={btnIcon} items={[
                { icon: <Pencil className="w-4 h-4" />, label: "Change", onClick: () => setEditing(true) },
                { icon: <Trash2 className="w-4 h-4" />, label: "Remove", tone: "bad", line: true, onClick: onRemove },
              ]} />
            )}
          </div>
        </td>
      )}
    </tr>
  );
}

// ─── Drawing-number decoder builder with live preview ───────────────────────

const SEGMENT_KINDS: Array<{ kind: DrawingSegment["kind"]; label: string }> = [
  { kind: "unit", label: "Unit (digits)" },
  { kind: "drawing_type", label: "Drawing type (digits)" },
  { kind: "size", label: "Paper size (letters)" },
  { kind: "iterable", label: "Number (iterable)" },
  { kind: "sheet", label: "Sheet" },
];

function NumberingTab({ book, canWrite, orgId, uid, onChanged, onError }: {
  book: Codebook; canWrite: boolean; orgId: string; uid: string;
  onChanged: () => void; onError: (m: string | null) => void;
}) {
  const [segments, setSegments] = useState<DrawingSegment[]>(book.drawingNumber?.segments ?? []);
  const [padTo, setPadTo] = useState(book.iterableRule.padTo);
  const [mirrors, setMirrors] = useState(book.iterableRule.mirrorsTag);
  const [sample, setSample] = useState("2002-D-10001 SHT.4");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const previewBook: Codebook = useMemo(
    () => ({ ...book, drawingNumber: segments.length > 0 ? { segments } : null }),
    [book, segments]);
  const parsed = useMemo(() => sample.trim() ? parseDrawingNumber(sample, previewBook) : null, [sample, previewBook]);

  const save = async () => {
    setSaving(true); onError(null);
    try {
      await saveConfig(orgId, {
        drawingNumber: segments.length > 0 ? { segments } : null,
        iterableRule: { mirrorsTag: mirrors, padTo: Math.max(0, Math.min(6, padTo)) },
      }, uid);
      setSaved(true); setTimeout(() => setSaved(false), 1800);
      onChanged();
    } catch (e) { onError(`Couldn't save the numbering. ${friendlyError(e)}`); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-8">
      <Section label="Drawing number segments, in order">
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
        <p className="text-body text-[var(--color-text-muted)] mb-3">
          Separators (dashes, dots, “SHT”) are handled for you. Unit (2), Drawing type (2), Paper size (1), Number, Sheet reads <span className="font-display font-semibold">2002-D-10001 SHT.4</span>.
        </p>
        <div className="space-y-1.5">
          {segments.map((seg, i) => (
            <div key={i} className="flex items-center gap-2 flex-wrap">
              <span className="text-body font-medium text-[var(--color-text-faint)] w-4">{i + 1}.</span>
              <select value={seg.kind} disabled={!canWrite} aria-label={`Segment ${i + 1}`}
                onChange={(e) => setSegments(segments.map((s, j) => j === i ? { kind: e.target.value as DrawingSegment["kind"], digits: 2, letters: 1 } : s))}
                className={`${fieldBox} h-9 pointer-coarse:h-11 text-body pointer-coarse:text-reading`}>
                {SEGMENT_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
              </select>
              {(seg.kind === "unit" || seg.kind === "drawing_type") && (
                <label className="text-body text-[var(--color-text-muted)] inline-flex items-center gap-1">
                  digits <Input type="number" inputMode="numeric" value={seg.digits ?? 2} disabled={!canWrite} min={1} max={4}
                    onChange={(e) => setSegments(segments.map((s, j) => j === i ? { ...s, digits: Math.max(1, Math.min(4, Number(e.target.value) || 2)) } : s))}
                    className="w-14 h-8" />
                </label>
              )}
              {seg.kind === "size" && (
                <label className="text-body text-[var(--color-text-muted)] inline-flex items-center gap-1">
                  letters <Input type="number" inputMode="numeric" value={seg.letters ?? 1} disabled={!canWrite} min={1} max={3}
                    onChange={(e) => setSegments(segments.map((s, j) => j === i ? { ...s, letters: Math.max(1, Math.min(3, Number(e.target.value) || 1)) } : s))}
                    className="w-14 h-8" />
                </label>
              )}
              {canWrite && (
                <button onClick={() => setSegments(segments.filter((_, j) => j !== i))}
                  className="ui-hit p-1 text-[var(--color-text-faint)] hover:text-[var(--state-overdue)] rounded" title="Remove segment" aria-label="Remove segment">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
        {canWrite && (
          <Button variant="secondary" size="sm" className="mt-3"
            onClick={() => setSegments([...segments, { kind: segments.length === 0 ? "unit" : "iterable", digits: 2, letters: 1 }])}>
            <Plus className="w-3.5 h-3.5" /> Add segment
          </Button>
        )}
      </div>
      </Section>

      <Section label="Check it with a real drawing number">
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
        <Input value={sample} onChange={(e) => setSample(e.target.value)} aria-label="Sample drawing number" className="max-w-md font-display tabular-nums" placeholder="2002-D-10001 SHT.4" autoComplete="off" />
        <div className="mt-2.5 flex flex-wrap gap-1.5 text-body">
          {segments.length === 0 ? (
            <span className="text-[var(--color-text-muted)]">Add segments above to see the decode.</span>
          ) : !parsed ? (
            <span className="inline-flex items-center gap-1.5 text-body text-[var(--state-overdue-text)] font-medium"><AlertTriangle aria-hidden className="w-4 h-4" /> Doesn&apos;t match the segments. Change the segments or the sample.</span>
          ) : (
            <>
              <PreviewChip label="Unit" value={parsed.unitCode} extra={parsed.unitLabel} />
              <PreviewChip label="Type" value={parsed.drawingTypeCode} extra={parsed.drawingTypeLabel} />
              <PreviewChip label="Size" value={parsed.size} />
              <PreviewChip label="Number" value={parsed.iterable} />
              <PreviewChip label="Sheet" value={parsed.sheet} />
            </>
          )}
        </div>
      </div>
      </Section>

      <Section label="The number after the point">
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5 flex items-center gap-4 flex-wrap">
        <p className="basis-full text-body text-[var(--color-text-muted)]">Is it the tag&apos;s number (E-5 is 2030.05)? If not, equipment IDs are never worked out from the name: they come from the schedule or are typed in.</p>
        <label className="text-body text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
          <input type="checkbox" checked={mirrors} disabled={!canWrite} onChange={(e) => setMirrors(e.target.checked)} className="w-4 h-4 accent-[var(--color-main)]" /> it&apos;s the tag&apos;s number
        </label>
        <label className={`text-body text-[var(--color-text-muted)] inline-flex items-center gap-1.5 whitespace-nowrap ${mirrors ? "" : "opacity-40"}`}>
          pad to <Input type="number" inputMode="numeric" value={padTo} disabled={!canWrite || !mirrors} min={0} max={6}
            onChange={(e) => setPadTo(Math.max(0, Math.min(6, Number(e.target.value) || 0)))} className="w-14 h-8" /> digits
        </label>
        {canWrite && (
          <Button variant="secondary" className="ml-auto" loading={saving} done={saved} doneLabel="Saved" onClick={() => void save()}>
            Save numbering
          </Button>
        )}
      </div>
      </Section>
    </div>
  );
}

function PreviewChip({ label, value, extra }: { label: string; value: string | null; extra?: string | null }) {
  return (
    <span className="inline-flex flex-col px-3 py-1.5 border-l border-[var(--color-border-strong)] first:border-l-0 first:pl-0">
      <span className="text-body text-[var(--color-text-muted)]">{label}</span>
      <span className={`font-display text-section font-semibold tabular-nums ${value ? "text-[var(--color-text)]" : "text-[var(--color-text-faint)]"}`}>{value ?? "-"}{extra && <span className="font-sans text-body font-normal text-[var(--color-text-muted)]"> {extra}</span>}</span>
    </span>
  );
}

// ─── Legend attachments ─────────────────────────────────────────────────────

function LegendTab({ book, canWrite, orgId, uid, onChanged, onError }: {
  book: Codebook; canWrite: boolean; orgId: string; uid: string;
  onChanged: () => void; onError: (m: string | null) => void;
}) {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (book.legendDocIds.length === 0) return; // nothing rendered → stale map is invisible
    void supabase.from("knowledge_documents").select("id, name").in("id", book.legendDocIds)
      .then(({ data }) => setNames(new Map(((data ?? []) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]))));
  }, [book.legendDocIds]);

  useEffect(() => {
    const q = query.trim();
    const t = setTimeout(() => {
      if (q.length < 2) { setResults([]); return; }
      void supabase.from("knowledge_documents").select("id, name")
        .eq("org_id", orgId).ilike("name", `%${q}%`).eq("status", "ready").limit(8)
        .then(({ data }) => setResults(((data ?? []) as Array<{ id: string; name: string }>).filter((d) => !book.legendDocIds.includes(d.id))));
    }, 250);
    return () => clearTimeout(t);
  }, [query, orgId, book.legendDocIds]);

  const setLegend = async (ids: string[]) => {
    onError(null);
    try { await saveConfig(orgId, { legendDocIds: ids.slice(0, 3) }, uid); onChanged(); }
    catch (e) { onError(`Couldn't change the legend. ${friendlyError(e)}`); }
  };

  return (
    <Section label="Symbols legend and decoder sheets" action={<span className="text-body text-[var(--color-text-muted)] tabular-nums">{book.legendDocIds.length} of 3</span>}>
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
      <p className="text-body text-[var(--color-text-muted)] mb-3">
        Attach your P&ID legend sheets (indexed in any knowledge library). Every knowledge library inherits them automatically, so the AI can read your symbols when it answers.
      </p>
      <div className="space-y-1.5 mb-3">
        {book.legendDocIds.map((id) => (
          <div key={id} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)]">
            <FileText aria-hidden className="w-4 h-4 text-[var(--color-text-faint)] shrink-0" />
            <span className="text-body font-medium text-[var(--color-text)] truncate flex-1">{names.get(id) ?? id}</span>
            {canWrite && (
              <button onClick={() => void setLegend(book.legendDocIds.filter((x) => x !== id))}
                className={btnIcon} title="Detach" aria-label="Detach legend">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
        {book.legendDocIds.length === 0 && <div className="text-body text-[var(--color-text-muted)]">No legend attached yet.</div>}
      </div>
      {canWrite && book.legendDocIds.length < 3 && (
        <div>
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find an indexed document" placeholder="e.g. P&ID legend" autoComplete="off" enterKeyHint="search" />
          {results.length > 0 && (
            <div className="mt-1 rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
              {results.map((r) => (
                <button key={r.id} onClick={() => { setQuery(""); void setLegend([...book.legendDocIds, r.id]); }}
                  className="w-full text-left px-3 py-1.5 pointer-coarse:min-h-11 text-body hover:bg-[var(--color-surface-2)] flex items-center gap-2">
                  <Plus className="w-3 h-3 text-[var(--color-text-muted)]" /> {r.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
    </Section>
  );
}

// ─── AI import: proposal → review → apply ───────────────────────────────────

function ImportModal({ orgId, uid, book, onClose, onApplied }: {
  orgId: string; uid: string; book: Codebook; onClose: () => void; onApplied: () => void;
}) {
  const [text, setText] = useState("");
  const [docQuery, setDocQuery] = useState("");
  const [docResults, setDocResults] = useState<Array<{ id: string; name: string }>>([]);
  const [pickedDoc, setPickedDoc] = useState<{ id: string; name: string } | null>(null);
  const [pickedFile, setPickedFile] = useState<{ name: string; base64: string; file: File } | null>(null);
  // What the AI read, said back once it's done ("Read 12 pages, found 40 codes").
  const [readLine, setReadLine] = useState<string | null>(null);
  // Pasted standards text is kept on this device until it's applied.
  const pasteDraft = useDraft<string>(`codebook-import:${orgId}`, text, setText, (v) => !v.trim());
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<ImportDiff | null>(null);
  const [notes, setNotes] = useState("");
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  // Reading runs part by part; Stop ends it after the part in flight and
  // shows what was found so far.
  const stopRef = useRef(false);
  const [stopping, setStopping] = useState(false);

  const handleFile = async (file: File) => {
    setError(null);
    if (file.size > 3_000_000) {
      setError(`"${file.name}" is over the 3 MB limit. Index it in a knowledge library, then pick it from the search below.`);
      return;
    }
    const buf = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    setPickedFile({ name: file.name, base64: btoa(binary), file });
    setPickedDoc(null);
  };
  const codeDrag = useFileDrag((fs) => { void handleFile(fs[0]); }, running);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !running && !applying) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, applying, onClose]);

  useEffect(() => {
    const q = docQuery.trim();
    const t = setTimeout(() => {
      if (q.length < 2) { setDocResults([]); return; }
      void supabase.from("knowledge_documents").select("id, name")
        .eq("org_id", orgId).ilike("name", `%${q}%`).eq("status", "ready").limit(8)
        .then(({ data }) => setDocResults((data ?? []) as Array<{ id: string; name: string }>));
    }, 250);
    return () => clearTimeout(t);
  }, [docQuery, orgId]);

  const keyOf = (p: ProposedEntry) => `${p.kind}:${p.code}`;

  // Split extracted text on paragraph boundaries into AI-call-sized parts.
  // Bounded calls are the whole reliability story: each one finishes fast no
  // matter how big the document or how slow the chosen model.
  const CHUNK = 7000;
  // Vision fallback bounds: pages per AI call and total pages per run —
  // image input costs real tokens on the user's key, so both are caps.
  const VISION_BATCH = 3;
  const MAX_VISION_PAGES = 12;
  const chunkText = (t: string): string[] => {
    const out: string[] = [];
    let rest = t.trim();
    while (rest.length > 0 && out.length < 10) {
      if (rest.length <= CHUNK) { out.push(rest); break; }
      let cut = rest.lastIndexOf("\n", CHUNK);
      if (cut < CHUNK * 0.5) cut = CHUNK;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    return out;
  };

  const run = async () => {
    stopRef.current = false;
    setStopping(false);
    setRunning(true); setError(null); setDiff(null); setProgress(""); setReadLine(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` };
      const post = async (payload: Record<string, unknown>) => {
        const res = await fetch("/api/codebook/import", { method: "POST", headers, body: JSON.stringify(payload) });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error((json as { error?: string }).error ?? ""), { status: res.status });
        return json as { text?: string; proposals?: ProposedEntry[]; notes?: string; pageCount?: number; thinText?: boolean };
      };

      // 1. Get the TEXT — file/document extraction is a fast, free call. For
      //    PDFs the reply also says whether the text layer is real: CAD
      //    exports and scans come back thin (a title block at best), and
      //    those get READ VISUALLY, page by page, instead.
      let sourceText = text.trim();
      let pageCount = 0;
      let visionPages = 0; // >0 → propose from page images, not text
      if (pickedFile || pickedDoc) {
        setProgress("Reading the document");
        const ex = await post({
          orgId, action: "extract",
          fileBase64: pickedFile?.base64, fileName: pickedFile?.name,
          knowledgeDocumentId: pickedDoc?.id,
        });
        sourceText = String(ex.text ?? "").trim();
        pageCount = Number(ex.pageCount ?? 0);
        if (ex.thinText && pickedFile && pageCount > 0) {
          visionPages = Math.min(pageCount, MAX_VISION_PAGES);
        }
      }
      if (!sourceText && visionPages === 0) throw new Error("Nothing to read. Upload a file, paste text, or pick a document.");
      let partsRead = 0;

      // 2. Propose in bounded parts, sequentially, one retry each. A slow or
      //    flaky part degrades to a warning — never a wasted run.
      const allProposals: ProposedEntry[] = [];
      const allNotes: string[] = [];
      const failedParts: string[] = [];

      if (visionPages > 0) {
        // 2a. Vision: the PDF's "text" is vector strokes or scan pixels
        //     (CAD-exported legends, scanned standards). Render + read pages
        //     in small batches — same bounded-call shape as text chunks.
        for (let start = 1; start <= visionPages; start += VISION_BATCH) {
          if (stopRef.current) { failedParts.length = 0; allNotes.push(`Stopped after ${partsRead} of ${visionPages} pages.`); break; }
          const pages: number[] = [];
          for (let p = start; p < start + VISION_BATCH && p <= visionPages; p++) pages.push(p);
          const label = pages.length === 1 ? `page ${pages[0]}` : `pages ${pages[0]}–${pages[pages.length - 1]}`;
          setProgress(`Reading ${label} of ${pageCount}`);
          const payload = {
            orgId, action: "propose-vision", pages,
            fileBase64: pickedFile?.base64, fileName: pickedFile?.name,
            partLabel: pageCount > pages.length ? label : undefined,
          };
          try {
            const r = await post(payload).catch(() => post(payload)); // one retry
            allProposals.push(...(r.proposals ?? []));
            if (r.notes) allNotes.push(String(r.notes));
            partsRead += pages.length;
          } catch {
            failedParts.push(label);
          }
        }
        if (pageCount > visionPages) {
          allNotes.push(`Only the first ${visionPages} of ${pageCount} pages were read visually. Split the PDF and run it again for the rest.`);
        }
      } else {
        const chunks = chunkText(sourceText);
        for (let i = 0; i < chunks.length; i++) {
          if (stopRef.current) { allNotes.push(`Stopped after ${partsRead} of ${chunks.length} parts.`); break; }
          setProgress(chunks.length > 1 ? `Finding codes, part ${i + 1} of ${chunks.length}` : "Finding codes");
          const payload = {
            orgId, text: chunks[i],
            partLabel: chunks.length > 1 ? `part ${i + 1} of ${chunks.length}` : undefined,
          };
          try {
            const r = await post(payload).catch(() => post(payload)); // one retry
            allProposals.push(...(r.proposals ?? []));
            if (r.notes) allNotes.push(String(r.notes));
            partsRead += 1;
          } catch {
            failedParts.push(`part ${i + 1}`);
          }
        }
      }
      if (allProposals.length === 0 && failedParts.length > 0) {
        throw new Error(`Every part failed (${failedParts.length}). Check your AI key in AI settings and try again.`);
      }

      const existing = [...book.units, ...book.equipmentTypes, ...book.drawingTypes];
      const d = diffImport(existing, allProposals);
      setDiff(d);
      setNotes([...new Set(allNotes)].slice(0, 2).join(" "));
      const found = allProposals.length;
      const what = visionPages > 0
        ? `Read ${partsRead} page${partsRead === 1 ? "" : "s"}${pageCount > partsRead ? ` of ${pageCount}` : ""}`
        : pageCount > 0
          ? `Read ${pageCount} page${pageCount === 1 ? "" : "s"}`
          : `Read ${sourceText.length.toLocaleString()} characters${partsRead > 1 ? ` in ${partsRead} parts` : ""}`;
      setReadLine(`${what}, found ${found} code${found === 1 ? "" : "s"}.`);
      if (failedParts.length > 0) {
        setError(`${failedParts.join(", ")} of the document couldn't be read, so the list below may be missing some. Apply what's here and run it again for the rest.`);
      }
      // Adds + changes start accepted; unchanged needs no action.
      setAccepted(new Set([...d.adds.map(keyOf), ...d.changes.map((c) => keyOf(c.proposed))]));
    } catch (e) { setError(friendlyError(e)); }
    finally { setRunning(false); setProgress(""); setStopping(false); }
  };

  const apply = async () => {
    if (!diff) return;
    setApplying(true); setError(null);
    try {
      const rows = [...diff.adds, ...diff.changes.map((c) => c.proposed)].filter((p) => accepted.has(keyOf(p)));
      await applyImport(orgId, rows, uid);
      pasteDraft.clear();
      setText("");
      onApplied();
    } catch (e) { setError(`Couldn't apply the codes. ${friendlyError(e)}`); setApplying(false); }
  };

  const toggle = (k: string) => setAccepted((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const KIND_LABEL: Record<string, string> = { unit: "Unit", equipment_type: "Equipment", drawing_type: "Drawing" };

  return onBody(
    <div role="dialog" aria-modal="true" aria-label="Build the codebook from a document" className="fixed inset-0 z-[200] bg-[var(--color-ink)]/55 flex items-start sm:items-center justify-center overflow-y-auto p-4 animate-in fade-in">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl ui-float ui-float-in flex flex-col max-h-[88vh]">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-start gap-2.5">
          <div className="flex-1">
            <h2 className="font-display text-section leading-tight font-semibold text-[var(--color-text)]">Build the codebook from a document</h2>
            <p className="text-body text-[var(--color-text-muted)] mt-0.5">Runs on your own AI key. Nothing is written until you check it and apply.</p>
          </div>
          <button onClick={onClose} disabled={running || applying} aria-label="Close" title="Close" className={btnIcon}><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">
          <StepPath steps={["Pick the source", "Check what it found", "Apply"]} current={applying ? 2 : diff ? 1 : 0}
            onPick={running || applying ? undefined : (i) => { if (i === 0) { setDiff(null); setError(null); setReadLine(null); } }} />
          {!diff && (
            <>
              <div>
                <div className="text-body font-medium text-[var(--color-text)] mb-1.5">Upload your standard</div>
                <input ref={fileInputRef} type="file" className="hidden"
                  accept=".pdf,.docx,.txt,.md,.csv,.tsv,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ""; }} />
                {pickedFile ? (
                  <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-body">
                    <FileThumb file={pickedFile.file} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-[var(--color-text)] truncate">{pickedFile.name}</span>
                      <span className="block text-body text-[var(--color-text-muted)]">{formatBytes(pickedFile.file.size)}</span>
                    </span>
                    <button onClick={() => setPickedFile(null)} disabled={running} aria-label={`Remove ${pickedFile.name}`} className="ui-hit ml-auto p-0.5 text-[var(--color-text-faint)] hover:text-[var(--state-overdue)]"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ) : (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    {...codeDrag.bind}
                    className={`w-full border-2 border-dashed border-[var(--color-border-strong)] rounded-lg px-4 py-5 text-center hover:bg-[var(--color-surface-2)] transition-colors ${codeDrag.ring}`}
                  >
                    <div className="text-body font-medium text-[var(--color-text)]">{codeDrag.over ? codeDrag.say : "Drop your standards document here, or click to pick"}</div>
                    <div className="text-body text-[var(--color-text-muted)] mt-0.5">PDF, Word (.docx), TXT, CSV, MD · up to 3 MB. Scanned and CAD PDFs are read page by page.</div>
                  </button>
                )}
              </div>
              <div className="text-center text-body font-medium text-[var(--color-text-faint)]">or</div>
              <div>
                <label htmlFor="cb-paste" className="block text-body font-medium text-[var(--color-text)] mb-1.5">Paste your standard</label>
                {pasteDraft.restored && text.trim() && <p className="text-body text-[var(--color-text-muted)] mb-1">Brought back what you pasted last time.</p>}
                <textarea id="cb-paste" value={text} onChange={(e) => setText(e.target.value)} rows={7}
                  placeholder={"e.g.  20  Crude Unit\n      25  DHT\n      Equipment: 30 Exchangers (E-), 10 Vessels (V-)"}
                  className={`${fieldBox} w-full py-2 text-body max-sm:text-reading font-mono resize-y`} />
              </div>
              <div className="text-center text-body font-medium text-[var(--color-text-faint)]">or</div>
              <div>
                <div className="text-body font-medium text-[var(--color-text)] mb-1.5">Pick an indexed document</div>
                {pickedDoc ? (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] text-body font-medium text-[var(--color-text)]">
                    <FileText className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> {pickedDoc.name}
                    <button onClick={() => setPickedDoc(null)} disabled={running} aria-label={`Remove ${pickedDoc.name}`} className="ui-hit ml-auto p-0.5 text-[var(--color-text-faint)] hover:text-[var(--state-overdue)]"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ) : (
                  <>
                    <Input type="search" value={docQuery} onChange={(e) => setDocQuery(e.target.value)} aria-label="Find an indexed document" placeholder="e.g. numbering standard" autoComplete="off" enterKeyHint="search" />
                    {docResults.length > 0 && (
                      <div className="mt-1 rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
                        {docResults.map((r) => (
                          <button key={r.id} onClick={() => { setPickedDoc(r); setDocQuery(""); }}
                            className="w-full text-left px-3 py-1.5 pointer-coarse:min-h-11 text-body hover:bg-[var(--color-surface-2)]">{r.name}</button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {error && <Problem>{error}</Problem>}

          {diff && (
            <>
              {readLine && <div className="text-body font-medium text-[var(--color-text)]">{readLine}</div>}
              <div className="text-body text-[var(--color-text-muted)]">
                <b className="text-[var(--color-text)]">{diff.adds.length}</b> new · <b className="text-[var(--color-text)]">{diff.changes.length}</b> changed · {diff.unchanged.length} already match. Tick what to apply.
              </div>
              {notes && (
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 text-body text-[var(--color-text)]">
                  <b>AI notes on your numbering convention:</b> {notes} <span className="opacity-70">(configure segments in the Drawing numbers tab.)</span>
                </div>
              )}
              {/* The learning loop: a correction worth repeating becomes a
                  standing instruction — taught once, obeyed on every future
                  import. */}
              <Link href="/admin/ai-instructions?scope=codebook" className={btnLink}>
                <GraduationCap aria-hidden className="w-4 h-4" />
                Something it keeps getting wrong? Teach the AI a standing rule
              </Link>
              <div className="rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] max-h-72 overflow-y-auto">
                {[...diff.adds.map((p) => ({ p, change: null as null | CodebookEntry })),
                  ...diff.changes.map((c) => ({ p: c.proposed, change: c.existing }))].map(({ p, change }) => {
                  const k = keyOf(p);
                  return (
                    <label key={k} className="flex items-center gap-2.5 px-3 py-2 text-body cursor-pointer hover:bg-[var(--color-surface-2)]/60">
                      <input type="checkbox" checked={accepted.has(k)} onChange={() => toggle(k)} className="w-3.5 h-3.5 accent-[var(--color-main)]" />
                      <span className="text-body font-medium text-[var(--color-text-faint)] w-16">{KIND_LABEL[p.kind]}</span>
                      <span className="font-display font-semibold tabular-nums text-[var(--color-text)] w-14">{p.code}</span>
                      <span className="font-medium text-[var(--color-text)] flex-1">{p.label}</span>
                      {p.tagPrefixes && p.tagPrefixes.length > 0 && <span className="font-mono text-[var(--color-text-muted)]">{p.tagPrefixes.join(", ")}-</span>}
                      {change && <span className="text-body text-[var(--color-text-muted)]" title={`Currently: ${change.label}`}>replaces “{change.label}”</span>}
                    </label>
                  );
                })}
                {diff.adds.length === 0 && diff.changes.length === 0 && (
                  <div className="px-3 py-4 text-body text-[var(--color-text-muted)]">Nothing new. The codebook already matches this document.</div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={running || applying} className={btnQuiet}>Cancel</button>
          {/* While it reads, the progress shows beside the button and the
              button itself turns into Stop, in the same place. */}
          {running && progress && <span role="status" className="mr-auto text-body text-[var(--color-text-muted)] tabular-nums truncate">{stopping ? "Stopping after this part" : progress}</span>}
          {!diff ? (
            running ? (
              <Button variant="secondary" disabled={stopping} loading={stopping} onClick={() => { stopRef.current = true; setStopping(true); }}>
                {!stopping && <Square aria-hidden className="w-3.5 h-3.5 fill-current" />} Stop
              </Button>
            ) : (
              <Button variant={text.trim() || pickedDoc || pickedFile ? "primary" : "secondary"} onClick={() => void run()} disabled={!text.trim() && !pickedDoc && !pickedFile}>
                <Sparkles aria-hidden className="w-4 h-4" /> Read and find codes
              </Button>
            )
          ) : (
            <Button onClick={() => void apply()} loading={applying} disabled={accepted.size === 0}>
              {!applying && <Check aria-hidden className="w-4 h-4" />} {applying ? "Applying" : <>Apply {accepted.size} row{accepted.size === 1 ? "" : "s"}</>}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
