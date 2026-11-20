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

import React, { useState } from "react";
import Link from "next/link";
import { Folder, Loader2, Search, Wrench } from "lucide-react";
import DocThumb from "@/components/documents/DocThumb";
import FindMap from "./FindMap";
import DocInPlace from "@/components/documents/DocInPlace";
import type { FindState } from "./useFind";
import { docHref,
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
  /** The page shows the map itself (beside its list): leave it out here. */
  hideMap?: boolean;
  /** Equipment tapped on the map that this search didn't find: search it. */
  onSearchAsset?: (assetId: string, tag: string) => void;
  /** A unit tapped on the map. */
  onUnit?: (unitCode: string) => void;
}

/** What the map beside a search shows: the pick and its documents, or the
 *  candidates of an open "which one?". For pages that draw the map themselves. */
export function findMapState(f: FindState): { assetId: string | null; docs: FindDoc[]; candidates?: string[]; unit: string | null } {
  const docs = f.pickedDocIds.map((id) => f.docs[id]).filter((d): d is FindDoc => !!d);
  return {
    assetId: f.picked?.id ?? null, docs, unit: f.picked?.unitCode ?? null,
    candidates: !f.picked && f.exact.length > 1 ? f.exact.map((e) => e.id) : undefined,
  };
}

// The unit a piece of equipment is on, as a small graphite badge (filled
// when it is the one picked). No separate color: the unit is its code.
const UNIT_CLS = "shrink-0 min-w-8 h-8 px-1 rounded-md grid place-items-center font-display text-[13px] font-semibold tabular-nums";

function UnitDot({ e, on }: { e: Pick<FindEquip, "unitCode">; on?: boolean }) {
  return (
    <span className={`${UNIT_CLS} ${on ? "bg-[var(--color-text)] text-[var(--color-surface)]" : "border border-[var(--color-border-strong)] text-[var(--color-text)]"}`}>
      {e.unitCode ?? "?"}
    </span>
  );
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

/** A group of results: a heading over a rule, then ruled rows. */
function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="flex items-baseline gap-2 pb-1.5 border-b border-[var(--color-border-strong)] text-[15px] font-semibold text-[var(--color-text)]">
        {title}
        {count != null && <span className="font-display font-normal tabular-nums text-[var(--color-text-muted)]">{count}</span>}
      </h3>
      <ul className="divide-y divide-[var(--color-border)]">{children}</ul>
    </section>
  );
}

const openBtn = "shrink-0 inline-flex items-center justify-center h-8 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] hover:border-[var(--color-text-faint)] transition-colors";

/** A document found: Open shows it right here, over the page, and closing
 *  it leaves the search as it was. Folder goes to where it is filed. */
function DocRow({ d, line, compact, onOpen }: { d: FindDoc; line?: React.ReactNode; compact?: boolean; onOpen: () => void }) {
  return (
    <li className="flex items-center gap-3 py-2.5 min-w-0">
      {!compact && <DocThumb documentId={d.id} width={30} />}
      <button type="button" onClick={onOpen} data-find-doc={d.id} className="min-w-0 flex-1 text-left group">
        <span className="block font-display text-[15px] font-semibold tabular-nums text-[var(--color-text)] break-words group-hover:text-[var(--color-accent-text)]">{docLabel(d)}</span>
        <span className="block text-[13px] text-[var(--color-text-muted)] truncate">{[docMeta(d), d.folderName ?? (d.title && d.title !== d.number ? d.title : "")].filter(Boolean).join(", ")}</span>
        {line && <span className="block text-[13px] text-[var(--color-text)] mt-0.5">{line}</span>}
      </button>
      <button type="button" onClick={onOpen} className={openBtn} aria-label={`Open ${docLabel(d)}`}>Open</button>
      <Link href={docHref(d)} data-find-doc-folder={d.id} title={`Go to ${d.folderName ?? "where it is filed"}`}
        className="shrink-0 inline-flex items-center gap-1 text-[13px] text-[var(--color-accent-text)] hover:underline underline-offset-2">
        <Folder className="w-3.5 h-3.5" /> Folder
      </Link>
    </li>
  );
}

