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
  GraduationCap, Plus, Loader2, AlertTriangle, Pencil, Trash2, Save,
  Power, Sparkles,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  listAiInstructions, saveAiInstruction, deleteAiInstruction,
  SCOPE_LABELS, type AiInstruction, type AiInstructionScope,
} from "@/lib/aiInstructions";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { appConfirm } from "@/components/providers/DialogProvider";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { useDraft } from "@/hooks/useDraft";

const SCOPES: AiInstructionScope[] = ["global", "knowledge", "codebook", "equipment"];

export default function AiInstructionsPage() {
  return (
    <Suspense fallback={<PageShell width="work"><LoadingBlock what="AI instructions" /></PageShell>}>
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
  const [loadError, setLoadError] = useState<string | null>(null);
  // A rule sent here by a link arrives prefilled; only a fresh one is a draft.
  const [fromLink, setFromLink] = useState(false);
  const draftKey = editing && !editing.id && !fromLink && activeOrgId ? `ai-instruction:${activeOrgId}` : null;
  const draft = useDraft<string>(draftKey, String(editing?.body ?? ""),
    (v) => setEditing((e) => (e ? { ...e, body: v } : e)), (v) => !v.trim());

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try { setRows(await listAiInstructions(activeOrgId)); setLoadError(null); }
    catch (e) { setLoadError((e as Error).message || "Couldn't load the instructions."); }
  }, [activeOrgId]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Quick-add deep link: an AI surface sends the user here with the rule
  // pre-filled — one review, one save, taught forever.
  useEffect(() => {
    const add = searchParams.get("add");
    if (!add) return;
    const scope = (searchParams.get("scope") ?? "global") as AiInstructionScope;
    const t = setTimeout(() => {
      setFromLink(true);
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
      draft.clear();
      setEditing(null);
      setFromLink(false);
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

  if (!activeOrgId) return <PageShell width="work"><LoadingBlock what="AI instructions" /></PageShell>;
  const closeEditor = () => { if (!busy) { setEditing(null); setFromLink(false); } };
  const openNew = () => { setFromLink(false); setEditing({ scope: "global", title: "", body: "", enabled: true }); };

  return (
    <PageShell width="work">
      <PageHeaderBar
        icon={GraduationCap}
        title="AI Instructions"
        subtitle={rows
          ? `${rows.filter((r) => r.enabled).length} rule${rows.filter((r) => r.enabled).length === 1 ? "" : "s"} the AI follows on every call${rows.some((r) => !r.enabled) ? ` · ${rows.filter((r) => !r.enabled).length} turned off` : ""}.`
          : "Your site's conventions, written once. The AI follows them on every call."}
        actions={canWrite ? (
          <button onClick={openNew}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-accent-fg)] text-sm font-black">
            <Plus className="w-4 h-4" /> New instruction
          </button>
        ) : undefined}
      />

      {!canWrite && (
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Read only. Admins and Document Controllers write these.
        </p>
      )}

      {error && !editing && (
        <p role="alert" className="mb-3 border-l-2 border-red-500 pl-3 text-xs text-red-700 dark:text-red-400 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
        </p>
      )}

      {rows === null && loadError ? (
        <p role="alert" className="border-l-2 border-red-500 pl-3 py-1 text-sm text-red-700 dark:text-red-400">
          Couldn&apos;t load the instructions: {loadError}{" "}
          <button type="button" onClick={() => void refresh()} className="font-bold underline">Try again</button>
        </p>
      ) : rows === null ? (
        <LoadingBlock what="AI instructions" />
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-[var(--color-border)] bg-[var(--color-surface-2)] p-8 text-center">
          <Sparkles className="w-8 h-8 text-[var(--color-text-muted)] mx-auto mb-2" />
          <div className="text-sm font-black text-[var(--color-text)]">Nothing taught yet</div>
          <p className="text-xs text-[var(--color-text-muted)] mt-1 max-w-md mx-auto">
            For example: &ldquo;equipment descriptions use the P&amp;ID service name, not the vendor
            model.&rdquo;
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {SCOPES.map((scope) => {
            const inScope = rows.filter((r) => r.scope === scope);
            if (inScope.length === 0) return null;
            return (
              <div key={scope}>
                <div className="text-[11px] font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-1.5">
                  {SCOPE_LABELS[scope]}
                </div>
                <div className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-surface)]">
                  {inScope.map((r) => (
                    <div key={r.id} className={`px-3.5 py-2.5 flex items-start gap-3 ${r.enabled ? "" : "opacity-50"}`}>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-black text-[var(--color-text)]">{r.title}</div>
                        <div className="text-xs text-[var(--color-text-muted)] whitespace-pre-wrap">{r.body}</div>
                        {r.created_by_name && (
                          <div className="text-[11px] text-[var(--color-text-faint)] mt-0.5">taught by {r.created_by_name}</div>
                        )}
                      </div>
                      {canWrite && (
                        <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => void toggle(r)} title={r.enabled ? "Turn off (AI stops following it)" : "Turn on"}
                            aria-label={r.enabled ? `Turn off ${r.title}` : `Turn on ${r.title}`} aria-pressed={r.enabled}
                            className={`p-1.5 rounded-lg ${r.enabled ? "text-emerald-600 hover:bg-[var(--color-surface-2)]" : "text-[var(--color-text-faint)] hover:bg-[var(--color-surface-2)]"}`}>
                            <Power className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => { setFromLink(false); setEditing(r); }} title="Edit" aria-label={`Edit ${r.title}`}
                            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-accent-hover)] hover:bg-[var(--color-surface-2)]">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => void remove(r)} title="Delete" aria-label={`Delete ${r.title}`}
                            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-rose-600 hover:bg-[var(--color-surface-2)]">
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
        <Modal onClose={closeEditor} size="md" dismissable={!busy}>
          <ModalHeader icon={GraduationCap} title={editing.id ? "Edit instruction" : "Teach the AI"}
            subtitle={draft.restored ? "Brought back what you were writing." : undefined}
            onClose={busy ? undefined : closeEditor} />
          <ModalBody className="space-y-3">
            <div>
              <label className="text-[11px] font-black text-[var(--color-text)] uppercase tracking-widest">Applies to</label>
              <select value={editing.scope ?? "global"}
                onChange={(e) => setEditing({ ...editing, scope: e.target.value as AiInstructionScope })}
                className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]">
                {SCOPES.map((s) => <option key={s} value={s}>{SCOPE_LABELS[s]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-black text-[var(--color-text)] uppercase tracking-widest">Short title</label>
              <input value={editing.title ?? ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                placeholder='e.g. "Transmittal numbering"' maxLength={80} autoFocus
                className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)] text-[var(--color-text)]" />
            </div>
            <div>
              <label className="text-[11px] font-black text-[var(--color-text)] uppercase tracking-widest">The rule, in plain language</label>
              <textarea value={editing.body ?? ""} onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                rows={5} maxLength={1500}
                placeholder={'e.g. "Our equipment descriptions always use the P&ID service name, never the vendor model name."'}
                className="mt-1 w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y bg-[var(--color-surface)] text-[var(--color-text)]" />
            </div>
            {error && (
              <p role="alert" className="border-l-2 border-red-500 pl-3 text-xs text-red-700 dark:text-red-400 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
              </p>
            )}
          </ModalBody>
          <ModalFooter>
            <button onClick={closeEditor} disabled={busy}
              className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)]">Cancel</button>
            <button onClick={() => void save()} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-black text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {editing.id ? "Save" : "Teach it"}
            </button>
          </ModalFooter>
        </Modal>
      )}
    </PageShell>
  );
}
