"use client";

// /knowledge — AI knowledge libraries. Shelves of reference PDFs (standards,
// engineering practices, vendor manuals) indexed for full-text retrieval and
// answered by whatever AI provider the workspace (or the individual) plugged
// in. Admin/DocCtrl build the shelves; every member can ask them questions.

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Settings2, AlertTriangle } from "lucide-react";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { ErrorNote } from "@/components/ui/ErrorNote";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { friendlyError } from "@/lib/friendlyError";
import { transitionPush } from "@/lib/viewTransition";
import { useDraft } from "@/hooks/useDraft";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import ViewTabs, { INTELLIGENCE_VIEWS } from "@/components/navigation/ViewTabs";
import { Button } from "@/components/ui/Button";
import { Input, Textarea, FieldError } from "@/components/ui/Field";
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
  const [error, setError] = useState<unknown>(null);
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
    } catch (e) { setError(e ?? true); }
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
      setCreateError(friendlyError(e));
    } finally { setCreating(false); }
  };

  const docTotal = (libraries ?? []).reduce((n, l) => n + (l.documentCount ?? 0), 0);
  const emptyCount = (libraries ?? []).filter((l) => (l.documentCount ?? 0) === 0).length;
  const answer = libraries === null
    ? (error ? "Couldn't load the libraries." : "Knowledge")
    : libraries.length === 0 ? "No knowledge libraries yet."
      : docTotal === 0 ? "No documents in any library yet."
        : `${docTotal.toLocaleString()} ${docTotal === 1 ? "document" : "documents"} you can ask.`;
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
          { label: "Empty", value: emptyCount },
        ] : undefined}
        factsHero="none"
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
          <p className="min-w-0 flex-1 basis-72 text-reading text-[var(--color-text)]">
            <AlertTriangle className="inline w-4 h-4 -mt-0.5 mr-1.5 text-[var(--state-held)]" />
            <span className="font-medium">No AI key yet, so questions can&apos;t run.</span>{" "}
            <span className="text-[var(--color-text-muted)]">Libraries still build and index. The key owner pays the provider directly.</span>
          </p>
          <button type="button" className={heroQuiet} onClick={() => setShowSettings(true)}>Add a key</button>
        </div>
      )}
      {!!error && (
        <ErrorNote error={error} title="Couldn't load the libraries." onRetry={() => void refresh()} />
      )}

      {libraries === null ? (
        error ? null : <SkeletonRows rows={4} cols={3} what="the libraries" />
      ) : libraries.length === 0 ? (
        <Card>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <p className="flex-1 min-w-[16rem] text-reading text-[var(--color-text-muted)]">
              {isController
                ? "Make a library, drop your standards and engineering-practice PDFs in, and ask it questions instead of reading 400 pages."
                : "Admin or Doc Control can make libraries of standards and reference PDFs that everyone can then ask."}
            </p>
            {isController && <Button variant="secondary" onClick={() => setShowCreate(true)}><Plus aria-hidden className="w-4 h-4" /> Make the first library</Button>}
          </div>
        </Card>
      ) : (
        // The libraries as one ruled table: the whole row opens it.
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <table className="w-full text-body tabular-nums">
            <thead className="bg-[var(--color-surface-2)] text-body text-[var(--color-text-muted)] text-left max-sm:hidden">
              <tr>
                <th className="font-medium px-4 h-10">Library</th>
                <th className="font-medium px-4 text-right whitespace-nowrap">Documents</th>
                <th className="font-medium px-4 hidden sm:table-cell">Status</th>
                <th className="font-medium px-4 hidden md:table-cell">Added</th>
                <th className="px-4 hidden sm:table-cell"><span className="sr-only">Ask</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {libraries.map((lib) => {
                const n = lib.documentCount ?? 0;
                const by = lib.createdByName ? lib.createdByName.split("@")[0] : "";
                return (
                  <tr key={lib.id} onClick={() => transitionPush(router, `/knowledge/${lib.id}`)} className="hover:bg-[var(--color-surface-2)] cursor-pointer align-top">
                    <td className="px-4 py-3 min-w-0">
                      <Link href={`/knowledge/${lib.id}`} onClick={(e) => e.stopPropagation()}
                        className="text-reading font-medium text-[var(--color-text)] hover:text-[var(--color-accent-text)]">
                        {lib.name}
                      </Link>
                      {lib.description && (
                        <p className="mt-0.5 text-body text-[var(--color-text-muted)] line-clamp-1 max-w-[70ch]">{lib.description}</p>
                      )}
                      <p className="sm:hidden mt-0.5 text-body text-[var(--color-text-muted)]">{n === 0 ? "Empty" : `${n.toLocaleString()} ${n === 1 ? "document" : "documents"}`} · added {when(lib.createdAt)}</p>
                    </td>
                    <td className={`px-4 py-3 text-right whitespace-nowrap max-sm:hidden ${n === 0 ? "text-[var(--color-text-faint)]" : "text-[var(--color-text)]"}`}>{n.toLocaleString()}</td>
                    <td className="px-4 py-3 hidden sm:table-cell whitespace-nowrap">
                      <span className={`ui-pill ${n === 0 ? "is-muted" : "is-good"}`}>{n === 0 ? "Empty" : "Ready to ask"}</span>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell whitespace-nowrap text-body text-[var(--color-text-muted)]">{when(lib.createdAt)}{by ? ` by ${by}` : ""}</td>
                    {/* Straight to asking this library. */}
                    <td className="px-4 py-3 text-right whitespace-nowrap hidden sm:table-cell">
                      {n > 0 && (
                        <Link href={`/assistant?library=${lib.id}`} onClick={(e) => e.stopPropagation()}
                          className="text-body font-medium text-[var(--color-accent-text)] hover:underline underline-offset-2">Ask it</Link>
                      )}
                    </td>
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
            <ModalHeader title="New knowledge library" onClose={creating ? undefined : () => setShowCreate(false)} />
            <ModalBody className="space-y-4">
              <label className="block">
                <span className="block text-body font-medium text-[var(--color-text)] mb-1.5">Name</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Engineering standards and practices" autoFocus autoComplete="off" />
              </label>
              <label className="block">
                <span className="block text-body font-medium text-[var(--color-text)] mb-1.5">Description <span className="font-normal text-[var(--color-text-muted)]">(optional)</span></span>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
                  placeholder="e.g. API and company standards for piping and vessels" />
              </label>
              {createError && <FieldError>Not made. {createError}</FieldError>}
            </ModalBody>
            <ModalFooter>
                <Button variant="secondary" onClick={() => setShowCreate(false)} disabled={creating}>Cancel</Button>
                <Button variant={name.trim() ? "primary" : "secondary"} loading={creating} onClick={() => void create()} disabled={!name.trim()}>
                  Create
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
