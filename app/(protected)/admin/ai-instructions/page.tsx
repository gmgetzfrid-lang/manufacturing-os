"use client";

// /admin/ai-instructions: the workspace's standing instructions for its AI.
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
import { Plus, Pencil, Trash2, Power } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import {
  listAiInstructions, saveAiInstruction, deleteAiInstruction,
  SCOPE_LABELS, type AiInstruction, type AiInstructionScope,
} from "@/lib/aiInstructions";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary } from "@/components/ui/PageHero";
import { tbl, sheet, field, fieldBox, label, link, btnIcon, Problem, StatusTag, shortDate } from "@/components/admin/kit";
import { plural, bandSeg, bandSegItem } from "@/components/admin/band";
import { said } from "@/components/admin/said";
import { Button } from "@/components/ui/Button";
import MoreMenu from "@/components/ui/MoreMenu";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { appConfirm } from "@/components/providers/DialogProvider";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { useDraft } from "@/hooks/useDraft";

const SCOPES: AiInstructionScope[] = ["global", "knowledge", "codebook", "equipment"];

export default function AiInstructionsPage() {
  return (
    <Suspense fallback={<PageShell width="work"><SkeletonRows rows={3} cols={2} what="AI instructions" /></PageShell>}>
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
  const [loadError, setLoadError] = useState<unknown>(null);
  // A rule sent here by a link arrives prefilled; only a fresh one is a draft.
  const [fromLink, setFromLink] = useState(false);
  const draftKey = editing && !editing.id && !fromLink && activeOrgId ? `ai-instruction:${activeOrgId}` : null;
  const draft = useDraft<string>(draftKey, String(editing?.body ?? ""),
    (v) => setEditing((e) => (e ? { ...e, body: v } : e)), (v) => !v.trim());

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try { setRows(await listAiInstructions(activeOrgId)); setLoadError(null); }
    catch (e) { setLoadError(e); }
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
      setError("Give it a short title and write the rule itself.");
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
    } catch (e) { setError(said(e, "Couldn't save the instruction.")); }
    finally { setBusy(false); }
  };

  const toggle = async (r: AiInstruction) => {
    if (!activeOrgId || !uid) return;
    try {
      await saveAiInstruction(activeOrgId, { ...r, enabled: !r.enabled }, uid, userEmail ?? undefined);
      await refresh();
    } catch (e) { setError(said(e, r.enabled ? "Couldn't turn it off." : "Couldn't turn it on.")); }
  };

  const remove = async (r: AiInstruction) => {
    if (!(await appConfirm({ title: `Delete "${r.title}"?`, message: "The AI stops following it right away. To pause it instead, turn it off.", tone: "danger", confirmLabel: "Delete instruction" }))) return;
    try { await deleteAiInstruction(r.id); await refresh(); }
    catch (e) { setError(said(e, "Couldn't delete the instruction.")); }
  };

  if (!activeOrgId) return <PageShell width="work"><PageHero kicker="Admin · AI instructions" title="AI instructions" /><PageBody><SkeletonRows rows={3} cols={2} what="AI instructions" /></PageBody></PageShell>;
  const closeEditor = () => { if (!busy) { setEditing(null); setFromLink(false); } };
  const openNew = () => { setFromLink(false); setEditing({ scope: "global", title: "", body: "", enabled: true }); };

  const on = (rows ?? []).filter((r) => r.enabled).length;
  const off = (rows ?? []).length - on;
  const answer = rows === null ? (loadError != null ? "Couldn't load the instructions." : "AI instructions")
    : rows.length === 0 ? "Nothing taught yet."
    : `${plural(on, "rule")} the AI follows.`;

  const sorted = [...(rows ?? [])].filter((r) => !scopeFilter || r.scope === scopeFilter).sort((x, y) => SCOPES.indexOf(x.scope) - SCOPES.indexOf(y.scope));
  const scopeCount = (s: AiInstructionScope) => (rows ?? []).filter((r) => r.scope === s).length;

  return (
    <PageShell width="work">
      <PageHero
        kicker="Admin · AI instructions"
        title={answer}
        sub={canWrite ? "Your site's conventions, written once. The AI follows them on every call." : "Read only. Admin and Doc Control write these."}
        factsHero="none"
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

      {rows === null && loadError != null ? (
        <ErrorNote error={loadError} title="Couldn't load the instructions." onRetry={() => void refresh()} />
      ) : rows === null ? (
        <SkeletonRows rows={3} cols={2} what="AI instructions" />
      ) : rows.length === 0 ? (
        <div className={`${sheet} px-5 py-8 text-center`}>
          <p className="text-reading text-[var(--color-text)]">For example: &ldquo;Equipment descriptions use the P&amp;ID service name, not the vendor model.&rdquo;</p>
          {canWrite && <button type="button" onClick={openNew} className={`${link} mt-1.5 font-medium`}>Teach the first rule</button>}
        </div>
      ) : (
        <>
        {/* Where each rule applies, as filters with their counts. */}
        <div className={bandSeg} role="group" aria-label="Show rules that apply to">
          <button type="button" onClick={() => setScopeFilter(null)} aria-pressed={!scopeFilter} className={bandSegItem(!scopeFilter)}>
            All <span className="ui-count">{rows.length}</span>
          </button>
          {SCOPES.filter((s) => scopeCount(s) > 0).map((s) => (
            <button key={s} type="button" onClick={() => setScopeFilter(scopeFilter === s ? null : s)} aria-pressed={scopeFilter === s} className={bandSegItem(scopeFilter === s)}>
              {SCOPE_LABELS[s]} <span className="ui-count">{scopeCount(s)}</span>
            </button>
          ))}
        </div>
        <div className={tbl.wrap}>
          <table className={tbl.table}>
            <thead className={`${tbl.thead} max-sm:hidden`}>
              <tr>
                <th className={tbl.th}>Rule</th>
                <th className={`${tbl.th} max-md:hidden`}>Applies to</th>
                <th className={`${tbl.th} max-lg:hidden`}>Last changed</th>
                <th className={tbl.th}>Status</th>
                {canWrite && <th className={`${tbl.th} w-[1%]`}><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {sorted.map((r) => (
                <tr key={r.id} className={`${tbl.tr} max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto]`}>
                  <td className={`${tbl.td} max-sm:col-span-2 max-sm:pb-0`}>
                    <div className="min-w-0">
                      <div className={`font-medium ${r.enabled ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{r.title}</div>
                      <div className="text-body text-[var(--color-text-muted)] line-clamp-2 max-w-[80ch]" title={r.body}>{r.body}</div>
                      <div className="md:hidden mt-0.5 text-body text-[var(--color-text-muted)]">{SCOPE_LABELS[r.scope]}</div>
                    </div>
                  </td>
                  <td className={`${tbl.td} max-md:hidden whitespace-nowrap`}>
                    <button type="button" onClick={() => setScopeFilter(scopeFilter === r.scope ? null : r.scope)} title={`Show only rules for ${SCOPE_LABELS[r.scope]}`} className="text-[var(--color-text)] hover:underline underline-offset-2">{SCOPE_LABELS[r.scope]}</button>
                  </td>
                  <td className={`${tbl.td} max-lg:hidden whitespace-nowrap text-[var(--color-text-muted)]`}>
                    {shortDate(r.updated_at || r.created_at)}
                    {r.created_by_name && <div className="text-body">Taught by {r.created_by_name}</div>}
                  </td>
                  <td className={`${tbl.td} whitespace-nowrap max-sm:col-start-1 max-sm:row-start-2 max-sm:pt-1`}>
                    {r.enabled ? <StatusTag tone="good" colored={false}>Followed</StatusTag> : <StatusTag tone="none">Off</StatusTag>}
                  </td>
                  {canWrite && (
                    <td className={`${tbl.td} text-right max-sm:col-start-2 max-sm:row-start-2 max-sm:pt-0`}>
                      <MoreMenu iconOnly label={`More for ${r.title}`} triggerClass={btnIcon} items={[
                        { icon: <Pencil className="w-4 h-4" />, label: "Edit", onClick: () => { setFromLink(false); setEditing(r); } },
                        { icon: <Power className="w-4 h-4" />, label: r.enabled ? "Turn off (the AI stops following it)" : "Turn on", onClick: () => toggle(r) },
                        { icon: <Trash2 className="w-4 h-4" />, label: "Delete", tone: "bad", line: true, onClick: () => remove(r) },
                      ]} />
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
          <ModalHeader title={editing.id ? "Edit the instruction" : "Teach the AI a rule"}
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
                placeholder="Transmittal numbering" maxLength={80} autoFocus
                className={field} />
            </div>
            <div>
              <label htmlFor="ai-body" className={label}>The rule, in plain language</label>
              <textarea id="ai-body" value={editing.body ?? ""} onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                rows={5} maxLength={1500}
                placeholder="Equipment descriptions always use the P&ID service name, never the vendor model name."
                className={`${fieldBox} w-full text-reading py-2 resize-y`} />
            </div>
            {error && (
              <Problem>{error}</Problem>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="secondary" onClick={closeEditor} disabled={busy}>Cancel</Button>
            <Button onClick={() => void save()} loading={busy}>{busy ? "Saving" : editing.id ? "Save" : "Teach it"}</Button>
          </ModalFooter>
        </Modal>
      )}
    </PageShell>
  );
}
