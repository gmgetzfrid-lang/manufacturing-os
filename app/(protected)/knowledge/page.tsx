"use client";

// /knowledge — AI knowledge libraries. Shelves of reference PDFs (standards,
// engineering practices, vendor manuals) indexed for full-text retrieval and
// answered by whatever AI provider the workspace (or the individual) plugged
// in. Admin/DocCtrl build the shelves; every member can ask them questions.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BookOpen, Plus, Loader2, Settings2, AlertTriangle,
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
  const emptyCount = (libraries ?? []).filter((l) => (l.documentCount ?? 0) === 0).length;
  const answer = libraries === null
    ? (error ? "The libraries didn't load" : "Knowledge")
    : libraries.length === 0 ? "No knowledge libraries yet"
      : docTotal === 0 ? "No documents in any library yet"
        : `${docTotal.toLocaleString()} ${docTotal === 1 ? "document" : "documents"} you can ask`;
  const when = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
  };

  return (
    <PageShell>
      <PageHero
        kicker="Intelligence · Knowledge"
        title={answer}
        sub="Reference libraries you can ask. Answers cite the page."
        facts={libraries && libraries.length > 0 ? [
          { label: "Libraries", value: libraries.length },
          { label: "Documents", value: docTotal.toLocaleString() },
          { label: "Empty", value: emptyCount, tone: emptyCount > 0 ? "warn" : undefined },
        ] : undefined}
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
      {aiConfigured === false && (
        // A warning is a row with its status on the edge.
        <div className="relative pl-4 py-1 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-held)]" />
          <p className="min-w-0 flex-1 basis-72 text-[15px] text-[var(--color-text)]">
            <AlertTriangle className="inline w-4 h-4 -mt-0.5 mr-1.5 text-[var(--state-held)]" />
            <span className="font-semibold">No AI key yet, so questions can&apos;t run.</span>{" "}
            <span className="text-[var(--color-text-muted)]">Libraries still build and index. The key owner pays the provider directly.</span>
          </p>
          <button type="button" className={heroQuiet} onClick={() => setShowSettings(true)}>Add a key</button>
        </div>
      )}
      {error && (
        <div className="relative pl-4 py-1">
          <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] rounded-full bg-[var(--state-overdue)]" />
          <p role="alert" className="text-[15px] font-semibold text-[var(--state-overdue)]">
            Couldn&apos;t load the libraries: {error}. If the knowledge tables aren&apos;t migrated yet, run migration 20260911.
          </p>
        </div>
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
        // The libraries as one ruled table: the whole row opens it.
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <table className="w-full text-[15px]">
            <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
              <tr>
                <th className="font-semibold px-4 h-10">Library</th>
                <th className="font-semibold px-4 text-right whitespace-nowrap">Documents</th>
                <th className="font-semibold px-4 hidden sm:table-cell">Status</th>
                <th className="font-semibold px-4 hidden md:table-cell">Created</th>
                <th className="font-semibold px-4 hidden lg:table-cell">By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {libraries.map((lib) => {
                const n = lib.documentCount ?? 0;
                return (
                  <tr key={lib.id} onClick={() => router.push(`/knowledge/${lib.id}`)} className="hover:bg-[var(--color-surface-2)] cursor-pointer align-top">
                    <td className="px-4 py-3 min-w-0">
                      <Link href={`/knowledge/${lib.id}`} onClick={(e) => e.stopPropagation()}
                        className="font-display text-[17px] font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">
                        {lib.name}
                      </Link>
                      {lib.description && (
                        <p className="mt-0.5 text-[14px] text-[var(--color-text-muted)] line-clamp-1 max-w-[70ch]">{lib.description}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-display text-[17px] font-semibold tabular-nums text-[var(--color-text)]">{n.toLocaleString()}</td>
                    <td className="px-4 py-3 hidden sm:table-cell whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--color-text)]">
                        <span aria-hidden className={`w-2 h-2 rounded-full ${n === 0 ? "bg-[var(--state-held)]" : "bg-[var(--state-released)]"}`} />
                        {n === 0 ? "Empty" : "Has documents"}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell whitespace-nowrap text-[var(--color-text-muted)]">{when(lib.createdAt)}</td>
                    <td className="px-4 py-3 hidden lg:table-cell whitespace-nowrap text-[var(--color-text-muted)]">{lib.createdByName ? lib.createdByName.split("@")[0] : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
              {createError && <p role="alert" className="text-[13px] font-semibold text-[var(--state-overdue)]">Not made: {createError}</p>}
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
