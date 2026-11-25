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
import { relTime } from "@/components/requests/RequestBits";
import Timeline, { type TimelineItem } from "@/components/ui/Timeline";
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
      confirmLabel: "Delete template",
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
  // The title already says how many are ready or need a file: the facts add
  // only what it doesn't (the total beside a "need a file" title, and what
  // the recent runs made), and a zero stays out.
  const factList: HeroFact[] = !loading && templates.length > 0 ? [
    ...(needFile > 0 ? [{ label: "Templates", value: templates.length }] : []),
    ...(madeDocs > 0 ? [{ label: "Documents in recent runs", value: madeDocs }] : []),
  ] : [];
  const facts: HeroFact[] | undefined = factList.length > 0 ? factList : undefined;
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
            <p className="text-reading text-[var(--color-text)]">
              {isController
                ? "Upload a blank Word file with {placeholders} where the content goes. New template starts one."
                : "Admin or Doc Control set templates up here."}
            </p>
          </div>
        )
      ) : (
        <section aria-labelledby="ot-templates">
          <h2 id="ot-templates" className="font-display text-section leading-tight font-semibold text-[var(--color-text)] mb-3">
            Templates <span className="ui-count">{templates.length}</span>
          </h2>
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            <table className="w-full text-body max-md:block">
              <thead className="bg-[var(--color-surface-2)] text-body text-[var(--color-text-muted)] text-left max-md:hidden">
                <tr>
                  <th className="font-medium px-4 h-10">Template</th>
                  <th className="font-medium px-4 w-44">Makes</th>
                  <th className="font-medium px-4 text-right w-28">Fill points</th>
                  <th className="font-medium px-4 text-right w-28 hidden lg:table-cell">Examples</th>
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
                        ? <button type="button" onClick={() => setEditing(t)} className="text-left text-reading font-medium text-[var(--color-text)] truncate hover:text-[var(--color-accent-text)]">{t.name}</button>
                        : <span className="text-reading font-medium text-[var(--color-text)] truncate">{t.name}</span>}
                    </div>
                    {!t.templateFileKey ? (
                      <div className="pl-[26px] mt-0.5"><span className="ui-pill is-warn">Needs its template file</span></div>
                    ) : t.description && <div className="pl-[26px] text-body text-[var(--color-text-muted)] truncate max-w-[60ch]">{t.description}</div>}
                    {/* Phone: the facts under the name. */}
                    <div className="md:hidden pl-[26px] mt-0.5 flex flex-wrap gap-x-3 text-body text-[var(--color-text-muted)]">
                      <span>{MODE_LABEL[t.mode] ?? t.mode}</span>
                      <span>{t.placeholders.length} fill point{t.placeholders.length === 1 ? "" : "s"}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 max-md:hidden">
                    <span className="text-[var(--color-text)]">{MODE_LABEL[t.mode] ?? t.mode}</span>
                    {t.placeholders.some((p) => p.kind === "ai") && (
                      <span className="mt-0.5 flex whitespace-nowrap text-body text-[var(--color-text-muted)] items-center gap-1"><Sparkles aria-hidden className="w-3 h-3" /> AI writes some parts</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums max-md:hidden">{t.placeholders.length}</td>
                  <td className={`px-4 py-3 text-right tabular-nums hidden lg:table-cell ${t.exampleFiles.length === 0 ? "text-[var(--color-text-faint)]" : ""}`}>{t.exampleFiles.length}</td>
                  <td className="px-3 py-2.5 max-md:pl-0">
                    {/* Generate is the row's point; edit and delete in its menu. */}
                    <div className="flex items-center gap-1 justify-end">
                      <button type="button" onClick={() => setGenerating(t)} disabled={!t.templateFileKey}
                        title={!t.templateFileKey ? "Add the template file first (Edit)" : `Make documents from ${t.name}`}
                        className={`${heroQuiet} h-8 pointer-coarse:h-11 px-3 text-body`}>
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
        // A history: newest first, by day, who as an avatar.
        <section aria-labelledby="ot-runs">
          <h2 id="ot-runs" className="font-display text-section leading-tight font-semibold text-[var(--color-text)] mb-3">Recent runs <span className="ui-count">{generations.length}</span></h2>
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 sm:px-5 py-4">
            <Timeline items={generations.map((g): TimelineItem => ({
              id: g.id,
              at: g.createdAt,
              kind: "Made",
              tone: g.filedCount > 0 ? "good" : "muted",
              title: <>{g.documentCount} document{g.documentCount === 1 ? "" : "s"} from {g.templateName ?? "a template"}</>,
              detail: [g.sourceName ? `From ${g.sourceName}` : null, g.filedCount > 0 ? `${g.filedCount} filed` : "Not filed"].filter(Boolean).join(" · "),
              who: g.createdBy ? { name: g.createdBy } : null,
            }))} />
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
