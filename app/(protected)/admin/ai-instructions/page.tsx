"use client";

// /admin/ai-instructions — Org Playbooks.
//
// The org's standing instructions for its AI: teach the system a site
// convention ONCE ("our transmittals cite the PO number", "vendor X drawings
// put the tag in the lower-right block") and every governed AI call in scope
// obeys it from then on. This is the learning loop rebuilt as org data:
// auditable, editable, deletable — no model training, no magic.
//
// Scopes: Everywhere · Knowledge asks · Codebook imports · Drawing reading.
// Quick-add supports ?add=<text>&scope=<scope> so AI surfaces can offer
// "save this as a standing rule" with one click.

import React, { useCallback, useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  GraduationCap, Plus, Loader2, AlertTriangle, Pencil, Trash2, X, Save,
  Power, Sparkles,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  listAiInstructions, saveAiInstruction, deleteAiInstruction,
  SCOPE_LABELS, type AiInstruction, type AiInstructionScope,
} from "@/lib/aiInstructions";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { appConfirm } from "@/components/providers/DialogProvider";

const SCOPES: AiInstructionScope[] = ["global", "knowledge", "codebook", "equipment"];

export default function AiInstructionsPage() {
  return (
    <Suspense fallback={null}>
      <AiInstructionsInner />
    </Suspense>
  );
}

