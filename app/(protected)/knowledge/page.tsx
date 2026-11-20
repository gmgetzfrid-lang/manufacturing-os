"use client";

// /knowledge — AI knowledge libraries. Shelves of reference PDFs (standards,
// engineering practices, vendor manuals) indexed for full-text retrieval and
// answered by whatever AI provider the workspace (or the individual) plugged
// in. Admin/DocCtrl build the shelves; every member can ask them questions.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BookOpen, Plus, Loader2, Settings2, Sparkles, FileText, AlertTriangle,
} from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { useDraft } from "@/hooks/useDraft";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Field";
import { EmptyState } from "@/components/ui/EmptyState";
import AiSettingsModal from "@/components/knowledge/AiSettingsModal";
import {
  listKnowledgeLibraries, createKnowledgeLibrary, getAiConnections,
  type KnowledgeLibrary,
} from "@/lib/knowledge";

export default function KnowledgePage() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const { showToast } = useToast();
  const router = useRouter();
  const isController = activeRole === "Admin" || activeRole === "DocCtrl";

  const [libraries, setLibraries] = useState<KnowledgeLibrary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiConfigured, setAiConfigured] = useState<boolean | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // What's typed for a new library waits on this device until it's made.
  const newLib = React.useMemo(() => ({ name, description }), [name, description]);
  const libDraft = useDraft<{ name: string; description: string }>(
    activeOrgId ? `knowledge:new-library:${activeOrgId}` : null, newLib,
    (d) => { setName(d.name ?? ""); setDescription(d.description ?? ""); },
    (d) => !d.name.trim() && !d.description.trim(),
  );

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
    setCreateError(null);
    try {
      const lib = await createKnowledgeLibrary({
        orgId: activeOrgId, name, description,
        userId: uid, userName: userEmail ?? "Member",
      });
      setShowCreate(false); setName(""); setDescription(""); libDraft.clear();
      showToast({ type: "success", title: "Library made. Add PDFs to start indexing." });
      // Straight into the new library, where the PDFs go.
      router.push(`/knowledge/${lib.id}`);
    } catch (e) {
      setCreateError((e as Error).message);
    } finally { setCreating(false); }
  };

  return (
    <PageShell>
      <ViewTabs title="Intelligence" tabs={INTELLIGENCE_VIEWS} />
      <PageHeaderBar
        title="Knowledge"
        subtitle="Reference libraries you can ask. Answers cite the page."
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
        <p className="mb-4 border-l-2 border-amber-500 pl-3 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            <b>No AI key yet.</b> Libraries can be built and indexed, but questions need a key. Add one in{" "}
            <button className="underline font-bold" onClick={() => setShowSettings(true)}>AI settings</button> (Anthropic or OpenAI). The key owner pays the provider directly.
          </span>
        </p>
      )}

      {error && (
        <p role="alert" className="mb-4 border-l-2 border-red-500 pl-3 text-xs font-bold text-red-700 dark:text-red-400">
          Couldn&apos;t load the libraries: {error}. If the knowledge tables aren&apos;t migrated yet, run migration 20260911.
        </p>
      )}

      {libraries === null ? (
        error ? null : <LoadingBlock what="the libraries" rows={4} />
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
              className="group rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 hover:border-[var(--color-border-strong)] hover:shadow-md transition-all">
              <div className="flex items-start justify-between gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-[var(--color-text)]">
                  <Sparkles className="w-5 h-5 text-[var(--color-surface)]" />
                </div>
                <span className="inline-flex items-center gap-1 text-[11px] font-black text-[var(--color-text-muted)]">
                  <FileText className="w-3 h-3" /> {lib.documentCount ?? 0} document{(lib.documentCount ?? 0) === 1 ? "" : "s"}
                </span>
              </div>
              <h3 className="mt-3 text-sm font-black text-[var(--color-text)] group-hover:text-[var(--color-text)] transition-colors">{lib.name}</h3>
              {lib.description && (
                <p className="mt-1 text-xs text-[var(--color-text-muted)] line-clamp-2">{lib.description}</p>
              )}
              <div className="mt-3 text-[11px] text-[var(--color-text-muted)]">
                Created {new Date(lib.createdAt).toLocaleDateString()}{lib.createdByName ? ` · ${lib.createdByName}` : ""}
              </div>
            </Link>
          ))}
        </div>
      )}

      {showCreate && (
        <Modal onClose={() => setShowCreate(false)} dismissable={!creating}>
            <ModalHeader icon={BookOpen} title="New knowledge library" onClose={creating ? undefined : () => setShowCreate(false)} />
            <ModalBody className="space-y-3">
              <label className="block">
                <span className="text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Engineering Standards & Practices" autoFocus />
              </label>
              <label className="block">
                <span className="text-[11px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Description (optional)</span>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
                  placeholder="What lives in this library and who should ask it questions" />
              </label>
              {createError && <p role="alert" className="text-xs font-semibold text-red-700 dark:text-red-400">Not made: {createError}</p>}
            </ModalBody>
            <ModalFooter>
                <Button variant="secondary" onClick={() => setShowCreate(false)} disabled={creating}>Cancel</Button>
                <Button onClick={() => void create()} disabled={creating || !name.trim()}>
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create
                </Button>
            </ModalFooter>
        </Modal>
      )}

      {activeOrgId && (
        <AiSettingsModal orgId={activeOrgId} open={showSettings}
          onClose={() => { setShowSettings(false); void refresh(); }} />
      )}
    </PageShell>
  );
}
