"use client";

// /output-templates — document production. Register a blank template once
// (it owns the formatting), attach an example (it owns the voice), then feed
// data and get finished, correctly formatted documents back in one pass
// instead of authoring them one at a time.

import React, { useCallback, useEffect, useState } from "react";
import {
  Plus, Sparkles, Pencil, Trash2, FileText, Table2,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, heroPrimary, heroQuiet, type HeroFact } from "@/components/ui/PageHero";
import { Skeleton, SkeletonRows } from "@/components/ui/Skeleton";
import ErrorNote from "@/components/ui/ErrorNote";
import MoreMenu from "@/components/ui/MoreMenu";
import { friendlyError } from "@/lib/friendlyError";
import { fmtWhen, relTime } from "@/components/requests/RequestBits";
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
  const [loadError, setLoadError] = useState<unknown>(null);
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
      setLoadError(e ?? new Error("read failed"));
    } finally { setLoading(false); }
  }, [activeOrgId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const remove = async (t: OutputTemplate) => {
    const ok = await appConfirm({
      title: "Delete this template?",
      message: `"${t.name}" and its saved fill points will be removed. Documents already generated are unaffected.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok || !activeOrgId) return;
    try {
      await deleteOutputTemplate(activeOrgId, t.id);
      await refresh();
    } catch (e) { showToast({ type: "error", title: "The template wasn't deleted", message: friendlyError(e) }); }
  };

  const madeDocs = generations.reduce((n, g) => n + (g.documentCount ?? 0), 0);
  const needFile = templates.filter((t) => !t.templateFileKey).length;
  // The answer: what can't run yet, else what's ready.
  const answer = loading ? <Skeleton className="h-7 w-64 max-w-full" />
    : loadError != null && templates.length === 0 ? "The templates didn't load."
      : templates.length === 0 ? "No output templates yet."
        : needFile > 0 ? `${needFile} ${needFile === 1 ? "template needs its" : "templates need their"} file.`
          : `${templates.length} ${templates.length === 1 ? "template" : "templates"} ready.`;
  const facts: HeroFact[] | undefined = !loading && templates.length > 0 ? [
    { label: "Templates", value: templates.length },
    { label: "Need a file", value: needFile, tone: needFile > 0 ? "warn" : undefined },
    { label: "Documents in recent runs", value: madeDocs },
  ] : undefined;
  const last = generations[0];

  return (
    <PageShell>
      <PageHero
        kicker="Output docs"
        title={answer}
        facts={facts}
        factsHero="none"
        sub={last ? <>Last run: {last.templateName ?? "a template"}, {last.documentCount} document{last.documentCount === 1 ? "" : "s"}{last.createdBy ? ` by ${last.createdBy}` : ""}, {relTime(last.createdAt).replace(/^(Just now|Yesterday)$/, (m) => m.toLowerCase())}.</> : "Your template sets the format, your example sets the voice, your data fills the blanks."}
        primary={isController ? <button type="button" className={heroPrimary} onClick={() => setEditing(null)}><Plus className="w-4 h-4" /> New template</button> : undefined}
      />

      <PageBody>
      {loadError != null && (
        <ErrorNote error={loadError} title={templates.length > 0 ? "The list didn't refresh." : undefined} onRetry={() => void refresh()} />
      )}
      {loading ? (
        <SkeletonRows rows={3} cols={3} what="output templates" />
      ) : templates.length === 0 ? (
        loadError != null ? null : (
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-10 text-center">
            <p className="text-[15px] text-[var(--color-text)]">
              {isController
                ? "Upload a blank Word file with {placeholders} where the content goes. New template starts one."
                : "Admin or Doc Control set templates up here."}
            </p>
          </div>
        )
      ) : (
        <section aria-labelledby="ot-templates">
          <h2 id="ot-templates" className="font-display text-[20px] leading-tight font-semibold text-[var(--color-text)] mb-3">
            Templates <span className="ui-count">{templates.length}</span>
          </h2>
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            <table className="w-full text-[14px] max-md:block">
              <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left max-md:hidden">
                <tr>
                  <th className="font-semibold px-4 h-10">Template</th>
                  <th className="font-semibold px-4 w-44">Makes</th>
                  <th className="font-semibold px-4 text-right w-28">Fill points</th>
                  <th className="font-semibold px-4 text-right w-28 hidden lg:table-cell">Examples</th>
                  <th className="w-44"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)] max-md:block">
              {templates.map((t) => (
                <tr key={t.id}
                  onClick={isController ? (e) => { if ((e.target as HTMLElement).closest("a,button,[role=menu]")) return; setEditing(t); } : undefined}
                  className={`max-md:flex max-md:items-start ${isController ? "cursor-pointer hover:bg-[var(--color-surface-2)]" : ""}`}>
                  <td className="px-4 py-3 max-md:flex-1 max-md:min-w-0 max-md:block">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="shrink-0 text-[var(--color-text-faint)]" aria-hidden>{t.kind === "xlsx" ? <Table2 className="w-4 h-4" /> : <FileText className="w-4 h-4" />}</span>
                      {isController
                        ? <button type="button" onClick={() => setEditing(t)} className="text-left text-[15px] font-semibold text-[var(--color-text)] truncate hover:text-[var(--color-accent-text)]">{t.name}</button>
                        : <span className="text-[15px] font-semibold text-[var(--color-text)] truncate">{t.name}</span>}
                    </div>
                    {!t.templateFileKey ? (
                      <div className="pl-[26px] mt-0.5"><span className="ui-pill is-warn">Needs its template file</span></div>
                    ) : t.description && <div className="pl-[26px] text-[13px] text-[var(--color-text-muted)] truncate max-w-[60ch]">{t.description}</div>}
                    {/* Phone: the facts under the name. */}
                    <div className="md:hidden pl-[26px] mt-0.5 flex flex-wrap gap-x-3 text-[13px] text-[var(--color-text-muted)]">
                      <span>{MODE_LABEL[t.mode] ?? t.mode}</span>
                      <span>{t.placeholders.length} fill point{t.placeholders.length === 1 ? "" : "s"}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 max-md:hidden">
                    <span className="text-[var(--color-text)]">{MODE_LABEL[t.mode] ?? t.mode}</span>
                    {t.placeholders.some((p) => p.kind === "ai") && (
                      <span className="mt-0.5 flex whitespace-nowrap text-[13px] text-[var(--color-text-muted)] items-center gap-1"><Sparkles aria-hidden className="w-3 h-3" /> AI writes some parts</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums max-md:hidden">{t.placeholders.length}</td>
                  <td className={`px-4 py-3 text-right tabular-nums hidden lg:table-cell ${t.exampleFiles.length === 0 ? "text-[var(--color-text-faint)]" : ""}`}>{t.exampleFiles.length}</td>
                  <td className="px-3 py-2.5 max-md:pl-0">
                    {/* Generate is the row's point; edit and delete in its menu. */}
                    <div className="flex items-center gap-1 justify-end">
                      <button type="button" onClick={() => setGenerating(t)} disabled={!t.templateFileKey}
                        title={!t.templateFileKey ? "Add the template file first (Edit)" : `Make documents from ${t.name}`}
                        className={`${heroQuiet} h-8 pointer-coarse:h-11 px-3 text-[13px]`}>
                        Generate
                      </button>
                      {isController && (
                        <MoreMenu iconOnly label={`More for ${t.name}`}
                          triggerClass="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 grid place-items-center rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]"
                          items={[
                            { icon: <Pencil className="w-4 h-4" />, label: "Edit", onClick: () => setEditing(t) },
                            { icon: <Trash2 className="w-4 h-4" />, label: "Delete", tone: "bad", line: true, onClick: () => void remove(t) },
                          ]} />
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
        <section aria-labelledby="ot-runs">
          <h2 id="ot-runs" className="font-display text-[20px] leading-tight font-semibold text-[var(--color-text)] mb-3">Recent runs <span className="ui-count">{generations.length}</span></h2>
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
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
                      {g.documentCount} document{g.documentCount === 1 ? "" : "s"}{g.filedCount > 0 ? `, ${g.filedCount} filed` : ""}, {fmtWhen(g.createdAt)}{g.createdBy ? ` by ${g.createdBy}` : ""}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums max-md:hidden">{g.documentCount}</td>
                  <td className="px-4 py-2.5 text-[var(--color-text-muted)] hidden lg:table-cell truncate max-w-0">{g.sourceName ?? <span className="text-[var(--color-text-faint)]">None</span>}</td>
                  <td className="px-4 py-2.5 hidden lg:table-cell">{g.createdBy ?? <span className="text-[var(--color-text-faint)]">Unknown</span>}</td>
                  <td className="px-4 py-2.5 max-md:hidden">
                    {g.filedCount > 0
                      ? <span className="ui-pill is-good">{g.filedCount} filed</span>
                      : <span className="text-[var(--color-text-faint)]">Not filed</span>}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--color-text-muted)] whitespace-nowrap tabular-nums max-md:hidden">
                    {fmtWhen(g.createdAt)}
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
