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
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
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
        : `${templates.length} ${templates.length === 1 ? "template" : "templates"}.`;
  const facts = !loading && templates.length > 0 ? [
    { label: "Made lately", value: madeDocs.toLocaleString() },
    { label: "Need a file", value: templates.filter((t) => !t.templateFileKey).length.toLocaleString(), tone: templates.some((t) => !t.templateFileKey) ? "warn" as const : undefined },
  ] : undefined;

  return (
    <PageShell>
      <PageHero
        kicker="Output docs"
        title={answer}
        facts={facts}
        sub="Your template sets the format, your example sets the voice, your data fills the blanks."
        primary={isController ? <button type="button" className={heroPrimary} onClick={() => setEditing(null)}><Plus className="w-4 h-4" /> New template</button> : undefined}
      />

      <PageBody>
      {loading ? (
        <Card><LoadingBlock what="output templates" rows={5} className="border-0 p-0" /></Card>
      ) : templates.length === 0 && loadError ? (
        <Card>
          <p role="alert" className="text-[15px] font-semibold text-[var(--state-overdue)]">Couldn&apos;t load the templates: {loadError}</p>
          <button type="button" onClick={() => void refresh()} className={`${heroQuiet} mt-3`}>Try again</button>
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
        <section>
          <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)] mb-2.5">Templates</h2>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            <table className="w-full text-[15px]">
              <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left max-md:hidden">
                <tr>
                  <th className="font-semibold px-4 h-10">Template</th>
                  <th className="font-semibold px-4 w-40">Fills</th>
                  <th className="font-semibold px-4 text-right w-28">Fill points</th>
                  <th className="font-semibold px-4 text-right w-28 hidden lg:table-cell">Examples</th>
                  <th className="w-[13rem]"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
              {templates.map((t) => (
                <tr key={t.id} className="hover:bg-[var(--color-surface-2)] max-md:block">
                  <td className="px-4 pt-3 md:py-3 max-md:block">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {t.kind === "xlsx" ? <Table2 className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" /> : <FileText className="w-4 h-4 shrink-0 text-[var(--color-text-muted)]" />}
                      <span className="font-semibold text-[var(--color-text)] truncate">{t.name}</span>
                    </div>
                    {!t.templateFileKey ? (
                      <div className="pl-[26px] inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text)]"><span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-held)]" />Needs a template file</div>
                    ) : t.description && <div className="pl-[26px] text-[13px] text-[var(--color-text-muted)] truncate max-w-[60ch]">{t.description}</div>}
                    {/* Phone: the facts under the name. */}
                    <div className="md:hidden pl-[26px] mt-0.5 flex flex-wrap gap-x-3 text-[13px] text-[var(--color-text-muted)]">
                      <span>{MODE_LABEL[t.mode] ?? t.mode}</span>
                      <span>{t.placeholders.length} fill point{t.placeholders.length === 1 ? "" : "s"}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[14px] max-md:hidden">
                    {MODE_LABEL[t.mode] ?? t.mode}
                    {t.placeholders.some((p) => p.kind === "ai") && (
                      <span className="block text-[13px] text-[var(--color-text-muted)] inline-flex items-center gap-1"><Sparkles className="w-3 h-3" /> AI-written sections</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-display text-[16px] font-semibold tabular-nums max-md:hidden">{t.placeholders.length}</td>
                  <td className="px-4 py-3 text-right font-display text-[16px] font-semibold tabular-nums hidden lg:table-cell">{t.exampleFiles.length}</td>
                  <td className="px-3 pb-3 md:py-3 max-md:block max-md:pl-[42px]">
                    <div className="flex items-center gap-1.5 md:justify-end flex-wrap">
                      <button type="button" onClick={() => setGenerating(t)} disabled={!t.templateFileKey}
                        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[13px] font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50 disabled:cursor-not-allowed">
                        <Sparkles className="w-3.5 h-3.5 text-[var(--color-text-muted)]" /> Generate
                      </button>
                      {isController && (
                        <>
                          <button type="button" onClick={() => setEditing(t)} title="Edit" aria-label={`Edit ${t.name}`}
                            className="inline-grid w-8 h-8 place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]">
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button type="button" onClick={() => void remove(t)} title="Delete" aria-label={`Delete ${t.name}`}
                            className="inline-grid w-8 h-8 place-items-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--state-overdue)] hover:bg-[var(--color-surface-2)]">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {generations.length > 0 && (
        <section>
          <h2 className="font-display text-[19px] leading-tight font-semibold text-[var(--color-text)] mb-2.5 inline-flex items-center gap-2"><History className="w-4 h-4 text-[var(--color-text-muted)]" /> Recent production</h2>
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            <table className="w-full text-[14px]">
              <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left max-md:hidden">
                <tr>
                  <th className="font-semibold px-4 h-10">Template</th>
                  <th className="font-semibold px-4 text-right w-28">Documents</th>
                  <th className="font-semibold px-4 hidden lg:table-cell">From</th>
                  <th className="font-semibold px-4 hidden lg:table-cell">By</th>
                  <th className="font-semibold px-4 w-28">Filed</th>
                  <th className="font-semibold px-4 w-44">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
              {generations.map((g) => (
                <tr key={g.id} className="max-md:block max-md:px-4 max-md:py-2.5">
                  <td className="md:px-4 md:py-2.5 font-semibold text-[var(--color-text)] max-md:block">
                    {g.templateName ?? "Template"}
                    <span className="md:hidden block font-normal text-[13px] text-[var(--color-text-muted)]">
                      {g.documentCount} document{g.documentCount === 1 ? "" : "s"}{g.filedCount > 0 ? `, ${g.filedCount} filed` : ""}, {new Date(g.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-display text-[15px] font-semibold tabular-nums max-md:hidden">{g.documentCount}</td>
                  <td className="px-4 py-2.5 text-[var(--color-text-muted)] hidden lg:table-cell truncate max-w-0">{g.sourceName ?? "-"}</td>
                  <td className="px-4 py-2.5 hidden lg:table-cell">{g.createdBy ?? "-"}</td>
                  <td className="px-4 py-2.5 max-md:hidden">
                    {g.filedCount > 0
                      ? <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold"><span aria-hidden className="w-2 h-2 rounded-full bg-[var(--state-released)]" />{g.filedCount} filed</span>
                      : <span className="text-[var(--color-text-muted)]">-</span>}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--color-text-muted)] whitespace-nowrap max-md:hidden">
                    {new Date(g.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </td>
                </tr>
              ))}
              </tbody>
            </table>
          </div>
        </section>
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
