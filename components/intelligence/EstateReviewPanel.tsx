"use client";

// EstateReviewPanel: the links the resolver was not sure enough to apply,
// as a ruled table: the link, why, who found it and how sure, and the
// choices.
// Approving an alias proposal teaches the alias; approving anything else
// makes the edge live. Dismissals are remembered.
//
// A name that says a unit can mean two things, and only a person knows
// which: it is that unit's own (belongs to), or it is a standard or
// reference filed elsewhere that covers it (applies to). Both are offered.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Link2, Check, X, Loader2, RefreshCw, Factory, Briefcase, Cpu, FolderOpen, Quote } from "lucide-react";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { useRole } from "@/components/providers/RoleContext";
import HelpTooltip from "@/components/ui/HelpTooltip";
import { Section, tbl, sheet, btnRow, btnQuiet, Pill } from "@/components/admin/kit";
import { listPendingEdges, decideEdge, declareEdge, estatePost } from "@/lib/estate/client";
import { labelNodes, type NodeLabel } from "@/lib/estate/labels";
import { addFinderAlias } from "@/lib/fileFinder/stores";
import { loadCodebook } from "@/lib/codebook";
import type { EstateEdge } from "@/lib/estate/ids";

const TYPE_LABEL: Record<string, string> = {
  belongs_to_unit: "belongs to unit", in_project: "is in project", project_scope: "project covers", about_asset: "is the folder for",
  tagged_to: "is about", filed_under: "is also filed under", alias_of: "is a nickname for", related: "is related to", applies_to: "applies to",
};
const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  belongs_to_unit: Factory, in_project: Briefcase, project_scope: Briefcase, about_asset: Cpu, tagged_to: Cpu, filed_under: FolderOpen, alias_of: Quote, related: Link2,
};

/** Where a proposal came from, in plain words. */
const HOW: Record<string, string> = {
  resolver: "worked out from names and folders", codebook: "from the Site Codebook", vision: "read off a page by AI", bridge: "equipment read from a drawing by AI",
  proposer: "suggested by AI", scanner: "found by a scan", human: "a person", person: "a person",
};

