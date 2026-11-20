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
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary } from "@/components/ui/PageHero";
import { Button } from "@/components/ui/Button";
import LoadingBlock from "@/components/ui/LoadingBlock";
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

  const madeDocs = generations.reduce((n, g) => n + (g.documentCount ?? 0), 0);
  const answer = loading ? "Output templates"
    : loadError ? "The templates didn't load."
      : templates.length === 0 ? "No output templates yet."
        : `${templates.length} ${templates.length === 1 ? "template" : "templates"}${generations.length > 0 ? `, ${madeDocs.toLocaleString()} ${madeDocs === 1 ? "document" : "documents"} made lately` : ""}.`;

  return (
    <PageShell>
      <PageHero
        kicker="Output docs"
        title={answer}
        sub={
          <>
            Your template sets the format, your example sets the voice, your data fills the blanks.
          </>
        }
        primary={isController ? <button type="button" className={heroPrimary} onClick={() => setEditing(null)}><Plus className="w-4 h-4" /> New template</button> : undefined}
      />

      <PageBody>
      {loading ? (
        <Card><LoadingBlock what="output templates" rows={5} className="border-0 p-0" /></Card>
      ) : templates.length === 0 && loadError ? (
        <Card>
          <p role="alert" className="text-[14px] font-semibold text-rose-700 dark:text-rose-300">Couldn&apos;t load the templates: {loadError}</p>
          <button type="button" onClick={() => void refresh()} className="mt-3 h-9 px-3 rounded-lg border border-[var(--color-border-strong)] text-[13px] font-bold text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">Try again</button>
        </Card>
      ) : templates.length === 0 ? (
        <Card>
        <EmptyState
          icon={FileOutput}
          title="No output templates yet"
          description={isController
            ? "Upload a blank Word document with {placeholders} where content belongs, attach a finished example so the AI matches your voice, and every future batch is one click."
            : "Admin or Doc Control can set up templates here."}
        />
        </Card>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {templates.map((t) => (
            <li key={t.id} className="rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 bg-[var(--color-surface-2)]">
                  {t.kind === "xlsx" ? <Table2 className="w-4 h-4 text-[var(--color-text-muted)]" /> : <FileText className="w-4 h-4 text-[var(--color-text-muted)]" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-bold text-[var(--color-text)] truncate">{t.name}</div>
                  {t.description && (
                    <div className="text-[13px] text-[var(--color-text-muted)] line-clamp-2">{t.description}</div>
                  )}
                </div>
                {isController && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => setEditing(t)} title="Edit" aria-label={`Edit ${t.name}`}
                      className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-muted)]">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => void remove(t)} title="Delete" aria-label={`Delete ${t.name}`}
                      className="p-1.5 rounded-lg hover:bg-rose-500/10 text-[var(--color-text-muted)] hover:text-rose-600">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
              <div className="mt-3 text-[12.5px] text-[var(--color-text-muted)] flex flex-wrap gap-x-1">
                <span className="font-semibold text-[var(--color-text)]">{MODE_LABEL[t.mode] ?? t.mode}</span>
                <span>· {t.placeholders.length} fill point{t.placeholders.length === 1 ? "" : "s"}</span>
                {t.placeholders.some((p) => p.kind === "ai") && (
                  <span className="inline-flex items-center gap-1">· <Sparkles className="w-3 h-3" /> AI-written sections</span>
                )}
                {t.exampleFiles.length > 0 && (
                  <span>· {t.exampleFiles.length} example{t.exampleFiles.length === 1 ? "" : "s"}</span>
                )}
              </div>
              <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
                <Button size="sm" variant="secondary" onClick={() => setGenerating(t)} disabled={!t.templateFileKey}>
                  <Sparkles className="w-3.5 h-3.5" /> Generate documents
                </Button>
                {!t.templateFileKey && (
                  <span className="ml-2 text-[12px] text-amber-700 dark:text-amber-400 font-bold">needs a template file</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {generations.length > 0 && (
        <Card label={<span className="inline-flex items-center gap-1.5"><History className="w-3.5 h-3.5" /> Recent production</span>}>
          <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)] -mx-4 sm:-mx-5">
            {generations.map((g) => (
              <li key={g.id} className="px-4 sm:px-5 py-2.5 flex items-center gap-2 text-[13.5px]">
                <FileOutput className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                <span className="font-bold text-[var(--color-text)]">{g.templateName ?? "Template"}</span>
                <span className="text-[var(--color-text-muted)] truncate">
                  {g.documentCount} document{g.documentCount === 1 ? "" : "s"}
                  {g.sourceName ? ` from ${g.sourceName}` : ""}
                  {g.createdBy ? ` · ${g.createdBy}` : ""}
                </span>
                {g.filedCount > 0 && (
                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[11px] font-black bg-emerald-500/10 border border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400">
                    {g.filedCount} filed
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[12px] text-[var(--color-text-muted)]">
                  {new Date(g.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      </PageBody>

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
