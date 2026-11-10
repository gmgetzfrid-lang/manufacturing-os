"use client";

// FindPanel - one search, the same in Documents, the Document Control widget
// and the top search bar's page. Results stay where you searched:
//
//   "E-22 is on 3 units. Which one?"   each with unit, ID, description and
//                                      how many documents it is on; the unit
//                                      of the folder you're in is picked
//   its documents                      with what else is on each
//   other equipment, documents, folders, words inside the documents
//   the map                            follows the folder, flies to the pick
//   the preview                        beside the list (under the row when
//                                      the box is narrow)

import React from "react";
import Link from "next/link";
import { Folder, Loader2, Search, Wrench, FileText } from "lucide-react";
import DocThumb from "@/components/documents/DocThumb";
import FindMap from "./FindMap";
import FindPreview from "./FindPreview";
import type { FindState } from "./useFind";
import {
  whichOneLine, equipLabel, docLabel, docMeta, otherDocs, plural,
  type FindEquip, type FindDoc, type FindFolder,
} from "@/lib/findEverywhere";

interface Props {
  orgId: string;
  f: FindState;
  /** The unit of the folder you're in (the map follows it). */
  unit: string | null;
  /** Smaller type and map, for the widget. */
  compact?: boolean;
  onOpenFolder: (folder: FindFolder) => void;
  /** A document picked on the map that isn't in the results. */
  onOpenHref?: (href: string) => void;
}

const UNIT_CLS = "shrink-0 w-8 h-8 rounded-full grid place-items-center text-[11px] font-black text-white";

function UnitDot({ e, on }: { e: Pick<FindEquip, "unitCode">; on?: boolean }) {
  return <span className={UNIT_CLS} style={{ background: on ? "#7c3aed" : "#a78bfa" }}>{e.unitCode ?? "?"}</span>;
}