function EquipRow({ e, on, onPick }: { e: FindEquip; on: boolean; onPick: () => void }) {
  // Tag and ID, then the unit, then what it is: never cut off, a tag alone
  // says nothing when three units have one.
  return (
    <li>
      <button type="button" onClick={onPick} data-find-equip={e.id} aria-pressed={on}
        className={`w-full text-left flex items-start gap-3 py-2.5 px-2 -mx-2 rounded-md transition-colors ${on ? "bg-[var(--color-surface-2)]" : "hover:bg-[var(--color-surface-2)]"}`}>
        <UnitDot e={e} on={on} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 font-display text-[15px] font-semibold tabular-nums text-[var(--color-text)] break-words">{e.tag}{e.code && !e.tag.includes(e.code) ? `, ${e.code}` : ""}</span>
            <span className="shrink-0 text-[13px] text-[var(--color-text-muted)] whitespace-nowrap">{plural(e.docIds.length, "document")}</span>
          </span>
          <span className="block text-[14px] text-[var(--color-text)] break-words">{e.unitLabel ?? (e.unitCode ? `Unit ${e.unitCode}` : "No unit set")}</span>
          <span className="block text-[13px] text-[var(--color-text-muted)] break-words">{[e.description, e.typeName].filter(Boolean).join(", ") || "No description"}</span>
        </span>
      </button>
    </li>
  );
}

