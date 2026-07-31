"use client";

// /output-templates — document production. Register a blank template once
// (it owns the formatting), attach an example (it owns the voice), then feed
// data and get finished, correctly formatted documents back in one pass
// instead of authoring them one at a time.

import React, { useCallback, useEffect, useState } from "react";
import {
  FileOutput, Plus, Sparkles, Pencil, Trash2, FileText, Table2, History,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { appConfirm } from "@/components/providers/DialogProvider";
import TemplateEditor from "@/components/templates/TemplateEditor";
import GenerateModal from "@/components/templates/GenerateModal";
import {
  listOutputTemplates, deleteOutputTemplate,
  type OutputTemplate, type OutputGeneration,
} from "@/lib/outputTemplates";

const MODE_LABEL: Record<string, string> = {
  per_row: "One per row",
  summary: "One summary",
  both: "Row or summary",
};

export default function OutputTemplatesPage() {
  const { activeOrgId, activeRole } = useRole();
  const { showToast } = useToast();
  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  const [templates, setTemplates] = useState<OutputTemplate[]>([]);
  const [generations, setGenerations] = useState<OutputGeneration[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<OutputTemplate | null | undefined>(undefined);
  const [generating, setGenerating] = useState<OutputTemplate | null>(null);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const out = await listOutputTemplates(activeOrgId);
      setTemplates(out.templates);
      setGenerations(out.generations);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally { setLoading(false); }
  }, [activeOrgId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const remove = async (t: OutputTemplate) => {
    const ok = await appConfirm({
      title: "Delete this template?",
      message: `"${t.name}" and its saved fill points will be removed. Documents already generated are unaffected.`,
      confirmLabel: "Delete",
    });
    if (!ok || !activeOrgId) return;
    try {
      await deleteOutputTemplate(activeOrgId, t.id);
      await refresh();
    } catch (e) { showToast({ type: "error", title: (e as Error).message }); }
  };

  if (loading) return <PageShell><div className="py-16 text-center"><Spinner /></div></PageShell>;

  return (
    <PageShell>
      <PageHeaderBar
        icon={FileOutput}
        title="Output templates"
        subtitle="Your template owns the formatting, your example owns the voice, your data fills the blanks — batch documents in one pass."
        actions={isController ? (
          <Button onClick={() => setEditing(null)}><Plus className="w-4 h-4" /> New template</Button>
        ) : undefined}
      />

      {loadError && (
        <div className="mb-4 rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 px-3.5 py-3 text-xs font-bold text-rose-700 dark:text-rose-300">
          {loadError}
        </div>
      )}

      {templates.length === 0 && !loadError ? (
        <EmptyState
          icon={FileOutput}
          title="No output templates yet"
          description={isController
            ? "Upload a blank Word document with {placeholders} where content belongs, attach a finished example so the AI matches your voice, and every future batch is one click."
            : "Admin or Doc Control can set up templates here."}
        />
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {templates.map((t) => (
            <li key={t.id} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="flex items-start gap-2">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center shrink-0">
                  {t.kind === "xlsx" ? <Table2 className="w-4 h-4 text-white" /> : <FileText className="w-4 h-4 text-white" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-black text-[var(--color-text)] truncate">{t.name}</div>
                  {t.description && (
                    <div className="text-[11px] text-[var(--color-text-muted)] line-clamp-2">{t.description}</div>
                  )}
                </div>
                {isController && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => setEditing(t)} title="Edit"
                      className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => void remove(t)} title="Delete"
                      className="p-1.5 rounded-lg hover:bg-rose-500/10 text-[var(--color-text-muted)] hover:text-rose-600">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5 text-[10px] font-black">
                <span className="px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                  {MODE_LABEL[t.mode] ?? t.mode}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                  {t.placeholders.length} fill point{t.placeholders.length === 1 ? "" : "s"}
                </span>
                {t.placeholders.some((p) => p.kind === "ai") && (
                  <span className="px-1.5 py-0.5 rounded bg-orange-500/10 border border-orange-300 dark:border-orange-800 text-orange-700 dark:text-orange-400 inline-flex items-center gap-1">
                    <Sparkles className="w-2.5 h-2.5" /> AI-written sections
                  </span>
                )}
                {t.exampleFiles.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400">
                    {t.exampleFiles.length} example{t.exampleFiles.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <div className="mt-3">
                <Button size="sm" onClick={() => setGenerating(t)} disabled={!t.templateFileKey}>
                  <Sparkles className="w-3.5 h-3.5" /> Generate documents
                </Button>
                {!t.templateFileKey && (
                  <span className="ml-2 text-[10px] text-amber-600 font-bold">needs a template file</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {generations.length > 0 && (
        <div className="mt-6">
          <h2 className="text-xs font-black uppercase tracking-widest text-[var(--color-text-muted)] mb-2 flex items-center gap-1.5">
            <History className="w-3.5 h-3.5" /> Recent production
          </h2>
          <ul className="rounded-xl border border-[var(--color-border)] divide-y divide-[var(--color-border)] overflow-hidden">
            {generations.map((g) => (
              <li key={g.id} className="px-3.5 py-2 bg-[var(--color-surface)] flex items-center gap-2 text-xs">
                <FileOutput className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                <span className="font-bold text-[var(--color-text)]">{g.templateName ?? "Template"}</span>
                <span className="text-[var(--color-text-muted)] truncate">
                  {g.documentCount} document{g.documentCount === 1 ? "" : "s"}
                  {g.sourceName ? ` from ${g.sourceName}` : ""}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">
                  {new Date(g.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editing !== undefined && activeOrgId && (
        <TemplateEditor orgId={activeOrgId} template={editing}
          onClose={() => setEditing(undefined)} onSaved={() => void refresh()} />
      )}
      {generating && activeOrgId && (
        <GenerateModal orgId={activeOrgId} template={generating}
          onClose={() => setGenerating(null)} onGenerated={() => void refresh()} />
      )}
    </PageShell>
  );
}
