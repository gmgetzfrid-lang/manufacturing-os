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
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
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

  const docTotal = (libraries ?? []).reduce((n, l) => n + (l.documentCount ?? 0), 0);
  const answer = libraries === null
    ? (error ? "The libraries didn't load." : "Knowledge")
    : libraries.length === 0 ? "No knowledge libraries yet."
      : `${libraries.length} ${libraries.length === 1 ? "library" : "libraries"}, ${docTotal.toLocaleString()} ${docTotal === 1 ? "document" : "documents"}.`;

  return (
    <PageShell>
      <PageHero
        kicker="Intelligence · Knowledge"
        title={answer}
        sub={
          <>
            Reference libraries you can ask. Answers cite the page.
            {aiConfigured === false && (
              <span className="block mt-1.5 text-amber-300">
                <AlertTriangle className="inline w-3.5 h-3.5 -mt-0.5 mr-1" />
                No AI key yet, so questions can&apos;t run. Libraries still build and index.{" "}
                <button className="underline font-bold text-white" onClick={() => setShowSettings(true)}>Add a key</button> (Anthropic or OpenAI). The key owner pays the provider directly.
              </span>
            )}
          </>
        }
        tools={
          <button type="button" className={heroQuiet} onClick={() => setShowSettings(true)}>
            <Settings2 className="w-4 h-4" /><span className="max-sm:hidden">AI settings</span><span className="sr-only sm:hidden">AI settings</span>
          </button>
        }
        primary={isController ? <button type="button" className={heroPrimary} onClick={() => setShowCreate(true)}><Plus className="w-4 h-4" /> New library</button> : undefined}
      >
        <ViewTabs tabs={INTELLIGENCE_VIEWS} variant="dark" />
      </PageHero>

      <PageBody>
      {error && (
        <Card>
          <p role="alert" className="text-[14px] font-semibold text-red-700 dark:text-red-400">
            Couldn&apos;t load the libraries: {error}. If the knowledge tables aren&apos;t migrated yet, run migration 20260911.
          </p>
        </Card>
      )}

      {libraries === null ? (
        error ? null : <Card><LoadingBlock what="the libraries" rows={4} className="border-0 p-0" /></Card>
      ) : libraries.length === 0 ? (
        <Card>
          <EmptyState
            icon={BookOpen}
            title="No knowledge libraries yet"
            description={isController
              ? "Create a library, drop your standards and engineering-practice PDFs in, and ask it questions instead of reading 400 pages."
              : "Admin or Doc Control can create libraries of standards and reference PDFs that everyone can then query."}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {libraries.map((lib) => (
            <Link key={lib.id} href={`/knowledge/${lib.id}`}
              className="group rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)] p-4 sm:p-5 transition-shadow hover:shadow-[0_1px_2px_rgb(11_18_32/0.06),0_30px_56px_-26px_rgb(11_18_32/0.5)]">
              <div className="flex items-center gap-3">
                <span className="w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 bg-[var(--color-surface-2)]">
                  <Sparkles className="w-4 h-4 text-[var(--color-text-muted)]" />
                </span>
                <h3 className="min-w-0 flex-1 text-[15px] font-bold text-[var(--color-text)] truncate">{lib.name}</h3>
              </div>
              {lib.description && (
                <p className="mt-2.5 text-[13px] text-[var(--color-text-muted)] line-clamp-2">{lib.description}</p>
              )}
              <div className="mt-3 pt-3 border-t border-[var(--color-border)] flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
                <FileText className="w-3.5 h-3.5" />
                <span className="font-semibold text-[var(--color-text)]">{(lib.documentCount ?? 0) === 0 ? "Empty" : `${lib.documentCount} document${lib.documentCount === 1 ? "" : "s"}`}</span>
                <span className="truncate">· Created {new Date(lib.createdAt).toLocaleDateString()}{lib.createdByName ? ` by ${lib.createdByName.split("@")[0]}` : ""}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      </PageBody>

      {showCreate && (
        <Modal onClose={() => setShowCreate(false)} dismissable={!creating}>
            <ModalHeader icon={BookOpen} title="New knowledge library" onClose={creating ? undefined : () => setShowCreate(false)} />
            <ModalBody className="space-y-3">
              <label className="block">
                <span className="text-[13px] font-semibold text-[var(--color-text-muted)]">Name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Engineering Standards & Practices" autoFocus />
              </label>
              <label className="block">
                <span className="text-[13px] font-semibold text-[var(--color-text-muted)]">Description (optional)</span>
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
