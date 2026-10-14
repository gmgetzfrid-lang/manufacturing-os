"use client";

// ProjectScopePanel — what this project is ABOUT: the units, equipment and
// documents it covers, as estate edges with provenance. A person declares
// scope here; the resolver proposes it from AFE folders; the find service
// and the Intelligence graph read it. A project with no checkouts is no
// longer an island.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Briefcase, Factory, Cpu, FileText, Plus, X, Loader2, Link2 } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";
import { loadCodebook, normalizeTag } from "@/lib/codebook";
import { listEdgesFor, declareEdge, removeEdge, decideEdge } from "@/lib/estate/client";
import { labelNodes, type NodeLabel } from "@/lib/estate/labels";
import { nid, type EstateEdge } from "@/lib/estate/ids";

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
  useEffect(() => { void load().catch((e) => setErr((e as Error).message)); }, [load]);
  useEffect(() => { void loadCodebook(orgId).then((b) => setUnits(b.units.map((u) => ({ code: u.code, label: u.label })))); }, [orgId]);

  const scope = (edges ?? []).filter((e) => e.a === node && e.type === "project_scope");
  const members = (edges ?? []).filter((e) => e.b === node && e.type === "in_project");

  const addUnit = async () => {
    if (!unitPick) return;
    setBusy(true); setErr(null);
    try {
      const u = units.find((x) => x.code === unitPick);
      await declareEdge({ orgId, a: node, b: nid.cbunit(unitPick), type: "project_scope", summary: `Project "${projectName}" covers ${u?.label ?? unitPick} (${unitPick}) — set by hand`, actor: me });
      setUnitPick(""); await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const addAsset = async () => {
    const t = tagInput.trim();
    if (!t) return;
    setBusy(true); setErr(null);
    try {
      const { data } = await supabase.from("assets").select("id, tag").eq("org_id", orgId).eq("tag_normalized", normalizeTag(t).toLowerCase()).maybeSingle();
      let a = data as { id: string; tag: string } | null;
      if (!a) {
        const { data: d2 } = await supabase.from("assets").select("id, tag").eq("org_id", orgId).ilike("tag", t).maybeSingle();
        a = d2 as { id: string; tag: string } | null;
      }
      if (!a) throw new Error(`No equipment tagged "${t}" in the registry.`);
      await declareEdge({ orgId, a: node, b: nid.asset(a.id), type: "project_scope", summary: `Project "${projectName}" covers ${a.tag} — set by hand`, actor: me });
      setTagInput(""); await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const drop = async (e: EstateEdge) => {
    setBusy(true);
    try { if (e.origin === "human") await removeEdge(e.id); else await decideEdge(e.id, "dismissed", me); await load(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  const accept = async (e: EstateEdge) => {
    setBusy(true);
    try { await decideEdge(e.id, "applied", me); await load(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };

  const L = (id: string) => labels.get(id) ?? { label: id };
  const Icon = ({ id }: { id: string }) => (id.startsWith("cbunit:") ? <Factory className="w-3.5 h-3.5 text-purple-600" /> : id.startsWith("asset:") ? <Cpu className="w-3.5 h-3.5 text-emerald-600" /> : <FileText className="w-3.5 h-3.5 text-blue-600" />);

  return (
    <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
        <div className="text-sm font-black inline-flex items-center gap-2"><Briefcase className="w-4 h-4 text-amber-600" /> Scope — what this project is about</div>
        <Link href={`/graph?focus=${encodeURIComponent(node)}`} className="text-xs font-bold text-[var(--color-accent)] hover:underline inline-flex items-center gap-1"><Link2 className="w-3.5 h-3.5" /> See on the global graph</Link>
      </div>
      <div className="p-4 space-y-3">
        {err && <div className="text-xs text-red-700">{err}</div>}
        {edges === null ? (
          <div className="text-xs text-[var(--color-text-muted)] inline-flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {scope.length === 0 && <span className="text-xs text-[var(--color-text-muted)]">No unit or equipment scoped yet. Until it is, this project is invisible to &ldquo;what&apos;s going on in the crude unit&rdquo;.</span>}
              {scope.map((e) => {
                const l = L(e.b);
                return (
                  <span key={e.id} title={e.summary} className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${e.status === "pending" ? "border-amber-300 bg-amber-50" : "border-[var(--color-border)] bg-[var(--color-canvas)]"}`}>
                    <Icon id={e.b} />
                    {l.href ? <Link href={l.href} className="font-bold hover:underline">{l.label}</Link> : <span className="font-bold">{l.label}</span>}
                    {e.status === "pending" && <span className="text-[10px] text-amber-700">proposed · {Math.round(e.confidence * 100)}%</span>}
                    {canManage && e.status === "pending" && <button onClick={() => accept(e)} disabled={busy} className="text-[10px] font-bold text-emerald-700 hover:underline">accept</button>}
                    {canManage && <button onClick={() => drop(e)} disabled={busy} className="opacity-50 hover:opacity-100" title={e.origin === "human" ? "Remove" : "Dismiss"}><X className="w-3 h-3" /></button>}
                  </span>
                );
              })}
            </div>
            {members.length > 0 && (
              <div className="text-xs text-[var(--color-text-muted)]">
                <span className="font-bold text-[var(--color-text)]">{members.length}</span> folder{members.length === 1 ? "" : "s"}/file{members.length === 1 ? "" : "s"} linked to this project by name:{" "}
                {members.slice(0, 6).map((e, i) => { const l = L(e.a); return <React.Fragment key={e.id}>{i > 0 && ", "}{l.href ? <Link href={l.href} className="hover:underline">{l.label}</Link> : l.label}</React.Fragment>; })}
                {members.length > 6 && ` and ${members.length - 6} more`}
              </div>
            )}
            {canManage && (
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--color-border)]">
                <select value={unitPick} onChange={(e) => setUnitPick(e.target.value)} className="text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1.5">
                  <option value="">Add a unit…</option>
                  {units.map((u) => <option key={u.code} value={u.code}>{u.label} ({u.code})</option>)}
                </select>
                <button onClick={addUnit} disabled={busy || !unitPick} className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 py-1.5 text-xs font-bold disabled:opacity-50"><Plus className="w-3.5 h-3.5" /> Unit</button>
                <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addAsset(); }} placeholder="Equipment tag, e.g. X-35" className="text-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-2 py-1.5 w-44" />
                <button onClick={addAsset} disabled={busy || !tagInput.trim()} className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border)] px-2 py-1.5 text-xs font-bold disabled:opacity-50"><Plus className="w-3.5 h-3.5" /> Equipment</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