function AiInstructionsInner() {
  const { activeOrgId, activeRole, uid, userEmail } = useRole();
  const canWrite = activeRole === "Admin" || activeRole === "DocCtrl";
  const searchParams = useSearchParams();

  const [rows, setRows] = useState<AiInstruction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Partial<AiInstruction> | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try { setRows(await listAiInstructions(activeOrgId)); }
    catch (e) { setError((e as Error).message); }
  }, [activeOrgId]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Quick-add deep link: an AI surface sends the user here with the rule
  // pre-filled — one review, one save, taught forever.
  useEffect(() => {
    const add = searchParams.get("add");
    if (!add) return;
    const scope = (searchParams.get("scope") ?? "global") as AiInstructionScope;
    const t = setTimeout(() => {
      setEditing({ scope: SCOPES.includes(scope) ? scope : "global", title: "", body: add, enabled: true });
    }, 0);
    return () => clearTimeout(t);
  }, [searchParams]);

  const save = async () => {
    if (!activeOrgId || !uid || !editing) return;
    if (!String(editing.title ?? "").trim() || !String(editing.body ?? "").trim()) {
      setError("Give the instruction a short title and the rule itself.");
      return;
    }
    setBusy(true); setError(null);
    try {
      await saveAiInstruction(activeOrgId, {
        id: editing.id,
        scope: (editing.scope ?? "global") as AiInstructionScope,
        title: String(editing.title),
        body: String(editing.body),
        enabled: editing.enabled ?? true,
      }, uid, userEmail ?? undefined);
      setEditing(null);
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const toggle = async (r: AiInstruction) => {
    if (!activeOrgId || !uid) return;
    try {
      await saveAiInstruction(activeOrgId, { ...r, enabled: !r.enabled }, uid, userEmail ?? undefined);
      await refresh();
    } catch (e) { setError((e as Error).message); }
  };

  const remove = async (r: AiInstruction) => {
    if (!(await appConfirm({ message: `Delete the instruction "${r.title}"? The AI stops following it immediately.`, tone: "danger" }))) return;
    try { await deleteAiInstruction(r.id); await refresh(); }
    catch (e) { setError((e as Error).message); }
  };

  if (!activeOrgId) return null;

  return (
    <PageShell width="work">
      <PageHeaderBar
        icon={GraduationCap}
        title="AI Instructions"
        subtitle="Teach the AI your site's conventions once — every extraction, import, and answer follows them from then on. Plain language; the AI reads these before every call."
        actions={canWrite ? (
          <button onClick={() => setEditing({ scope: "global", title: "", body: "", enabled: true })}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-black shadow">
            <Plus className="w-4 h-4" /> New instruction
          </button>
        ) : undefined}
      />

      {!canWrite && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          Read-only — only Admins and Document Controllers teach the AI.
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {rows === null ? (
        <div className="py-12 text-center text-sm text-[var(--color-text-muted)]">
          <Loader2 className="w-5 h-5 animate-spin inline" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-violet-200 bg-violet-50/40 p-8 text-center">
          <Sparkles className="w-8 h-8 text-violet-500 mx-auto mb-2" />
          <div className="text-sm font-black text-[var(--color-text)]">Nothing taught yet</div>
          <p className="text-xs text-[var(--color-text-muted)] mt-1 max-w-md mx-auto">
            Every site has conventions a generic AI can&apos;t guess. Write them here in plain
            language — &ldquo;equipment descriptions use the P&amp;ID service name, not the vendor
            model&rdquo; — and every AI feature obeys, starting with the very next call.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {SCOPES.map((scope) => {
            const inScope = rows.filter((r) => r.scope === scope);
            if (inScope.length === 0) return null;
            return (
              <div key={scope}>
                <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">
                  {SCOPE_LABELS[scope]}
                </div>
                <div className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-surface)]">
                  {inScope.map((r) => (
                    <div key={r.id} className={`px-3.5 py-2.5 flex items-start gap-3 ${r.enabled ? "" : "opacity-50"}`}>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-black text-[var(--color-text)]">{r.title}</div>
                        <div className="text-xs text-[var(--color-text-muted)] whitespace-pre-wrap">{r.body}</div>
                        {r.created_by_name && (
                          <div className="text-[10px] text-[var(--color-text-faint)] mt-0.5">taught by {r.created_by_name}</div>
                        )}
                      </div>
                      {canWrite && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => void toggle(r)} title={r.enabled ? "Disable (AI stops following it)" : "Enable"}
                            className={`p-1.5 rounded-lg ${r.enabled ? "text-emerald-600 hover:bg-emerald-50" : "text-[var(--color-text-faint)] hover:bg-[var(--color-surface-2)]"}`}>
                            <Power className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => setEditing(r)} title="Edit"
                            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-violet-700 hover:bg-violet-50">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => void remove(r)} title="Delete"
                            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-rose-600 hover:bg-rose-50">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-[400] bg-slate-900/60 backdrop-blur-sm flex items-start sm:items-center justify-center overflow-y-auto p-4" onClick={() => setEditing(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl max-h-[90vh] flex flex-col">
            <div className="px-5 py-3.5 border-b border-[var(--color-border)] flex items-center gap-2.5">
              <GraduationCap className="w-4 h-4 text-violet-600" />
              <div className="text-sm font-black text-[var(--color-text)] flex-1">
                {editing.id ? "Edit instruction" : "Teach the AI"}
              </div>
              <button onClick={() => setEditing(null)} className="p-1.5 rounded hover:bg-[var(--color-surface-2)]">
                <X className="w-4 h-4 text-[var(--color-text-muted)]" />
              </button>
            </div>
            <div className="p-5 space-y-3 overflow-y-auto">
              <div>
                <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Applies to</label>
                <select value={editing.scope ?? "global"}
                  onChange={(e) => setEditing({ ...editing, scope: e.target.value as AiInstructionScope })}
                  className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]">
                  {SCOPES.map((s) => <option key={s} value={s}>{SCOPE_LABELS[s]}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">Short title</label>
                <input value={editing.title ?? ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  placeholder='e.g. "Transmittal numbering"' maxLength={80}
                  className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm" />
              </div>
              <div>
                <label className="text-[10px] font-black text-[var(--color-text)] uppercase tracking-widest">The rule, in plain language</label>
                <textarea value={editing.body ?? ""} onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                  rows={5} maxLength={1500}
                  placeholder={'e.g. "Our equipment descriptions always use the P&ID service name, never the vendor model name."'}
                  className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y" />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-2)] rounded-b-2xl flex items-center justify-end gap-2">
              <button onClick={() => setEditing(null)} disabled={busy}
                className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)]">Cancel</button>
              <button onClick={() => void save()} disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-white bg-violet-600 hover:bg-violet-500 disabled:opacity-50 shadow">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {editing.id ? "Save" : "Teach it"}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}