export default function FindPanel({ orgId, f, unit, compact, onOpenFolder, onOpenHref, hideMap, onSearchAsset, onUnit }: Props) {
  const quick = f.quick;
  const picked = f.picked;
  const ask = whichOneLine(f.exact[0]?.tag ?? f.q, f.exact);
  const pickedDocs = f.pickedDocIds.map((id) => f.docs[id]).filter((d): d is FindDoc => !!d);
  const shown = new Set(pickedDocs.map((d) => d.id));
  const moreDocs = otherDocs(f.docOrder, shown).map((id) => f.docs[id]).filter((d): d is FindDoc => !!d);
  const exactIds = new Set(f.exact.map((e) => e.id));
  const moreEquip = (quick?.equipment ?? []).filter((e) => !exactIds.has(e.id) && e.id !== picked?.id);
  const nothing = !!quick && !f.loading && !f.deepLoading && !quick.equipment.length && !f.docOrder.length && !quick.folders.length;
  // The document open over the page.
  const [openId, setOpenId] = useState<string | null>(null);
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

  return (
    <div className="@container" data-find-panel>
      {openId && <DocInPlace docId={openId} onClose={() => setOpenId(null)} />}
      <div className={`grid gap-6 ${!hideMap ? "@2xl:grid-cols-[minmax(0,1fr)_minmax(260px,40%)]" : ""}`}>
        {/* ── Results ───────────────────────────────────────────── */}
        <div className="min-w-0 space-y-5">
          {!quick && f.loading && (
            <div className="flex items-center gap-2 text-[14px] text-[var(--color-text-muted)] py-3"><Loader2 className="w-4 h-4 animate-spin" /> Searching…</div>
          )}
          {f.failed && (
            <p role="alert" className="border-l-[3px] border-[var(--state-overdue)] pl-3 text-[14px] text-[var(--state-overdue)]">
              Part of the search didn&apos;t answer, so some results may be missing. Change the search to try again.
            </p>
          )}
          {nothing && !f.failed && (
            <p className="py-2 text-[15px] text-[var(--color-text-muted)]">
              Nothing matches “{f.q}”. Try the equipment ID (like 5530.29), a drawing number, or a few words from the drawing.
            </p>
          )}

          {ask && (
            <section data-find-ask className="border-l-[3px] border-[var(--color-text)] pl-3">
              <h3 className="text-[15px] font-semibold text-[var(--color-text)]">{ask}</h3>
              <ul className="mt-1 divide-y divide-[var(--color-border)]">
                {f.exact.map((e) => <EquipRow key={e.id} e={e} on={picked?.id === e.id} onPick={() => f.pick(e.id)} />)}
              </ul>
              {f.pickedByFolder && picked && (
                <p className="mt-1 text-[13px] text-[var(--color-text-muted)]">{`You're in a ${picked.unitLabel ?? `unit ${picked.unitCode}`} folder, so that one is picked. Select another to switch.`}</p>
              )}
            </section>
          )}

          {picked && (
            <Section title={`${equipLabel(picked)}, ${picked.unitLabel ?? (picked.unitCode ? `Unit ${picked.unitCode}` : "no unit")}: its documents`} count={pickedDocs.length}>
              {!ask && [picked.description, picked.typeName].some(Boolean) && (
                <li className="py-2 text-[13px] text-[var(--color-text-muted)]">{[picked.description, picked.typeName].filter(Boolean).join(", ")}</li>
              )}
              {pickedDocs.length === 0 ? (
                <li className="py-2.5 text-[14px] text-[var(--color-text-muted)]">No documents are tagged with {equipLabel(picked)} yet.</li>
              ) : pickedDocs.map((d) => {
                const also = f.detail?.onSheet[d.id] ?? [];
                return <DocRow key={d.id} d={d} compact={compact} onOpen={() => setOpenId(d.id)} line={<>
                  <span className="block truncate">Has <mark className="bg-yellow-100 dark:bg-yellow-900/40 text-inherit rounded px-0.5">{equipLabel(picked)}</mark>{also.length ? `, plus ${also.slice(0, 6).join(", ")}${also.length > 6 ? ` and ${also.length - 6} more` : ""}` : ""}</span>
                  {d.hit && <span className="block text-[var(--color-text-muted)] line-clamp-2 whitespace-normal">Page {d.hit.page}: <Snippet text={d.hit.text} /></span>}
                </>} />;
              })}
              {(f.detail?.workOrders ?? []).map((w) => (
                <li key={w.id}>
                  <Link href={`/projects/${w.projectId}`} data-find-wo={w.id} className="flex items-center gap-3 py-2.5 group">
                    <Wrench className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent-text)]">{w.wo ? <><span className="font-display tabular-nums">Work order {w.wo}</span>, </> : ""}{w.name}</span>
                      <span className="block text-[13px] text-[var(--color-text-muted)] truncate">{w.projectName}{w.total ? `, ${w.done} of ${w.total} steps done` : ""}</span>
                    </span>
                    <span className={openBtn}>Open</span>
                  </Link>
                </li>
              ))}
            </Section>
          )}

          {moreEquip.length > 0 && (
            <Section title="Equipment" count={moreEquip.length}>
              {moreEquip.slice(0, compact ? 4 : 8).map((e) => <EquipRow key={e.id} e={e} on={false} onPick={() => f.pick(e.id)} />)}
            </Section>
          )}

          {moreDocs.length > 0 && (
            <Section title={picked ? "Other documents" : "Documents"} count={moreDocs.length}>
              {moreDocs.slice(0, compact ? 6 : 15).map((d) => (
                <DocRow key={d.id} d={d} compact={compact} onOpen={() => setOpenId(d.id)} line={why(d)} />
              ))}
              {moreDocs.length > (compact ? 6 : 15) && (
                <li className="py-2.5 text-[13px] text-[var(--color-text-muted)]">Showing {compact ? 6 : 15} of {moreDocs.length}. Add a word to the search to narrow it.</li>
              )}
            </Section>
          )}

          {quick && quick.folders.length > 0 && (
            <Section title="Folders" count={quick.folders.length}>
              {quick.folders.map((fo) => (
                <li key={fo.id}>
                  <button type="button" onClick={() => onOpenFolder(fo)}
                    className="w-full text-left flex items-center gap-3 py-2.5 group">
                    <Folder className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" fill="currentColor" fillOpacity={0.2} />
                    <span className="min-w-0 flex-1 text-[15px] font-semibold text-[var(--color-text)] truncate group-hover:text-[var(--color-accent-text)]">{fo.name}{fo.parentName ? <span className="font-normal text-[var(--color-text-muted)]"> in {fo.parentName}</span> : null}</span>
                  </button>
                </li>
              ))}
            </Section>
          )}

          {f.deepLoading && quick && (
            <div className="flex items-center gap-2 text-[14px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Reading the tags on the sheets and the words inside the documents…</div>
          )}

          {!quick && !f.loading && (
            <div className="flex items-center gap-2 text-[14px] text-[var(--color-text-muted)] py-2"><Search className="w-4 h-4" /> Type a tag (E-22), an equipment ID (5530.29), a drawing number, or words from the drawing.</div>
          )}
        </div>

        {/* ── The map ────────────────────────────────────────────── */}
        {!hideMap && (
        <div className="min-w-0 space-y-3 @2xl:sticky @2xl:top-0 self-start">
          {(
            <FindMap orgId={orgId} unit={picked?.unitCode ?? unit} assetId={picked?.id ?? null} docs={pickedDocs}
              candidates={!picked && f.exact.length > 1 ? f.exact.map((e) => e.id) : undefined}
              onPickAsset={(id, tag) => { if (quick?.equipment.some((e) => e.id === id)) f.pick(id); else onSearchAsset?.(id, tag); }}
              onUnit={onUnit}
              className={compact ? "h-64" : "h-[22rem]"} />
          )}
        </div>
        )}
      </div>
    </div>
  );
}
