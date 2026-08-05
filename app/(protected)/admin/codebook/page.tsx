"use client";

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

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookMarked, Plus, Trash2, Loader2, Sparkles, Check, X, FileText,
  Boxes, Factory, FileDigit, ScanLine, BookOpen, AlertTriangle, Save,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { appConfirm } from "@/components/providers/DialogProvider";
import {
  loadCodebook, upsertEntry, deleteEntry, saveConfig, applyImport, diffImport, parseDrawingNumber,
  type Codebook, type CodebookEntry, type CodebookKind, type DrawingSegment, type ProposedEntry, type ImportDiff,
} from "@/lib/codebook";

const WRITER_ROLES = new Set(["Admin", "DocCtrl"]);

type Tab = "units" | "equipment" | "drawings" | "numbering" | "legend";

const TABS: Array<{ key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: "units", label: "Units", icon: Factory },
  { key: "equipment", label: "Equipment types", icon: Boxes },
  { key: "drawings", label: "Drawing types", icon: FileDigit },
  { key: "numbering", label: "Drawing numbers", icon: ScanLine },
  { key: "legend", label: "Legend", icon: BookOpen },
];

export default function CodebookPage() {
  const { activeOrgId, uid, activeRole } = useRole();
  const canWrite = !!activeRole && WRITER_ROLES.has(activeRole);
  const [book, setBook] = useState<Codebook | null>(null);
  const [tab, setTab] = useState<Tab>("units");
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    const next = await loadCodebook(activeOrgId);
    setBook(next);
  }, [activeOrgId]);

  useEffect(() => {
    const t = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(t);
  }, [refresh]);

  if (!book) return <div className="min-h-full flex items-center justify-center"><Spinner /></div>;

  return (
    <PageShell width="work">
      <PageHeaderBar
        icon={BookMarked}
        title="Site Codebook"
        subtitle="Your site's numbering language — units, equipment codes, drawing conventions — taught once, used by every feature. Everything is optional; empty means no opinion."
        actions={canWrite ? (
          <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
            <Sparkles className="w-3.5 h-3.5" /> Build from a document
          </Button>
        ) : undefined}
      />

      {!canWrite && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          Read-only — only Admins and Document Controllers edit the codebook.
        </div>
      )}

      {/* Getting started — the whole path in one place, with live progress.
          This page is step 1-4; step 5 happens on the P&ID library. */}
      {canWrite && (
        <div className="mb-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="text-xs font-black text-[var(--color-text)] mb-2">Setup path — do these once, in order</div>
          <ol className="space-y-1.5 text-xs">
            <SetupStep done={book.units.length > 0} n={1}
              label={<>Add your <b>units</b> (20 = Crude, 25 = DHT…) — type them in the Units tab, or hit “Build from a document” and let AI read your standard.</>}
              onGo={() => setTab("units")} goLabel="Units tab" />
            <SetupStep done={book.equipmentTypes.length > 0} n={2}
              label={<>Add <b>equipment type codes</b> with their tag prefixes (30 = Exchangers, prefix E — that&apos;s how E-22 becomes 2030.22).</>}
              onGo={() => setTab("equipment")} goLabel="Equipment tab" />
            <SetupStep done={!!book.drawingNumber} n={3}
              label={<>Describe your <b>drawing numbers</b> as segments and check the live preview with a real number like 2002-D-10001 SHT.4.</>}
              onGo={() => setTab("numbering")} goLabel="Numbering tab" />
            <SetupStep done={book.legendDocIds.length > 0} n={4} optional
              label={<>Attach your P&amp;ID <b>legend</b> sheets (optional but recommended — the AI reads them on every question).</>}
              onGo={() => setTab("legend")} goLabel="Legend tab" />
            <li className="flex items-start gap-2 text-[var(--color-text-muted)]">
              <span className="shrink-0 w-4 h-4 rounded-full border border-[var(--color-border-strong)] text-[9px] font-black flex items-center justify-center mt-0.5">5</span>
              <span>Then open your P&amp;ID <b>document library</b> → the orange <b>Equipment</b> button → pick your equipment column → Sweep → Apply. From then on it runs on every newly indexed drawing.</span>
            </li>
          </ol>
          <p className="text-[10px] text-[var(--color-text-faint)] mt-2">
            The Equipment registry breaks into operating areas automatically once step 1 has units. Drafting request unit dropdowns fill from step 1 too.
          </p>
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <div className="inline-flex items-center gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 mb-4 flex-wrap">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
              tab === t.key ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
            }`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {tab === "units" && (
        <EntryTable kind="unit" title="Operating areas / units" entries={book.units} canWrite={canWrite}
          codeHint='Unit number — "20"' labelHint='Name — "Crude Unit"'
          orgId={activeOrgId!} uid={uid!} onChanged={refresh} onError={setError} />
      )}
      {tab === "equipment" && (
        <EntryTable kind="equipment_type" title="Equipment type codes" entries={book.equipmentTypes} canWrite={canWrite}
          codeHint='Type code — "30"' labelHint='Label — "Exchangers"' withPrefixes
          orgId={activeOrgId!} uid={uid!} onChanged={refresh} onError={setError} />
      )}
      {tab === "drawings" && (
        <EntryTable kind="drawing_type" title="Drawing / document type codes" entries={book.drawingTypes} canWrite={canWrite}
          codeHint='Type code — "02"' labelHint='Label — "P&ID"'
          orgId={activeOrgId!} uid={uid!} onChanged={refresh} onError={setError} />
      )}
      {tab === "numbering" && (
        <NumberingTab book={book} canWrite={canWrite} orgId={activeOrgId!} uid={uid!} onChanged={refresh} onError={setError} />
      )}
      {tab === "legend" && (
        <LegendTab book={book} canWrite={canWrite} orgId={activeOrgId!} uid={uid!} onChanged={refresh} onError={setError} />
      )}

      {importOpen && activeOrgId && uid && (
        <ImportModal orgId={activeOrgId} uid={uid} book={book}
          onClose={() => setImportOpen(false)}
          onApplied={() => { setImportOpen(false); void refresh(); }} />
      )}
    </PageShell>
  );
}

function SetupStep({ done, n, label, onGo, goLabel, optional }: {
  done: boolean; n: number; label: React.ReactNode; onGo: () => void; goLabel: string; optional?: boolean;
}) {
  return (
    <li className="flex items-start gap-2">
      {done ? (
        <span className="shrink-0 w-4 h-4 rounded-full bg-emerald-500 text-white flex items-center justify-center mt-0.5"><Check className="w-2.5 h-2.5" /></span>
      ) : (
        <span className="shrink-0 w-4 h-4 rounded-full border border-[var(--color-border-strong)] text-[9px] font-black text-[var(--color-text-muted)] flex items-center justify-center mt-0.5">{n}</span>
      )}
      <span className={done ? "text-[var(--color-text-muted)] line-through decoration-emerald-500/40" : "text-[var(--color-text)]"}>
        {label}{optional && !done && <span className="text-[var(--color-text-faint)]"> (optional)</span>}
      </span>
      {!done && (
        <button onClick={onGo} className="ml-auto shrink-0 text-[11px] font-bold text-[var(--color-accent)] hover:underline">{goLabel} →</button>
      )}
    </li>
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
    } catch (e) { onError((e as Error).message); }
    finally { setBusy(false); }
  };

  const remove = async (e: CodebookEntry) => {
    const ok = await appConfirm({
      title: `Remove ${e.code} — ${e.label}?`,
      message: "Features stop recognizing this code. Nothing else is deleted.",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    try { await deleteEntry(e.id); onChanged(); } catch (err) { onError((err as Error).message); }
  };

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[var(--color-border)] text-xs font-black text-[var(--color-text)]">{title} · {entries.length}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-[var(--color-surface-2)] text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
            <tr>
              <th className="text-left px-4 py-1.5 w-24">Code</th>
              <th className="text-left px-2 py-1.5">Label</th>
              {withPrefixes && <th className="text-left px-2 py-1.5 w-40">Tag prefixes</th>}
              <th className="text-left px-2 py-1.5 w-20">Origin</th>
              {canWrite && <th className="w-10" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {entries.map((e) => (
              <EntryRow key={e.id} entry={e} withPrefixes={withPrefixes} canWrite={canWrite}
                orgId={orgId} uid={uid} onChanged={onChanged} onError={onError} onRemove={() => void remove(e)} />
            ))}
            {entries.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-4 text-[var(--color-text-muted)] italic">
                Nothing defined yet — add rows below, or use “Build from a document” to import your written standard.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      {canWrite && (
        <div className="px-4 py-2.5 border-t border-[var(--color-border)] flex items-center gap-2 flex-wrap bg-[var(--color-surface-2)]/50">
          <Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder={codeHint} className="w-32 font-mono" />
          <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder={labelHint} className="w-56" />
          {withPrefixes && (
            <Input value={draft.prefixes} onChange={(e) => setDraft({ ...draft, prefixes: e.target.value })} placeholder='Prefixes — "E" or "EA, E"' className="w-40 font-mono" />
          )}
          <Button size="sm" onClick={() => void add()} disabled={busy || !draft.code.trim() || !draft.label.trim()}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add
          </Button>
        </div>
      )}
    </div>
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
    } catch (e) { onError((e as Error).message); }
  };

  return (
    <tr className="hover:bg-[var(--color-surface-2)]/50">
      <td className="px-4 py-1.5 font-mono font-black text-[var(--color-text)]">{entry.code}</td>
      <td className="px-2 py-1.5">
        {editing
          ? <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-7" />
          : <button className={`text-left ${canWrite ? "hover:text-[var(--color-accent)]" : "cursor-default"}`} onClick={() => canWrite && setEditing(true)}>{entry.label}</button>}
      </td>
      {withPrefixes && (
        <td className="px-2 py-1.5 font-mono">
          {editing
            ? <Input value={prefixes} onChange={(e) => setPrefixes(e.target.value)} className="h-7 font-mono" />
            : (entry.meta.tagPrefixes ?? []).map((p) => <span key={p} className="inline-block mr-1 px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] font-bold">{p}-</span>)}
        </td>
      )}
      <td className="px-2 py-1.5">
        {entry.origin === "import" && <span className="text-[9px] font-black uppercase tracking-wider text-violet-600 bg-violet-50 border border-violet-200 rounded px-1 py-0.5">imported</span>}
      </td>
      {canWrite && (
        <td className="px-2 py-1.5">
          <div className="flex items-center gap-1">
            {editing ? (
              <>
                <button onClick={() => void save()} className="p-1 text-emerald-600 hover:bg-emerald-50 rounded" title="Save"><Check className="w-3.5 h-3.5" /></button>
                <button onClick={() => { setEditing(false); setLabel(entry.label); setPrefixes((entry.meta.tagPrefixes ?? []).join(", ")); }} className="p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] rounded" title="Cancel"><X className="w-3.5 h-3.5" /></button>
              </>
            ) : (
              <button onClick={onRemove} className="p-1 text-[var(--color-text-faint)] hover:text-rose-600 hover:bg-rose-50 rounded" title="Remove"><Trash2 className="w-3.5 h-3.5" /></button>
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
        iterableRule: { mirrorsTag: true, padTo: Math.max(0, Math.min(6, padTo)) },
      }, uid);
      setSaved(true); setTimeout(() => setSaved(false), 1800);
      onChanged();
    } catch (e) { onError((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="text-xs font-black text-[var(--color-text)] mb-1">Drawing number segments — in order</div>
        <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
          Describe your convention piece by piece; separators (dashes, dots, “SHT”) are handled automatically.
          Example: Unit (2) → Drawing type (2) → Paper size (1) → Number → Sheet reads <span className="font-mono">2002-D-10001 SHT.4</span>.
        </p>
        <div className="space-y-1.5">
          {segments.map((seg, i) => (
            <div key={i} className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-black text-[var(--color-text-faint)] w-4">{i + 1}.</span>
              <select value={seg.kind} disabled={!canWrite}
                onChange={(e) => setSegments(segments.map((s, j) => j === i ? { kind: e.target.value as DrawingSegment["kind"], digits: 2, letters: 1 } : s))}
                className="h-8 px-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs font-bold">
                {SEGMENT_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
              </select>
              {(seg.kind === "unit" || seg.kind === "drawing_type") && (
                <label className="text-[11px] text-[var(--color-text-muted)] inline-flex items-center gap-1">
                  digits <Input type="number" value={seg.digits ?? 2} disabled={!canWrite} min={1} max={4}
                    onChange={(e) => setSegments(segments.map((s, j) => j === i ? { ...s, digits: Math.max(1, Math.min(4, Number(e.target.value) || 2)) } : s))}
                    className="w-14 h-8" />
                </label>
              )}
              {seg.kind === "size" && (
                <label className="text-[11px] text-[var(--color-text-muted)] inline-flex items-center gap-1">
                  letters <Input type="number" value={seg.letters ?? 1} disabled={!canWrite} min={1} max={3}
                    onChange={(e) => setSegments(segments.map((s, j) => j === i ? { ...s, letters: Math.max(1, Math.min(3, Number(e.target.value) || 1)) } : s))}
                    className="w-14 h-8" />
                </label>
              )}
              {canWrite && (
                <button onClick={() => setSegments(segments.filter((_, j) => j !== i))}
                  className="p-1 text-[var(--color-text-faint)] hover:text-rose-600 rounded" title="Remove segment">
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

      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="text-xs font-black text-[var(--color-text)] mb-2">Live preview — paste one of your real drawing numbers</div>
        <Input value={sample} onChange={(e) => setSample(e.target.value)} className="font-mono max-w-md" placeholder="2002-D-10001 SHT.4" />
        <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px]">
          {segments.length === 0 ? (
            <span className="text-[var(--color-text-muted)] italic">Add segments above to see the decode.</span>
          ) : !parsed ? (
            <span className="inline-flex items-center gap-1 text-rose-700 font-bold"><AlertTriangle className="w-3.5 h-3.5" /> Doesn&apos;t match the segments — adjust the map or the sample.</span>
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

      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 flex items-center gap-4 flex-wrap">
        <div>
          <div className="text-xs font-black text-[var(--color-text)]">Code iterable padding</div>
          <p className="text-[11px] text-[var(--color-text-muted)]">E-5 → .5 with no padding; set 2 for .05 style.</p>
        </div>
        <label className="text-[11px] text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
          pad to <Input type="number" value={padTo} disabled={!canWrite} min={0} max={6}
            onChange={(e) => setPadTo(Math.max(0, Math.min(6, Number(e.target.value) || 0)))} className="w-14 h-8" /> digits
        </label>
        {canWrite && (
          <Button size="sm" className="ml-auto" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
            {saved ? "Saved" : "Save numbering"}
          </Button>
        )}
      </div>
    </div>
  );
}

function PreviewChip({ label, value, extra }: { label: string; value: string | null; extra?: string | null }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg border font-bold ${value ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text-faint)]"}`}>
      <span className="text-[9px] uppercase tracking-wider opacity-70">{label}</span>
      <span className="font-mono">{value ?? "—"}</span>
      {extra && <span className="opacity-80">· {extra}</span>}
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
    catch (e) { onError((e as Error).message); }
  };

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 max-w-2xl">
      <div className="text-xs font-black text-[var(--color-text)] mb-1">Symbols legend / decoder sheets · {book.legendDocIds.length} of 3</div>
      <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
        Attach your P&ID legend sheets (indexed in any knowledge library). Every knowledge library inherits them automatically, so the AI can read your symbols when it answers.
      </p>
      <div className="space-y-1.5 mb-3">
        {book.legendDocIds.map((id) => (
          <div key={id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]/60">
            <FileText className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
            <span className="text-xs font-bold text-[var(--color-text)] truncate flex-1">{names.get(id) ?? id}</span>
            {canWrite && (
              <button onClick={() => void setLegend(book.legendDocIds.filter((x) => x !== id))}
                className="p-1 text-[var(--color-text-faint)] hover:text-rose-600 rounded" title="Detach">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
        {book.legendDocIds.length === 0 && <div className="text-[11px] text-[var(--color-text-muted)] italic">No legend attached yet.</div>}
      </div>
      {canWrite && book.legendDocIds.length < 3 && (
        <div>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search indexed documents by name…" />
          {results.length > 0 && (
            <div className="mt-1 rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
              {results.map((r) => (
                <button key={r.id} onClick={() => { setQuery(""); void setLegend([...book.legendDocIds, r.id]); }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-surface-2)] flex items-center gap-2">
                  <Plus className="w-3 h-3 text-emerald-600" /> {r.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
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
  const [pickedFile, setPickedFile] = useState<{ name: string; base64: string } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<ImportDiff | null>(null);
  const [notes, setNotes] = useState("");
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const handleFile = async (file: File) => {
    setError(null);
    if (file.size > 3_000_000) {
      setError(`"${file.name}" is over the 3 MB upload limit — index it in a knowledge library instead, then pick it from the search below.`);
      return;
    }
    const buf = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    setPickedFile({ name: file.name, base64: btoa(binary) });
    setPickedDoc(null);
  };

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
    setRunning(true); setError(null); setDiff(null); setProgress("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` };
      const post = async (payload: Record<string, unknown>) => {
        const res = await fetch("/api/codebook/import", { method: "POST", headers, body: JSON.stringify(payload) });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
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
        setProgress("Reading the document…");
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
      if (!sourceText && visionPages === 0) throw new Error("Nothing to read — upload a file, paste text, or pick a document.");

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
          const pages: number[] = [];
          for (let p = start; p < start + VISION_BATCH && p <= visionPages; p++) pages.push(p);
          const label = pages.length === 1 ? `page ${pages[0]}` : `pages ${pages[0]}–${pages[pages.length - 1]}`;
          setProgress(`Reading ${label} of ${pageCount} visually…`);
          const payload = {
            orgId, action: "propose-vision", pages,
            fileBase64: pickedFile?.base64, fileName: pickedFile?.name,
            partLabel: pageCount > pages.length ? label : undefined,
          };
          try {
            const r = await post(payload).catch(() => post(payload)); // one retry
            allProposals.push(...(r.proposals ?? []));
            if (r.notes) allNotes.push(String(r.notes));
          } catch {
            failedParts.push(label);
          }
        }
        if (pageCount > visionPages) {
          allNotes.push(`Only the first ${visionPages} of ${pageCount} pages were read visually — split the PDF and re-run for the rest.`);
        }
      } else {
        const chunks = chunkText(sourceText);
        for (let i = 0; i < chunks.length; i++) {
          setProgress(chunks.length > 1 ? `Extracting codes — part ${i + 1} of ${chunks.length}…` : "Extracting codes…");
          const payload = {
            orgId, text: chunks[i],
            partLabel: chunks.length > 1 ? `part ${i + 1} of ${chunks.length}` : undefined,
          };
          try {
            const r = await post(payload).catch(() => post(payload)); // one retry
            allProposals.push(...(r.proposals ?? []));
            if (r.notes) allNotes.push(String(r.notes));
          } catch {
            failedParts.push(`part ${i + 1}`);
          }
        }
      }
      if (allProposals.length === 0 && failedParts.length > 0) {
        throw new Error(`Every part failed (${failedParts.length}) — check your AI key in AI settings and try again.`);
      }

      const existing = [...book.units, ...book.equipmentTypes, ...book.drawingTypes];
      const d = diffImport(existing, allProposals);
      setDiff(d);
      setNotes([...new Set(allNotes)].slice(0, 2).join(" — "));
      if (failedParts.length > 0) {
        setError(`${failedParts.join(", ")} of the document couldn't be read — the proposal below may be incomplete. Apply what's here and re-run for the rest.`);
      }
      // Adds + changes start accepted; unchanged needs no action.
      setAccepted(new Set([...d.adds.map(keyOf), ...d.changes.map((c) => keyOf(c.proposed))]));
    } catch (e) { setError((e as Error).message); }
    finally { setRunning(false); setProgress(""); }
  };

  const apply = async () => {
    if (!diff) return;
    setApplying(true); setError(null);
    try {
      const rows = [...diff.adds, ...diff.changes.map((c) => c.proposed)].filter((p) => accepted.has(keyOf(p)));
      await applyImport(orgId, rows, uid);
      onApplied();
    } catch (e) { setError((e as Error).message); setApplying(false); }
  };

  const toggle = (k: string) => setAccepted((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const KIND_LABEL: Record<string, string> = { unit: "Unit", equipment_type: "Equipment", drawing_type: "Drawing" };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4 animate-in fade-in">
      <div className="w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-2xl flex flex-col max-h-[88vh] animate-in zoom-in-95">
        <div className="px-5 py-3.5 border-b border-[var(--color-border)] flex items-center gap-2.5">
          <Sparkles className="w-4 h-4 text-violet-600" />
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">Build the codebook from a document</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">Runs on your own AI key. Nothing is written until you review and apply.</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4 text-[var(--color-text-muted)]" /></button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">
          {!diff && (
            <>
              <div>
                <div className="text-[11px] font-black text-[var(--color-text)] mb-1">Upload your standard</div>
                <input ref={fileInputRef} type="file" className="hidden"
                  accept=".pdf,.docx,.txt,.md,.csv,.tsv,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ""; }} />
                {pickedFile ? (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-200 bg-emerald-50 text-xs font-bold text-emerald-900">
                    <FileText className="w-3.5 h-3.5" /> {pickedFile.name}
                    <button onClick={() => setPickedFile(null)} className="ml-auto p-0.5 hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ) : (
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void handleFile(f); }}
                    className="w-full border-2 border-dashed border-[var(--color-border-strong)] rounded-xl px-4 py-5 text-center hover:border-violet-300 hover:bg-violet-50/40 transition-colors"
                  >
                    <div className="text-xs font-bold text-[var(--color-text)]">Drop your standards document here, or click to pick</div>
                    <div className="text-[10px] text-[var(--color-text-muted)] mt-0.5">PDF, Word (.docx), TXT, CSV, MD · up to 3 MB · CAD-exported and scanned PDFs are read visually, page by page</div>
                  </button>
                )}
              </div>
              <div className="text-center text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">or</div>
              <div>
                <div className="text-[11px] font-black text-[var(--color-text)] mb-1">Paste your standard</div>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7}
                  placeholder={"Paste the unit list / identifier tables / numbering convention…\n\ne.g.  20  Crude Unit\n      25  DHT\n      Equipment: 30 Exchangers (E-), 10 Vessels (V-) …"}
                  className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 px-3 py-2 text-xs font-mono resize-y" />
              </div>
              <div className="text-center text-[10px] font-black uppercase tracking-widest text-[var(--color-text-faint)]">or</div>
              <div>
                <div className="text-[11px] font-black text-[var(--color-text)] mb-1">Pick an indexed document</div>
                {pickedDoc ? (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-200 bg-emerald-50 text-xs font-bold text-emerald-900">
                    <FileText className="w-3.5 h-3.5" /> {pickedDoc.name}
                    <button onClick={() => setPickedDoc(null)} className="ml-auto p-0.5 hover:text-rose-600"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ) : (
                  <>
                    <Input value={docQuery} onChange={(e) => setDocQuery(e.target.value)} placeholder="Search your knowledge libraries…" />
                    {docResults.length > 0 && (
                      <div className="mt-1 rounded-lg border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
                        {docResults.map((r) => (
                          <button key={r.id} onClick={() => { setPickedDoc(r); setDocQuery(""); }}
                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-surface-2)]">{r.name}</button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
            </div>
          )}

          {diff && (
            <>
              <div className="text-xs text-[var(--color-text-muted)]">
                <b className="text-[var(--color-text)]">{diff.adds.length}</b> new · <b className="text-[var(--color-text)]">{diff.changes.length}</b> changed · {diff.unchanged.length} already match — check what to apply.
              </div>
              {notes && (
                <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-[11px] text-sky-900">
                  <b>AI notes on your numbering convention:</b> {notes} <span className="opacity-70">(configure segments in the Drawing numbers tab.)</span>
                </div>
              )}
              <div className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] max-h-72 overflow-y-auto">
                {[...diff.adds.map((p) => ({ p, change: null as null | CodebookEntry })),
                  ...diff.changes.map((c) => ({ p: c.proposed, change: c.existing }))].map(({ p, change }) => {
                  const k = keyOf(p);
                  return (
                    <label key={k} className="flex items-center gap-2.5 px-3 py-2 text-xs cursor-pointer hover:bg-[var(--color-surface-2)]/60">
                      <input type="checkbox" checked={accepted.has(k)} onChange={() => toggle(k)} className="w-3.5 h-3.5 accent-[var(--color-accent)]" />
                      <span className="text-[9px] font-black uppercase tracking-wider text-[var(--color-text-faint)] w-16">{KIND_LABEL[p.kind]}</span>
                      <span className="font-mono font-black text-[var(--color-text)] w-14">{p.code}</span>
                      <span className="font-bold text-[var(--color-text)] flex-1">{p.label}</span>
                      {p.tagPrefixes && p.tagPrefixes.length > 0 && <span className="font-mono text-[var(--color-text-muted)]">{p.tagPrefixes.join(", ")}-</span>}
                      {change && <span className="text-[9px] font-black uppercase text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5" title={`Currently: ${change.label}`}>replaces “{change.label}”</span>}
                    </label>
                  );
                })}
                {diff.adds.length === 0 && diff.changes.length === 0 && (
                  <div className="px-3 py-4 text-xs text-[var(--color-text-muted)] italic">Nothing new — the codebook already matches this document.</div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-3 py-1.5">Cancel</button>
          {!diff ? (
            <Button onClick={() => void run()} disabled={running || (!text.trim() && !pickedDoc && !pickedFile)}>
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {running && progress ? progress : "Read & propose"}
            </Button>
          ) : (
            <Button onClick={() => void apply()} disabled={applying || accepted.size === 0}>
              {applying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Apply {accepted.size} row{accepted.size === 1 ? "" : "s"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
