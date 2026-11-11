"use client";

// /documents/connectors - off-page connectors checked against the sheets
// they point at (lib/drawingConnectors), for the drafting department: sheets
// a connector points to that are not on file, tags a connector names that
// are not on the target sheet, and sheet pairs where only one side shows
// the line. Every line opens the sheet. Reads only.

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Download, FileQuestion, Loader2, Split, Tag, Unplug } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/fetchAllRows";
import {
  checkConnectors, drawingOf, missingLine, oneWayLine, tagLine,
  type ConnectorChecks, type ConnectorRead, type SheetOnFile, type SheetRef,
} from "@/lib/drawingConnectors";

type View = "missing" | "tag" | "oneway";

async function load(orgId: string): Promise<ConnectorChecks> {
  const docs = await fetchAllRows<{ id: string; library_id: string; document_number: string | null; name: string | null; sheet: string | null; status: string | null }>((from, to) =>
    supabase.from("documents").select("id, library_id, document_number, name, status, sheet:metadata->>sheet").eq("org_id", orgId).order("id").range(from, to));
  if (docs.error) throw new Error(docs.error);
  // Drawings: documents whose number is a drawing number, still current.
  const sheets: SheetOnFile[] = docs.rows
    .filter((d) => d.document_number && drawingOf(d.document_number) && !["Archived", "Superseded"].includes(d.status ?? ""))
    .map((d) => ({ id: d.id, libraryId: d.library_id, number: d.document_number!, sheet: d.sheet, name: d.name ?? "" }));
  const ids = new Set(sheets.map((s) => s.id));
  const mirrors = await fetchAllRows<{ id: string; source_document_id: string | null }>((from, to) =>
    supabase.from("knowledge_documents").select("id, source_document_id").eq("org_id", orgId).not("source_document_id", "is", null).order("id").range(from, to));
  if (mirrors.error) throw new Error(mirrors.error);
  const toDoc = new Map(mirrors.rows.filter((m) => m.source_document_id && ids.has(m.source_document_id)).map((m) => [m.id, m.source_document_id!]));
  const reads: ConnectorRead[] = [];
  const tagsOn = new Map<string, string[]>();
  const mirrorIds = [...toDoc.keys()];
  for (let i = 0; i < mirrorIds.length; i += 60) {
    const slice = mirrorIds.slice(i, i + 60);
    const ents = await fetchAllRows<{ document_id: string; page: number; kind: string; tag: string; raw: string | null }>((from, to) =>
      supabase.from("knowledge_page_entities").select("document_id, page, kind, tag, raw").in("document_id", slice).in("kind", ["xref", "equipment", "instrument"]).order("id").range(from, to));
    if (ents.error) throw new Error(ents.error);
    for (const e of ents.rows) {
      const doc = toDoc.get(e.document_id);
      if (!doc) continue;
      if (e.kind === "xref") reads.push({ sheetId: doc, page: e.page, tag: e.tag, raw: e.raw ?? "" });
      else tagsOn.set(doc, [...(tagsOn.get(doc) ?? []), e.tag]);
    }
  }
  return checkConnectors(sheets, reads, tagsOn);
}

const href = (s: SheetRef) => `/documents/${s.libraryId}?doc=${s.id}`;
const SheetLink = ({ s }: { s: SheetRef }) => <Link href={href(s)} className="font-bold text-[var(--color-text)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)] hover:decoration-solid">{s.label}</Link>;