export default function EstateReviewPanel() {
  const { activeOrgId, activeRole, uid, userEmail } = useRole();
  const canDecide = ["Admin", "DocCtrl", "Manager", "Supervisor"].includes(activeRole ?? "");
  const [rows, setRows] = useState<EstateEdge[] | null>(null);
  const [labels, setLabels] = useState<Map<string, NodeLabel>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    const list = await listPendingEdges(activeOrgId, 300);
    setRows(list);
    setLabels(await labelNodes(activeOrgId, list.flatMap((e) => [e.a, e.b])));
  }, [activeOrgId]);
  useEffect(() => { void load().catch((e) => setNote((e as Error).message)); }, [load]);

  const decide = async (e: EstateEdge, approve: boolean) => {
    if (!activeOrgId) return;
    setBusy(e.id);
    try {
      if (approve && e.type === "alias_of" && e.a.startsWith("term:")) {
        const code = e.b.replace(/^cbunit:/, "");
        const book = await loadCodebook(activeOrgId);
        const u = book.units.find((x) => x.code === code);
        await addFinderAlias({ orgId: activeOrgId, term: String(e.evidence.term ?? e.a.slice(5).toLowerCase()), means: u?.label ?? code, kind: "unit", origin: "ingest", userId: uid, userName: userEmail });
      }
      await decideEdge(e.id, approve ? "applied" : "dismissed", { userId: uid, name: userEmail });
      setRows((prev) => (prev ?? []).filter((x) => x.id !== e.id));
    } catch (err) { setNote((err as Error).message); }
    finally { setBusy(null); }
  };

  // "Applies to": a standard or reference that covers the unit, filed elsewhere.
  const applies = async (e: EstateEdge) => {
    if (!activeOrgId) return;
    setBusy(e.id);
    try {
      const who = userEmail ?? "a person";
      await declareEdge({ orgId: activeOrgId, a: e.a, b: e.b, type: "applies_to", summary: `${L(e.a).label} applies to ${L(e.b).label} - marked by ${who}`, evidence: { from: "review", proposal: e.id }, actor: { userId: uid, name: userEmail } });
      await decideEdge(e.id, "dismissed", { userId: uid, name: userEmail });
      setRows((prev) => (prev ?? []).filter((x) => x.id !== e.id));
    } catch (err) { setNote((err as Error).message); }
    finally { setBusy(null); }
  };

  const run = async () => {
    if (!activeOrgId) return;
    setRunning(true); setNote(null);
    try {
      const r = await estatePost<{ folders: number; documents: number; applied: number; pending: number; unchanged: number; demoted?: number; removed?: number; notes: string[] }>("/api/estate/resolve", { orgId: activeOrgId, all: true });
      const checked = [r.demoted ? `${r.demoted} earlier link${r.demoted === 1 ? "" : "s"} no longer proven and moved here for you` : null, r.removed ? `${r.removed} with nothing behind them taken away` : null].filter(Boolean).join(", ");
      setNote(`Looked at ${r.folders} folders and ${r.documents} documents: ${r.applied} linked, ${r.pending} new here, ${r.unchanged} already decided.${checked ? ` Checked again: ${checked}.` : ""}${r.notes.length ? " " + r.notes.join(" ") : ""}`);
      await load();
    } catch (err) { setNote((err as Error).message); }
    finally { setRunning(false); }
  };

  const L = (id: string) => labels.get(id) ?? { label: id };
  const Node = ({ id }: { id: string }) => {
    const l = L(id);
    const name = l.href
      ? <Link href={l.href} className="font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{l.label}</Link>
      : <span className="font-semibold text-[var(--color-text)]">{l.label}</span>;
    return <span className="min-w-0">{name}{l.sub ? <span className="text-[14px] text-[var(--color-text-muted)]"> ({l.sub})</span> : null}</span>;
  };
  const sure = (e: EstateEdge) => e.tier === "strong" ? <Pill tone="brand">Likely</Pill>
    : e.tier === "inferred" ? <Pill tone="warn">A guess</Pill>
    : <Pill tone="good">Proven</Pill>;

  return (
    <Section
      label={<span className="inline-flex items-center gap-2">Links waiting for you{rows && rows.length > 0 && <span className="ui-count is-warn font-sans">{rows.length}</span>}
        <span className="font-sans font-normal text-[14px] leading-snug"><HelpTooltip>
          Only what is proven links by itself: a unit&apos;s number and name together (&ldquo;20 - Crude&rdquo;), a drawing number, a folder under a linked folder. A name on its own is asked here.
          <span className="block mt-1.5"><b>Belongs to</b>: it is that unit&apos;s own. <b>Applies to</b>: a standard or reference filed elsewhere that covers it.</span>
        </HelpTooltip></span>
      </span>}
      action={canDecide ? (
        <button type="button" onClick={run} disabled={running} title="Work the links out again. Links that are no longer proven come back here; a person's links are never touched." className={btnQuiet}>
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} {running ? "Checking" : "Check the links again"}
        </button>
      ) : undefined}
    >
      {note && <p role="status" className="mb-2.5 text-[14px] text-[var(--color-text-muted)] max-w-[90ch]">{note}</p>}
      {rows === null ? (
        <SkeletonRows rows={3} cols={2} what="the links" />
      ) : rows.length === 0 ? (
        <div className={`${sheet} px-4 py-4 flex flex-wrap items-center gap-x-3 gap-y-1`}>
          <Pill tone="good">Nothing waiting</Pill>
          <span className="text-[14px] text-[var(--color-text-muted)]">Check again after teaching aliases or adding units to the codebook.</span>
        </div>
      ) : (
        <div className={tbl.wrap}>
          <table className={tbl.table}>
            <thead className={`${tbl.thead} max-md:hidden`}>
              <tr>
                <th className={tbl.th}>Link</th>
                <th className={`${tbl.th} max-lg:hidden`}>Why</th>
                <th className={tbl.th}>Found by</th>
                {canDecide && <th className={`${tbl.th} w-[1%]`}><span className="sr-only">Decide</span></th>}
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {rows.map((e) => {
                const I = TYPE_ICON[e.type] ?? Link2;
                return (
                  <tr key={e.id} className={`${tbl.tr} max-md:flex max-md:flex-col max-md:py-1.5`}>
                    <td className={`${tbl.td} max-md:py-1 align-top`}>
                      <div className="flex items-start gap-2.5">
                        <span aria-hidden className="ui-icon-tile is-sm"><I className="w-4 h-4" /></span>
                        <div className="min-w-0 flex flex-wrap items-baseline gap-x-1.5">
                          <Node id={e.a} />
                          <span className="text-[14px] text-[var(--color-text-muted)]">{e.type === "belongs_to_unit" ? "and" : TYPE_LABEL[e.type] ?? e.type}</span>
                          <Node id={e.b} />
                        </div>
                      </div>
                      {e.summary && <div className="lg:hidden pl-[26px] mt-0.5 text-[14px] text-[var(--color-text-muted)] line-clamp-2">{e.summary}</div>}
                    </td>
                    <td className={`${tbl.td} align-top max-lg:hidden text-[14px] text-[var(--color-text-muted)] max-w-[44ch]`}>{e.summary || "-"}</td>
                    <td className={`${tbl.td} max-md:py-1 align-top whitespace-nowrap`}>
                      <div className="flex items-center gap-2 max-md:pl-[26px]">
                        {sure(e)}
                        <span className="md:hidden text-[13px] text-[var(--color-text-muted)]">{HOW[e.origin] ?? e.origin}</span>
                      </div>
                      <div className="max-md:hidden mt-0.5 text-[13px] text-[var(--color-text-muted)]">{HOW[e.origin] ?? e.origin}</div>
                      {e.createdByName && <div className="max-md:hidden text-[13px] text-[var(--color-text-muted)]">Run by {e.createdByName}</div>}
                    </td>
                    {canDecide && (
                      <td className={`${tbl.td} max-md:py-1 align-top`}>
                        <div className="flex flex-wrap md:flex-nowrap items-center md:justify-end gap-1.5 max-md:pl-[26px]">
                          <button type="button" onClick={() => decide(e, false)} disabled={busy === e.id} className={btnRow}><X className="w-3.5 h-3.5" /> No</button>
                          {e.type === "belongs_to_unit" && (
                            <button type="button" onClick={() => applies(e)} disabled={busy === e.id} className={btnRow}><Link2 className="w-3.5 h-3.5" /> Applies to</button>
                          )}
                          <button type="button" onClick={() => decide(e, true)} disabled={busy === e.id} className={btnRow}>
                            {busy === e.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} {e.type === "alias_of" ? "Teach" : e.type === "belongs_to_unit" ? "Belongs to" : "Link"}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
