"use client";

// ProjectScopePanel — what this project is ABOUT: the units, equipment and
// documents it covers, as estate edges with provenance. A person declares
// scope here; the resolver proposes it from AFE folders; the find service
// and the Intelligence graph read it. A project with no checkouts is no
// longer an island.

import HelpTooltip from "@/components/ui/HelpTooltip";
import { Card } from "@/components/ui/PageHero";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Factory, Cpu, FileText, Plus, X, Loader2, Link2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { loadCodebook } from "@/lib/codebook";
import { findAssetsByTag } from "@/lib/assets";
import { listEdgesFor, declareEdge, removeEdge, decideEdge } from "@/lib/estate/client";
import { labelNodes, type NodeLabel } from "@/lib/estate/labels";
import { nid, type EstateEdge } from "@/lib/estate/ids";
import { sayError } from "@/components/projects/sayError";

export default function ProjectScopePanel({ orgId, projectId, projectName, canManage }: { orgId: string; projectId: string; projectName: string; canManage: boolean }) {
  const { uid, userEmail } = useRole();
  const me = useMemo(() => ({ userId: uid, name: userEmail }), [uid, userEmail]);
  const node = nid.proj(projectId);
  const [edges, setEdges] = useState<EstateEdge[] | null>(null);
  const [labels, setLabels] = useState<Map<string, NodeLabel>>(new Map());
  const [units, setUnits] = useState<Array<{ code: string; label: string }>>([]);
  const [unitPick, setUnitPick] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = (await listEdgesFor(orgId, [node])).filter((e) => e.status !== "dismissed");
    setEdges(list);
    setLabels(await labelNodes(orgId, list.flatMap((e) => [e.a, e.b])));
  }, [orgId, node]);
  useEffect(() => { void load().catch((e) => setErr(sayError(e))); }, [load]);
  useEffect(() => { void loadCodebook(orgId).then((b) => setUnits(b.units.map((u) => ({ code: u.code, label: u.label })))).catch((e) => setErr(`Couldn't load the units: ${sayError(e)}`)); }, [orgId]);

  const scope = (edges ?? []).filter((e) => e.a === node && e.type === "project_scope");
  const members = (edges ?? []).filter((e) => e.b === node && e.type === "in_project");

  const addUnit = async () => {
    if (!unitPick) return;
    setBusy(true); setErr(null);
    try {
      const u = units.find((x) => x.code === unitPick);
      await declareEdge({ orgId, a: node, b: nid.cbunit(unitPick), type: "project_scope", summary: `Project "${projectName}" covers ${u?.label ?? unitPick} (${unitPick}) - set by hand`, actor: me });
      setUnitPick(""); await load();
    } catch (e) { setErr(sayError(e)); } finally { setBusy(false); }
  };
  const addAsset = async () => {
    const t = tagInput.trim();
    if (!t) return;
    setBusy(true); setErr(null);
    try {
      // An ID finds one piece; a name can be on several units (V-7 on the
      // Crude and Transmix units), so then it asks for the ID.
      const hits = await findAssetsByTag(orgId, t);
      if (hits.length > 1) throw new Error(`${t} is on ${hits.length} units (${hits.map((h) => h.code ?? `unit ${h.unit_code ?? "?"}`).join(", ")}). Type its ID instead.`);
      const a = hits[0] ?? null;
      if (!a) throw new Error(`No equipment tagged "${t}" in the registry.`);
      await declareEdge({ orgId, a: node, b: nid.asset(a.id), type: "project_scope", summary: `Project "${projectName}" covers ${a.tag} - set by hand`, actor: me });
      setTagInput(""); await load();
    } catch (e) { setErr(sayError(e)); } finally { setBusy(false); }
  };
  const drop = async (e: EstateEdge) => {
    setBusy(true);
    try { if (e.origin === "human") await removeEdge(e.id); else await decideEdge(e.id, "dismissed", me); await load(); }
    catch (x) { setErr(sayError(x)); } finally { setBusy(false); }
  };
  const accept = async (e: EstateEdge) => {
    setBusy(true);
    try { await decideEdge(e.id, "applied", me); await load(); } catch (x) { setErr(sayError(x)); } finally { setBusy(false); }
  };

  const L = (id: string) => labels.get(id) ?? { label: id };
  const Icon = ({ id }: { id: string }) => (id.startsWith("cbunit:") ? <Factory className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> : id.startsWith("asset:") ? <Cpu className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> : <FileText className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />);

  return (
    <Card label="Scope: what this project is about"
      action={<Link href={`/graph?focus=${encodeURIComponent(node)}`} className="text-[14px] text-[var(--color-accent-text)] hover:underline inline-flex items-center gap-1 whitespace-nowrap"><Link2 className="w-3.5 h-3.5" /> See on the graph</Link>}>
      <div className="space-y-3">
        {err && <div role="alert" className="text-[13px] text-[var(--state-overdue-text)]">{err}</div>}
        {edges === null ? (
          <div className="text-[13px] text-[var(--color-text-muted)] inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading the scope…</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {scope.length === 0 && <span className="text-[14px] text-[var(--color-text-muted)]">No unit or equipment set yet. <HelpTooltip>Set them so this project shows up when someone asks what&apos;s going on in a unit.</HelpTooltip></span>}
              {scope.map((e) => {
                const l = L(e.b);
                return (
                  <span key={e.id} title={e.summary} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] ${e.status === "pending" ? "bg-[var(--state-held)]" : "bg-[var(--color-surface-2)]"}`}>
                    <Icon id={e.b} />
                    {l.href ? <Link href={l.href} className="font-bold hover:underline">{l.label}</Link> : <span className="font-bold">{l.label}</span>}
                    {e.status === "pending" && <span className="text-[11px] text-[var(--state-held-text)]">proposed · {Math.round(e.confidence * 100)}%</span>}
                    {canManage && e.status === "pending" && <button onClick={() => accept(e)} disabled={busy} className="text-[13px] text-[var(--color-accent-text)] hover:underline">accept</button>}
                    {canManage && <button onClick={() => drop(e)} disabled={busy} className="opacity-50 hover:opacity-100" title={e.origin === "human" ? "Remove" : "Dismiss"} aria-label={`${e.origin === "human" ? "Remove" : "Dismiss"} ${l.label}`}><X className="w-3 h-3" /></button>}
                  </span>
                );
              })}
            </div>
            {members.length > 0 && (
              <div className="text-[13px] text-[var(--color-text-muted)]">
                <span className="font-bold text-[var(--color-text)]">{members.length}</span> folder{members.length === 1 ? "" : "s"}/file{members.length === 1 ? "" : "s"} linked to this project by name:{" "}
                {members.slice(0, 6).map((e, i) => { const l = L(e.a); return <React.Fragment key={e.id}>{i > 0 && ", "}{l.href ? <Link href={l.href} className="hover:underline">{l.label}</Link> : l.label}</React.Fragment>; })}
                {members.length > 6 && ` and ${members.length - 6} more`}
              </div>
            )}
            {canManage && (
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--color-border)]">
                <select value={unitPick} onChange={(e) => setUnitPick(e.target.value)} aria-label="Unit" className="h-9 text-[14px] font-semibold rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2">
                  <option value="">Add a unit…</option>
                  {units.map((u) => <option key={u.code} value={u.code}>{u.label} ({u.code})</option>)}
                </select>
                <button onClick={addUnit} disabled={busy || !unitPick} className="inline-flex items-center gap-1 h-9 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"><Plus className="w-3.5 h-3.5" /> Unit</button>
                <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addAsset(); }} placeholder="Equipment tag, e.g. X-35" aria-label="Equipment tag" className="h-9 text-[13px] rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 w-44" />
                <button onClick={addAsset} disabled={busy || !tagInput.trim()} className="inline-flex items-center gap-1 h-9 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-[14px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50"><Plus className="w-3.5 h-3.5" /> Equipment</button>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
