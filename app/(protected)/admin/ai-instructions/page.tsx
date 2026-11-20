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
  GraduationCap, Plus, Loader2, Pencil, Trash2, Save,
  Power,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  listAiInstructions, saveAiInstruction, deleteAiInstruction,
  SCOPE_LABELS, type AiInstruction, type AiInstructionScope,
} from "@/lib/aiInstructions";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary } from "@/components/ui/PageHero";
import { tbl, sheet, field, fieldBox, label, btnRow, btnIcon, btnQuiet, btnPrimary, Pill, Problem } from "@/components/admin/kit";
import { plural } from "@/components/admin/band";
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
  // Show one scope only (its tag on a row, or the filter pills above).
  const [scopeFilter, setScopeFilter] = useState<AiInstructionScope | null>(null);
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

  if (!activeOrgId) return <PageShell width="work"><PageHero kicker="Admin · AI instructions" title="AI instructions" overlap={false} /><LoadingBlock what="AI instructions" /></PageShell>;
  const closeEditor = () => { if (!busy) { setEditing(null); setFromLink(false); } };
  const openNew = () => { setFromLink(false); setEditing({ scope: "global", title: "", body: "", enabled: true }); };

  const on = (rows ?? []).filter((r) => r.enabled).length;
  const off = (rows ?? []).length - on;
  const answer = rows === null ? (loadError ? "Couldn't load the instructions." : "AI instructions")
    : rows.length === 0 ? "Nothing taught yet."
    : `${plural(on, "rule")} the AI follows.`;

  const sorted = [...(rows ?? [])].filter((r) => !scopeFilter || r.scope === scopeFilter).sort((x, y) => SCOPES.indexOf(x.scope) - SCOPES.indexOf(y.scope));
  const scopeCount = (s: AiInstructionScope) => (rows ?? []).filter((r) => r.scope === s).length;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · AI instructions"
        title={answer}
        sub={canWrite ? "Your site's conventions, written once. The AI follows them on every call." : "Read only: Admins and Document Controllers write these."}
        facts={rows && rows.length > 0 ? [
          { label: "Followed", value: on },
          { label: "Turned off", value: off },
        ] : undefined}
        primary={canWrite ? (
          <button type="button" onClick={openNew} className={heroPrimary}>
            <Plus className="w-4 h-4" /> New instruction
          </button>
        ) : undefined}
      />

      <PageBody>
      {error && !editing && <Problem>{error}</Problem>}

      {rows === null && loadError ? (
        <Problem retry={() => void refresh()}>Couldn&apos;t load the instructions: {loadError}</Problem>
      ) : rows === null ? (
        <LoadingBlock what="AI instructions" />
      ) : rows.length === 0 ? (
        <div className={`${sheet} px-5 py-10 text-center`}>
          <span aria-hidden className="ui-icon-tile mx-auto mb-3 !grid !w-12 !h-12"><GraduationCap className="w-6 h-6" /></span>
          <div className="font-display text-[19px] font-semibold text-[var(--color-heading)]">Teach the first rule</div>
          <p className="text-[15px] text-[var(--color-text-muted)] mt-1 max-w-md mx-auto">
            For example: &ldquo;equipment descriptions use the P&amp;ID service name, not the vendor model.&rdquo;
          </p>
        </div>
      ) : (
        <>
        {/* Where each rule applies, as filters with their counts. */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show rules that apply to">
          <button type="button" onClick={() => setScopeFilter(null)} aria-pressed={!scopeFilter}
            className={`ui-tag !h-8 ${!scopeFilter ? "!bg-[var(--color-main)] !text-white !border-[var(--color-main)]" : "is-more"}`}>
            All <span className={`ui-count !h-5 !min-w-5 !px-1.5 !text-[12px] ${!scopeFilter ? "!bg-white/25 !text-white" : ""}`}>{rows.length}</span>
          </button>
          {SCOPES.filter((s) => scopeCount(s) > 0).map((s) => (
            <button key={s} type="button" onClick={() => setScopeFilter(scopeFilter === s ? null : s)} aria-pressed={scopeFilter === s}
              className={`ui-tag !h-8 ${scopeFilter === s ? "!bg-[var(--color-main)] !text-white !border-[var(--color-main)]" : "is-more"}`}>
              {SCOPE_LABELS[s]} <span className={`ui-count !h-5 !min-w-5 !px-1.5 !text-[12px] ${scopeFilter === s ? "!bg-white/25 !text-white" : ""}`}>{scopeCount(s)}</span>
            </button>
          ))}
        </div>
        <div className={tbl.wrap}>
          <table className={tbl.table}>
            <thead className={`${tbl.thead} max-sm:hidden`}>
              <tr>
                <th className={tbl.th}>Rule</th>
                <th className={`${tbl.th} max-md:hidden`}>Applies to</th>
                <th className={`${tbl.th} max-lg:hidden`}>Taught by</th>
                <th className={tbl.th}>Status</th>
                {canWrite && <th className={`${tbl.th} w-[1%]`}><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {sorted.map((r) => (
                <tr key={r.id} className={`${tbl.tr} max-sm:grid max-sm:grid-cols-[1fr_auto]`}>
                  <td className={`${tbl.td} max-sm:col-span-2 max-sm:pb-0`}>
                    <div className="flex items-start gap-3 min-w-0">
                      <span aria-hidden className={`ui-icon-tile is-sm mt-0.5 ${r.enabled ? "" : "!bg-[var(--color-surface-2)] !text-[var(--color-text-muted)]"}`}><GraduationCap className="w-4 h-4" /></span>
                      <div className="min-w-0">
                        <div className={`font-semibold ${r.enabled ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{r.title}</div>
                        <div className="text-[14px] text-[var(--color-text-muted)] line-clamp-2 max-w-[80ch]" title={r.body}>{r.body}</div>
                      </div>
                    </div>
                  </td>
                  <td className={`${tbl.td} max-md:hidden whitespace-nowrap`}>
                    <button type="button" onClick={() => setScopeFilter(scopeFilter === r.scope ? null : r.scope)} title={`Show only rules for ${SCOPE_LABELS[r.scope]}`} className="ui-tag">{SCOPE_LABELS[r.scope]}</button>
                  </td>
                  <td className={`${tbl.td} max-lg:hidden whitespace-nowrap text-[var(--color-text-muted)]`}>{r.created_by_name ?? ""}</td>
                  <td className={`${tbl.td} whitespace-nowrap`}>
                    {r.enabled ? <Pill tone="good">Followed</Pill> : <Pill>Off</Pill>}
                  </td>
                  {canWrite && (
                    <td className={`${tbl.td} text-right`}>
                      <div className="flex items-center justify-end gap-1">
                        <button type="button" onClick={() => void toggle(r)} title={r.enabled ? "Turn off (the AI stops following it)" : "Turn on"}
                          aria-pressed={r.enabled} className={btnRow}>
                          <Power className="w-3.5 h-3.5" /> {r.enabled ? "Turn off" : "Turn on"}
                        </button>
                        <button type="button" onClick={() => { setFromLink(false); setEditing(r); }} title="Edit" aria-label={`Edit ${r.title}`} className={btnIcon}>
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button type="button" onClick={() => void remove(r)} title="Delete" aria-label={`Delete ${r.title}`} className={`${btnIcon} hover:text-[var(--state-overdue)]`}>
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
      </PageBody>

      {editing && (
        <Modal onClose={closeEditor} size="md" dismissable={!busy}>
          <ModalHeader icon={GraduationCap} title={editing.id ? "Edit instruction" : "Teach the AI"}
            subtitle={draft.restored ? "Brought back what you were writing." : undefined}
            onClose={busy ? undefined : closeEditor} />
          <ModalBody className="space-y-3">
            <div>
              <label htmlFor="ai-scope" className={label}>Applies to</label>
              <select id="ai-scope" value={editing.scope ?? "global"}
                onChange={(e) => setEditing({ ...editing, scope: e.target.value as AiInstructionScope })}
                className={field}>
                {SCOPES.map((s) => <option key={s} value={s}>{SCOPE_LABELS[s]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="ai-title" className={label}>Short title</label>
              <input id="ai-title" value={editing.title ?? ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                placeholder='e.g. "Transmittal numbering"' maxLength={80} autoFocus
                className={field} />
            </div>
            <div>
              <label htmlFor="ai-body" className={label}>The rule, in plain language</label>
              <textarea id="ai-body" value={editing.body ?? ""} onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                rows={5} maxLength={1500}
                placeholder={'e.g. "Our equipment descriptions always use the P&ID service name, never the vendor model name."'}
                className={`${fieldBox} w-full text-[15px] py-2 resize-y`} />
            </div>
            {error && (
              <Problem>{error}</Problem>
            )}
          </ModalBody>
          <ModalFooter>
            <button type="button" onClick={closeEditor} disabled={busy} className={btnQuiet}>Cancel</button>
            <button type="button" onClick={() => void save()} disabled={busy} className={btnPrimary}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {editing.id ? "Save" : "Teach it"}
            </button>
          </ModalFooter>
        </Modal>
      )}
    </PageShell>
  );
}