export default function ConnectorChecksPage() {
  const { activeOrgId } = useRole();
  const [state, setState] = useState<{ org: string; checks: ConnectorChecks | null; error: string | null } | null>(null);
  const [view, setView] = useState<View>("missing");
  const [drawing, setDrawing] = useState<string>("");
  useEffect(() => {
    if (!activeOrgId) return;
    let live = true;
    void load(activeOrgId).then((checks) => { if (live) setState({ org: activeOrgId, checks, error: null }); })
      .catch((e: Error) => { if (live) setState({ org: activeOrgId, checks: null, error: e.message }); });
    return () => { live = false; };
  }, [activeOrgId]);
  const checks = state && state.org === activeOrgId ? state.checks : null;
  const error = state && state.org === activeOrgId ? state.error : null;

  // The drawing a line is about, to narrow to one unit's set.
  const drawOf = (label: string) => label.replace(/ sheet \d+$/, "");
  const drawings = useMemo(() => {
    if (!checks) return [];
    const n = new Map<string, number>();
    const add = (d: string) => n.set(d, (n.get(d) ?? 0) + 1);
    for (const m of checks.missingSheets) add(m.drawing);
    for (const t of checks.tagNotThere) add(drawOf(t.from.label));
    for (const o of checks.oneWay) add(drawOf(o.from.label));
    return [...n.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [checks]);
  const rows = useMemo(() => {
    if (!checks) return { missing: [], tag: [], oneway: [] };
    const ok = (d: string) => !drawing || d === drawing;
    return {
      missing: checks.missingSheets.filter((m) => ok(m.drawing)),
      tag: checks.tagNotThere.filter((t) => ok(drawOf(t.from.label))),
      oneway: checks.oneWay.filter((o) => ok(drawOf(o.from.label))),
    };
  }, [checks, drawing]);

  const download = () => {
    if (!checks) return;
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = [["Check", "Sheet", "Points to", "Tag", "What to look at"].map(q).join(",")];
    for (const m of rows.missing) for (const a of m.askedBy) lines.push(["Sheet not on file", a.from.label, `${m.drawing} sheet ${m.sheet}`, a.tag, missingLine(m)].map(q).join(","));
    for (const t of rows.tag) lines.push(["Tag not on the target sheet", t.from.label, t.to.label, t.tag, tagLine(t)].map(q).join(","));
    for (const o of rows.oneway) lines.push(["Only one side shows it", o.from.label, o.to.label, o.tags.join(" "), oneWayLine(o)].map(q).join(","));
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `connector checks${drawing ? ` ${drawing}` : ""}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const TABS: Array<{ id: View; label: string; n: number; Icon: typeof Tag; what: string }> = [
    { id: "missing", label: "Sheet not on file", n: rows.missing.length, Icon: FileQuestion, what: "A connector points to a sheet that is not in the library. Either the sheet is missing, or the connector names the wrong one." },
    { id: "tag", label: "Tag not on the target sheet", n: rows.tag.length, Icon: Tag, what: "A connector names a tag on another sheet, and that tag was not read there. Check the connector, or the target sheet." },
    { id: "oneway", label: "Only one side shows it", n: rows.oneway.length, Icon: Split, what: "One sheet shows lines to or from another, and the other shows none back. A connector is missing on one of them." },
  ];
  const cur = TABS.find((t) => t.id === view)!;
  const chip = (on: boolean) => `shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border text-[12.5px] font-bold transition-colors ${on ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"}`;

  return (
    <PageShell width="work">
      <ViewTabs title="Documents" tabs={DOCUMENT_VIEWS} />
      <PageHeaderBar icon={Unplug} title="Connector checks"
        subtitle={<>Every off-page connector read from the drawings, checked against the sheet it points at.</>} />

      {error && <div role="alert" className="mb-3 rounded-xl border border-rose-200 bg-rose-50 dark:bg-rose-950/30 dark:border-rose-800 px-3 py-2 text-[12.5px] font-bold text-rose-800 dark:text-rose-200">The connectors could not be read: {error}</div>}
      {!checks && !error && <div className="py-16 flex items-center justify-center gap-2 text-[13px] text-[var(--color-text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Reading the connectors</div>}

      {checks && (
        <div className="space-y-3" data-connector-checks>
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm px-4 py-3 text-[13px] text-[var(--color-text)]">
            <b>{checks.connectors.toLocaleString()}</b> connectors on <b>{checks.sheets}</b> sheets. <b className="text-emerald-700 dark:text-emerald-300">{checks.holds.toLocaleString()}</b> check out: the sheet is on file and carries the tag.
            {(checks.unchecked.noTarget + checks.unchecked.noSheetRecorded + checks.unchecked.targetNotRead) > 0 && (
              <span className="block mt-1 text-[12px] text-[var(--color-text-muted)]">
                Not checked: {[
                  checks.unchecked.noTarget ? `${checks.unchecked.noTarget} with no sheet to go to that could be read` : null,
                  checks.unchecked.noSheetRecorded ? `${checks.unchecked.noSheetRecorded} on ${checks.unchecked.noSheetDrawings.join(", ")}, which has no sheet number recorded` : null,
                  checks.unchecked.targetNotRead ? `${checks.unchecked.targetNotRead} pointing at sheets not read yet` : null,
                ].filter(Boolean).join("; ")}.
              </span>
            )}
          </div>

          <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="tablist" aria-label="Checks">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={view === t.id} onClick={() => setView(t.id)} className={chip(view === t.id)}>
                <t.Icon className="w-3.5 h-3.5" /> {t.label} <span className="tabular-nums text-[var(--color-text-muted)]">{t.n}</span>
              </button>
            ))}
          </div>
          {drawings.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto pb-0.5" aria-label="Drawing">
              <button type="button" aria-pressed={!drawing} onClick={() => setDrawing("")} className={chip(!drawing)}>All drawings</button>
              {drawings.map(([d, n]) => <button key={d} type="button" aria-pressed={drawing === d} onClick={() => setDrawing(drawing === d ? "" : d)} className={chip(drawing === d)}>{d} <span className="tabular-nums text-[var(--color-text-muted)]">{n}</span></button>)}
            </div>
          )}

          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-start gap-3 flex-wrap">
              <p className="min-w-0 flex-1 basis-64 text-[12.5px] text-[var(--color-text-muted)]">{cur.what}</p>
              <button type="button" onClick={download} className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[12.5px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"><Download className="w-3.5 h-3.5" /> Download the list</button>
            </div>
            {cur.n === 0 ? <div className="px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">Nothing found{drawing ? ` on ${drawing}` : ""}.</div> : (
              <ul className="divide-y divide-[var(--color-border)] text-[13px]">
                {view === "missing" && rows.missing.map((m) => (
                  <li key={`${m.drawing}|${m.sheet}`} className="px-4 py-2.5">
                    <div className="font-bold text-[var(--color-text)]">{m.drawing} sheet {m.sheet} <span className="font-normal text-[var(--color-text-muted)]">is not on file</span></div>
                    <ul className="mt-1 space-y-0.5 text-[12.5px] text-[var(--color-text-muted)]">
                      {m.askedBy.map((a, i) => <li key={i}><SheetLink s={a.from} /> shows <b className="text-[var(--color-text)]">{a.tag}</b> {a.direction === "to" ? "going to" : "coming from"} it</li>)}
                    </ul>
                  </li>
                ))}
                {view === "tag" && rows.tag.map((t, i) => (
                  <li key={i} className="px-4 py-2.5">
                    <div className="text-[var(--color-text)]"><SheetLink s={t.from} /> shows <b>{t.tag}</b> {t.direction === "to" ? "going to" : "coming from"} <SheetLink s={t.to} /></div>
                    <div className="mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">{t.tag} was not read on that sheet. On the drawing: <span className="font-mono">{t.raw}</span></div>
                  </li>
                ))}
                {view === "oneway" && rows.oneway.map((o, i) => (
                  <li key={i} className="px-4 py-2.5">
                    <div className="text-[var(--color-text)]"><SheetLink s={o.from} /> {o.direction === "to" ? "sends" : "takes"} {o.count} line{o.count === 1 ? "" : "s"} {o.direction === "to" ? "to" : "from"} <SheetLink s={o.to} /> <span className="text-[var(--color-text-muted)]">({o.tags.join(", ")})</span></div>
                    <div className="mt-0.5 text-[12.5px] text-[var(--color-text-muted)]">That sheet shows nothing {o.direction === "to" ? "coming from" : "going to"} it.</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-[11.5px] text-[var(--color-text-muted)]">From what was read off each sheet. A tag the reader missed shows here as not on the sheet: the drawing settles it.</p>
        </div>
      )}
    </PageShell>
  );
}