/** ts_headline marks the matched words with <b>; show them, never as HTML. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<b>[\s\S]*?<\/b>)/g);
  return (
    <>
      {parts.map((p, i) => p.startsWith("<b>")
        ? <mark key={i} className="bg-yellow-100 dark:bg-yellow-900/40 text-inherit rounded px-0.5">{p.replace(/<\/?b>/g, "")}</mark>
        : <React.Fragment key={i}>{p.replace(/<\/?b>/g, "")}</React.Fragment>)}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[10.5px] font-black uppercase tracking-wider text-[var(--color-text-faint)]">{title}</div>
      {children}
    </div>
  );
}

function DocRow({ d, line, on, compact, onToggle, children }: { d: FindDoc; line?: React.ReactNode; on: boolean; compact?: boolean; onToggle: () => void; children?: React.ReactNode }) {
  return (
    <div>
      <button type="button" onClick={onToggle} data-find-doc={d.id}
        className={`w-full text-left flex items-center gap-2.5 rounded-xl border px-2.5 py-2 bg-[var(--color-surface)] transition-colors ${on ? "border-blue-500 ring-2 ring-blue-500/20" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)]"}`}>
        {compact ? <FileText className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" /> : <DocThumb documentId={d.id} width={30} />}
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-extrabold text-[var(--color-text)] break-words">{docLabel(d)}</span>
          <span className="block text-[11.5px] text-[var(--color-text-muted)] truncate">{[docMeta(d), d.folderName ?? (d.title && d.title !== d.number ? d.title : "")].filter(Boolean).join(" · ")}</span>
          {line && <span className="block text-[11.5px] text-[var(--color-text)] mt-0.5">{line}</span>}
        </span>
        <span className={`shrink-0 text-[11px] font-bold px-2 py-1 rounded-lg border ${on ? "border-blue-500 text-blue-600" : "border-[var(--color-border-strong)] text-[var(--color-text)]"}`}>{on ? "Showing" : "Preview"}</span>
      </button>
      {on && children}
    </div>
  );
}

function EquipRow({ e, on, onPick }: { e: FindEquip; on: boolean; onPick: () => void }) {
  // Tag and ID, then the unit, then what it is: never cut off, a tag alone
  // says nothing when three units have one.
  return (
    <button type="button" onClick={onPick} data-find-equip={e.id}
      className={`w-full text-left flex items-start gap-2.5 rounded-xl px-2.5 py-2 bg-[var(--color-surface)] transition-colors ${on ? "border-2 border-violet-600 bg-violet-50/60 dark:bg-violet-950/20" : "border border-[var(--color-border)] hover:border-violet-400"}`}>
      <UnitDot e={e} on={on} />
      <span className="min-w-0 flex-1">
        <span className="flex items-start gap-2">
          <b className="min-w-0 flex-1 text-[13px] font-black text-[var(--color-text)] break-words">{e.tag}{e.code && !e.tag.includes(e.code) ? ` · ${e.code}` : ""}</b>
          <span className="shrink-0 text-[11px] font-extrabold px-2 py-0.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)] whitespace-nowrap">{plural(e.docIds.length, "document")}</span>
        </span>
        <span className="block text-[12.5px] font-semibold text-[var(--color-text)] break-words">{e.unitLabel ?? (e.unitCode ? `Unit ${e.unitCode}` : "No unit set")}</span>
        <span className="block text-[11.5px] text-[var(--color-text-muted)] break-words">{[e.description, e.typeName].filter(Boolean).join(" · ") || "No description"}</span>
      </span>
    </button>
  );
}

export default function FindPanel({ orgId, f, unit, compact, onOpenFolder, onOpenHref }: Props) {
  const quick = f.quick;
  const picked = f.picked;
  const ask = whichOneLine(f.exact[0]?.tag ?? f.q, f.exact);
  const pickedDocs = f.pickedDocIds.map((id) => f.docs[id]).filter((d): d is FindDoc => !!d);
  const shown = new Set(pickedDocs.map((d) => d.id));
  const moreDocs = otherDocs(f.docOrder, shown).map((id) => f.docs[id]).filter((d): d is FindDoc => !!d);
  const exactIds = new Set(f.exact.map((e) => e.id));
  const moreEquip = (quick?.equipment ?? []).filter((e) => !exactIds.has(e.id) && e.id !== picked?.id);
  const nothing = !!quick && !f.loading && !f.deepLoading && !quick.equipment.length && !f.docOrder.length && !quick.folders.length;
  const pv = f.preview;
  // Equipment named the way this search names it: "E-22 (5630.01)".
  const equipName = new Map((quick?.equipment ?? []).map((e) => [`asset:${e.id}`, equipLabel(e)]));
  const why = (d: FindDoc): React.ReactNode => {
    const tags = new Set(d.tags ?? []);
    for (const r of d.rels ?? []) tags.add(equipName.get(r.node) ?? r.label);
    const has = [...tags];
    return (
      <>
        {has.length > 0 && <span className="block truncate">Has {has.slice(0, 6).join(", ")}{has.length > 6 ? ` and ${has.length - 6} more` : ""}</span>}
        {d.hit && <span className="block text-[var(--color-text-muted)] line-clamp-2 whitespace-normal">Page {d.hit.page}: <Snippet text={d.hit.text} /></span>}
      </>
    );
  };

  const preview = (doc: FindDoc, inline: boolean) => (
    <div className={inline ? "@2xl:hidden mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5" : ""}>
      <FindPreview doc={doc} onSheet={f.detail?.onSheet[doc.id]} equip={picked && shown.has(doc.id) ? picked : null}
        elsewhere={picked && shown.has(doc.id) ? pickedDocs : undefined} workOrders={picked && shown.has(doc.id) ? f.detail?.workOrders : undefined}
        onPreview={(id) => f.setPreview(id)} onClose={inline ? () => f.setPreview(null) : undefined} />
    </div>
  );

  return (
    <div className="@container" data-find-panel>
      <div className="grid gap-3 @2xl:grid-cols-[minmax(0,1fr)_minmax(260px,40%)]">
        {/* ── Results ───────────────────────────────────────────── */}
        <div className="min-w-0 space-y-3">
          {!quick && f.loading && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] py-3"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching…</div>
          )}
          {nothing && (
            <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] p-5 text-center text-sm text-[var(--color-text-muted)]">
              Nothing matches “{f.q}”. Try the equipment ID (like 5530.29), a drawing number, or a few words from the drawing.
            </div>
          )}

          {ask && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 dark:border-indigo-800 dark:bg-indigo-950/30 p-2.5 space-y-1.5" data-find-ask>
              <div className="text-[13px] font-black text-[var(--color-text)]">{ask}</div>
              {f.exact.map((e) => <EquipRow key={e.id} e={e} on={picked?.id === e.id} onPick={() => f.pick(e.id)} />)}
              {f.pickedByFolder && picked && (
                <div className="text-[11.5px] text-indigo-800 dark:text-indigo-300">{`You're in a ${picked.unitLabel ?? `unit ${picked.unitCode}`} folder, so that one is picked. Tap another to switch.`}</div>
              )}
            </div>
          )}

          {picked && (
            <Section title={`${equipLabel(picked)} · ${picked.unitLabel ?? (picked.unitCode ? `Unit ${picked.unitCode}` : "no unit")}: its documents`}>
              {!ask && (
                <div className="text-[12px] text-[var(--color-text-muted)] -mt-0.5">{[picked.description, picked.typeName].filter(Boolean).join(" · ")}</div>
              )}
              {pickedDocs.length === 0 ? (
                <div className="text-[12px] text-[var(--color-text-muted)] rounded-xl border border-dashed border-[var(--color-border)] p-3">No documents are tagged with {equipLabel(picked)} yet.</div>
              ) : pickedDocs.map((d) => {
                const also = f.detail?.onSheet[d.id] ?? [];
                return <DocRow key={d.id} d={d} on={pv?.id === d.id} compact={compact} onToggle={() => f.setPreview(pv?.id === d.id ? null : d.id)} line={<>
                  <span className="block truncate">Has <mark className="bg-yellow-100 dark:bg-yellow-900/40 text-inherit rounded px-0.5">{equipLabel(picked)}</mark>{also.length ? `, plus ${also.slice(0, 6).join(", ")}${also.length > 6 ? ` and ${also.length - 6} more` : ""}` : ""}</span>
                  {d.hit && <span className="block text-[var(--color-text-muted)] line-clamp-2 whitespace-normal">Page {d.hit.page}: <Snippet text={d.hit.text} /></span>}
                </>}>{preview(d, true)}</DocRow>;
              })}
              {(f.detail?.workOrders ?? []).map((w) => (
                <Link key={w.id} href={`/projects/${w.projectId}`} data-find-wo={w.id}
                  className="flex items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 hover:border-[var(--color-border-strong)]">
                  <Wrench className="w-4 h-4 shrink-0 text-[var(--color-text-faint)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-extrabold text-[var(--color-text)] truncate">{w.wo ? `Work order ${w.wo} · ` : ""}{w.name}</span>
                    <span className="block text-[11.5px] text-[var(--color-text-muted)] truncate">{w.projectName}{w.total ? ` · ${w.done} of ${w.total} steps done` : ""}</span>
                  </span>
                  <span className="shrink-0 text-[11px] font-bold px-2 py-1 rounded-lg border border-[var(--color-border-strong)] text-[var(--color-text)]">Open</span>
                </Link>
              ))}
            </Section>
          )}

          {moreEquip.length > 0 && (
            <Section title="Equipment">
              {moreEquip.slice(0, compact ? 4 : 8).map((e) => <EquipRow key={e.id} e={e} on={false} onPick={() => f.pick(e.id)} />)}
            </Section>
          )}

          {moreDocs.length > 0 && (
            <Section title={picked ? "Other documents" : "Documents"}>
              {moreDocs.slice(0, compact ? 6 : 15).map((d) => (
                <DocRow key={d.id} d={d} on={pv?.id === d.id} compact={compact} onToggle={() => f.setPreview(pv?.id === d.id ? null : d.id)}
                  line={why(d)}>{preview(d, true)}</DocRow>
              ))}
            </Section>
          )}

          {quick && quick.folders.length > 0 && (
            <Section title="Folders">
              {quick.folders.map((fo) => (
                <button key={fo.id} type="button" onClick={() => onOpenFolder(fo)}
                  className="w-full text-left flex items-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 hover:border-[var(--color-border-strong)]">
                  <Folder className="w-4 h-4 shrink-0 text-amber-500" fill="currentColor" fillOpacity={0.25} />
                  <span className="min-w-0 flex-1 text-[13px] font-bold text-[var(--color-text)] truncate">{fo.name}{fo.parentName ? <span className="font-normal text-[var(--color-text-muted)]"> in {fo.parentName}</span> : null}</span>
                </button>
              ))}
            </Section>
          )}

          {f.deepLoading && quick && (
            <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the tags on the sheets and the words inside the documents…</div>
          )}

          {!quick && !f.loading && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] py-2"><Search className="w-3.5 h-3.5" /> Type a tag (E-22), an equipment ID (5530.29), a drawing number, or words from the drawing.</div>
          )}
        </div>

        {/* ── The map, then the preview ─────────────────────────── */}
        <div className="min-w-0 space-y-3 @2xl:sticky @2xl:top-0 self-start">
          <FindMap orgId={orgId} unit={picked?.unitCode ?? unit} assetId={picked?.id ?? null} docs={pickedDocs}
            candidates={!picked && f.exact.length > 1 ? f.exact.map((e) => e.id) : undefined}
            onPickAsset={(id) => { if (quick?.equipment.some((e) => e.id === id)) f.pick(id); }}
            onDoc={(d) => { if (f.docs[d.id]) f.setPreview(d.id); else onOpenHref?.(d.href); }}
            className={compact ? "h-56" : "h-72"} />
          {pv && (
            <div className="hidden @2xl:block rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
              {preview(pv, false)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
