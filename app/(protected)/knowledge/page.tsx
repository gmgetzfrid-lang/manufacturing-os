"use client";

// /knowledge — AI knowledge libraries. Shelves of reference PDFs (standards,
// engineering practices, vendor manuals) indexed for full-text retrieval and
// answered by whatever AI provider the workspace (or the individual) plugged
// in. Admin/DocCtrl build the shelves; every member can ask them questions.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  BookOpen, Plus, Loader2, X, Settings2, Sparkles, FileText, AlertTriangle,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import AiSettingsModal from "@/components/knowledge/AiSettingsModal";
import {
  listKnowledgeLibraries, createKnowledgeLibrary, getAiConnections,
  type KnowledgeLibrary,
} from "@/lib/knowledge";

export default function KnowledgePage() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const { showToast } = useToast();
  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  const [libraries, setLibraries] = useState<KnowledgeLibrary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      setLibraries(await listKnowledgeLibraries(activeOrgId));
      setError(null);
    } catch (e) { setError((e as Error).message); }
    try {
      const conns = await getAiConnections(activeOrgId);
      setAiConfigured(!!conns.effective);
    } catch { setAiConfigured(null); }
  }, [activeOrgId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    if (!activeOrgId || !uid || !name.trim()) return;
    setCreating(true);
    try {
      await createKnowledgeLibrary({
        orgId: activeOrgId, name, description,
        userId: uid, userName: userEmail ?? "Member",
      });
      setShowCreate(false); setName(""); setDescription("");
      showToast({ type: "success", title: "Library created — add PDFs to start indexing." });
      await refresh();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setCreating(false); }
  };

  return (
    <PageShell>
      <ViewTabs title="Intelligence" tabs={INTELLIGENCE_VIEWS} />
      <PageHeaderBar
        title="Knowledge"
        subtitle="AI-searchable reference libraries — ask questions, get answers cited to the page"
        icon={BookOpen}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setShowSettings(true)}>
              <Settings2 className="w-4 h-4" /> AI settings
            </Button>
            {isController && (
              <Button onClick={() => setShowCreate(true)}>
                <Plus className="w-4 h-4" /> New library
              </Button>
            )}
          </div>
        }
      />

      {aiConfigured === false && (
        <div className="mb-4 rounded-xl border-2 border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-4 py-3 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="text-xs text-amber-800 dark:text-amber-300">
            <b>No AI provider connected yet.</b> Libraries can be built and indexed, but questions need an API key —
            open <button className="underline font-bold" onClick={() => setShowSettings(true)}>AI settings</button> and
            add one (Anthropic, OpenAI or Gemini). The key owner pays the provider directly; this app adds no cost.
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 px-4 py-3 text-xs font-bold text-rose-700 dark:text-rose-300">
          {error} — if the knowledge tables haven&apos;t been migrated yet, run migration 20260911.
        </div>
      )}

      {libraries === null ? (
        <div className="py-16 text-center"><Spinner /></div>
      ) : libraries.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No knowledge libraries yet"
          description={isController
            ? "Create a library, drop your standards and engineering-practice PDFs in, and ask it questions instead of reading 400 pages."
            : "Admin or Doc Control can create libraries of standards and reference PDFs that everyone can then query."}
          action={isController ? <Button onClick={() => setShowCreate(true)}><Plus className="w-4 h-4" /> New library</Button> : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {libraries.map((lib) => (
            <Link key={lib.id} href={`/knowledge/${lib.id}`}
              className="group rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 hover:border-[var(--color-accent)] hover:shadow-lg transition-all">
              <div className="flex items-start justify-between gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center shrink-0">
                  <Sparkles className="w-5 h-5 text-white" />
                </div>
                <span className="inline-flex items-center gap-1 text-[10px] font-black text-[var(--color-text-muted)]">
                  <FileText className="w-3 h-3" /> {lib.documentCount ?? 0} document{(lib.documentCount ?? 0) === 1 ? "" : "s"}
                </span>
              </div>
              <h3 className="mt-3 text-sm font-black text-[var(--color-text)] group-hover:text-[var(--color-accent)] transition-colors">{lib.name}</h3>
              {lib.description && (
                <p className="mt-1 text-xs text-[var(--color-text-muted)] line-clamp-2">{lib.description}</p>
              )}
              <div className="mt-3 text-[10px] text-[var(--color-text-muted)]">
                Created {new Date(lib.createdAt).toLocaleDateString()}{lib.createdByName ? ` · ${lib.createdByName}` : ""}
              </div>
            </Link>
          ))}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4" onClick={() => setShowCreate(false)}>
          <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-xl mt-16"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
              <h2 className="text-base font-black text-[var(--color-text)]">New knowledge library</h2>
              <button onClick={() => setShowCreate(false)} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-3">
              <label className="block">
                <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Engineering Standards & Practices" autoFocus />
              </label>
              <label className="block">
                <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Description (optional)</span>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
                  placeholder="What lives in this library and who should ask it questions" />
              </label>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Button>
                <Button onClick={() => void create()} disabled={creating || !name.trim()}>
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeOrgId && (
        <AiSettingsModal orgId={activeOrgId} open={showSettings}
          onClose={() => { setShowSettings(false); void refresh(); }} />
      )}
    </PageShell>
  );
}
