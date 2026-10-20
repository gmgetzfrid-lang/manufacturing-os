"use client";

// ChatShell — one chat, every source.
//
// Three columns: the conversations rail, the stream with its floating
// composer, and an on-demand panel. The library engine, the tool-calling
// controller and internet mode are scopes of ONE conversation model, so
// the reader never has to know which API route they are talking to.
//
// Everything the two old surfaces had is here, placed by how often it is
// needed: inline for decisions (confirm an action, pick a facet, give a
// value), collapsed for what's about one answer (the trace), the panel for
// reading (a cited page, a past answer, instructions), one corner chip for
// status. Nothing was removed; the stream is quiet because of where things
// live, not because something was cut.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PanelLeftOpen, Square } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { appConfirm } from "@/components/providers/DialogProvider";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  listThreads, getThread, createThread, updateThread, deleteThread, listMessages, insertReplayedTurn,
  searchPastAnswers, citedSourcesChanged, getProfile, saveProfile, uploadChatAttachment, classifyAttachment,
  askTurn, mapMessage, mergeMessagePayload, ChatTablesMissingError, ATTACHMENT_LIMITS,
  type ChatThread, type ChatMessage, type ChatScope, type ChatAttachment, type PastAnswer, type ChatProfile,
  type AssistantPayload,
} from "@/lib/chatClient";
import {
  listKnowledgeLibraries, listKnowledgeDocuments, listLibraryLinks, acceptAiAgreement,
  type KnowledgeLibrary, type KnowledgeDocument, type KnowledgeCitation,
} from "@/lib/knowledge";
import { countActiveInstructions, saveAiInstruction } from "@/lib/aiInstructions";
import { executeAction, type PendingAction } from "@/lib/orchestratorClient";
import type { DocLink } from "@/components/knowledge/answer/AnswerExperience";
import ThreadRail from "./ThreadRail";
import MessageStream, { type StreamingState } from "./MessageStream";
import Composer, { type PendingAttachment } from "./Composer";
import MemoryStrip from "./MemoryStrip";
import StatusChip from "./StatusChip";
import RightPanel, { type PanelState, type ViewerTarget } from "./RightPanel";
import { UserTurn, AssistantTurn, type ActionState } from "./Turns";
import { SCOPE_META } from "./shared";

const LAST_SCOPE_KEY = "chat-last-scope";
const EMPTY_PROFILE: ChatProfile = { discipline: "", units: "", defaultLibraryId: null, notes: "" };

export default function ChatShell() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const { showToast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const orgId = activeOrgId ?? "";
  const canPromote = activeRole === "Admin" || activeRole === "DocCtrl";

  // ── Rail ──
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  // Phones start with the rail closed; it is a drawer there.
  useEffect(() => {
    if (!isMobile) return;
    const t = setTimeout(() => setRailOpen(false), 0);
    return () => clearTimeout(t);
  }, [isMobile]);
  const [libraries, setLibraries] = useState<KnowledgeLibrary[]>([]);
  const libraryFilterId = searchParams.get("library");

  // ── The conversation ──
  const [active, setActive] = useState<ChatThread | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draftScope, setDraftScope] = useState<ChatScope>("library");
  const [draftLibraryId, setDraftLibraryId] = useState<string | null>(null);
  const [draftInstructions, setDraftInstructions] = useState("");
  const scope: ChatScope = active?.scope ?? draftScope;
  const libraryId = active ? active.libraryId : draftLibraryId;

  // ── Composer + run ──
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const overloadRetried = useRef(false);
  const [statusBump, setStatusBump] = useState(0);
  const [actions, setActions] = useState<Record<string, ActionState>>({});

  // ── Panel + memory ──
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [past, setPast] = useState<PastAnswer | null>(null);
  const [pastChanged, setPastChanged] = useState<string[] | null>(null);
  const dismissedRef = useRef("");
  const [profile, setProfile] = useState<ChatProfile>(EMPTY_PROFILE);
  const [standingCount, setStandingCount] = useState(0);

  // ── Library documents (citations open the real page) ──
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [docsFor, setDocsFor] = useState<string | null>(null);

  const libraryNames = useMemo(() => new Map(libraries.map((l) => [l.id, l.name])), [libraries]);
  const userName = userEmail;

  // ── Boot: libraries, profile, standing instructions, rail, deep link ──
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void (async () => {
      const [libs, prof, count] = await Promise.all([
        listKnowledgeLibraries(orgId),
        uid ? getProfile(orgId, uid).catch(() => null) : Promise.resolve(null),
        countActiveInstructions(orgId, "knowledge").catch(() => 0),
      ]);
      if (cancelled) return;
      setLibraries(libs);
      if (prof) setProfile(prof);
      setStandingCount(count);
      // Default scope: the deep link, else what was used last, else the
      // profile's default library, else the first library, else the tools.
      const wanted = searchParams.get("scope");
      let last: string | null = null;
      try { last = window.localStorage.getItem(LAST_SCOPE_KEY); } catch { /* ignore */ }
      const lastScope = (last?.split(":")[0] ?? "") as ChatScope;
      const lastLib = last?.split(":")[1] ?? null;
      if (libraryFilterId && libs.some((l) => l.id === libraryFilterId)) {
        setDraftScope(wanted === "internet" ? "internet" : "library");
        setDraftLibraryId(libraryFilterId);
      } else if (wanted === "tools") {
        setDraftScope("tools"); setDraftLibraryId(null);
      } else if (lastScope === "tools") {
        setDraftScope("tools"); setDraftLibraryId(null);
      } else if ((lastScope === "library" || lastScope === "internet") && lastLib && libs.some((l) => l.id === lastLib)) {
        setDraftScope(lastScope); setDraftLibraryId(lastLib);
      } else if (prof?.defaultLibraryId && libs.some((l) => l.id === prof.defaultLibraryId)) {
        setDraftScope("library"); setDraftLibraryId(prof.defaultLibraryId);
      } else if (libs[0]) {
        setDraftScope("library"); setDraftLibraryId(libs[0].id);
      } else {
        setDraftScope("tools"); setDraftLibraryId(null);
      }
    })();
    return () => { cancelled = true; };
    // Boot once per org; the deep-link params are read at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, uid]);

  const refreshThreads = useCallback(async () => {
    if (!orgId) return;
    try {
      const list = await listThreads(orgId, { libraryId: libraryFilterId });
      setThreads(list);
      setThreadsError(null);
    } catch (e) {
      setThreadsError(e instanceof ChatTablesMissingError ? e.message : (e as Error).message);
    } finally {
      setThreadsLoading(false);
    }
  }, [orgId, libraryFilterId]);
  useEffect(() => { void refreshThreads(); }, [refreshThreads]);

  // Open the deep-linked thread (or close when the param goes away).
  const threadParam = searchParams.get("thread");
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    if (!threadParam) {
      queueMicrotask(() => { if (!cancelled) { setActive(null); setMessages([]); } });
      return () => { cancelled = true; };
    }
    void (async () => {
      const t = await getThread(threadParam).catch(() => null);
      if (cancelled) return;
      if (!t || t.orgId !== orgId) { showToast({ type: "error", title: "That conversation isn't here anymore." }); router.replace("/assistant"); return; }
      const ms = await listMessages(t.id).catch(() => []);
      if (cancelled) return;
      setActive(t); setMessages(ms); setPanel(null); setPast(null);
      // Outcomes already recorded on turns come back as done.
      const next: Record<string, ActionState> = {};
      for (const m of ms) {
        const p = m.payload as (AssistantPayload & { outcomes?: ActionState["outcomes"]; approved?: string[] }) | null;
        if (m.role === "assistant" && p && (p.outcomes || p.approved)) {
          next[m.id] = { approved: p.approved ?? [], outcomes: p.outcomes ?? {} };
        }
      }
      setActions(next);
    })();
    return () => { cancelled = true; };
  }, [threadParam, orgId, router, showToast]);

  // Documents of the library in play (plus linked libraries), for citations.
  useEffect(() => {
    if (!libraryId || scope === "tools") { queueMicrotask(() => setDocs([])); return; }
    let cancelled = false;
    void (async () => {
      const [own, links] = await Promise.all([listKnowledgeDocuments(libraryId), listLibraryLinks(libraryId).catch(() => [])]);
      const linked = await Promise.all(links.map((l) => listKnowledgeDocuments(l.linkedLibraryId).catch(() => [])));
      if (!cancelled) { setDocs([...own, ...linked.flat()]); setDocsFor(libraryId); }
    })();
    return () => { cancelled = true; };
  }, [libraryId, scope]);

  // Remember the source for next time.
  useEffect(() => {
    try { window.localStorage.setItem(LAST_SCOPE_KEY, `${scope}:${libraryId ?? ""}`); } catch { /* ignore */ }
  }, [scope, libraryId]);

  // Asked-before: debounced, strong matches only, remembered dismissals.
  useEffect(() => {
    const q = value.trim();
    if (!orgId || q.length < 12 || q === dismissedRef.current) { queueMicrotask(() => { setPast(null); setPastChanged(null); }); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const hits = await searchPastAnswers(orgId, q, { scope, limit: 6 }).catch(() => []);
      if (cancelled) return;
      const top = hits[0];
      if (!top || top.similarity < 0.45) { setPast(null); setPastChanged(null); return; }
      setPast(top);
      const changed = await citedSourcesChanged(top.payload).catch(() => []);
      if (!cancelled) setPastChanged(changed);
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [value, orgId, scope]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // ── Navigation ──
  const openThread = useCallback((t: ChatThread) => {
    if (streaming) return;
    const params = new URLSearchParams();
    params.set("thread", t.id);
    if (libraryFilterId) params.set("library", libraryFilterId);
    router.replace(`/assistant?${params.toString()}`);
    if (isMobile) setRailOpen(false);
  }, [router, libraryFilterId, isMobile, streaming]);

  const startNew = useCallback((next?: { scope: ChatScope; libraryId: string | null }) => {
    if (streaming) return;
    if (next) { setDraftScope(next.scope); setDraftLibraryId(next.libraryId); }
    setDraftInstructions("");
    setValue(""); setAttachments([]); setPanel(null); setPast(null);
    const params = new URLSearchParams();
    if (libraryFilterId) params.set("library", libraryFilterId);
    router.replace(params.toString() ? `/assistant?${params.toString()}` : "/assistant");
    if (isMobile) setRailOpen(false);
  }, [router, libraryFilterId, isMobile, streaming]);

  // ── Rail actions ──
  const patchThread = (id: string, patch: Partial<ChatThread>) => {
    setThreads((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setActive((a) => (a && a.id === id ? { ...a, ...patch } : a));
  };
  const onPin = async (t: ChatThread, pinned: boolean) => { patchThread(t.id, { pinned }); await updateThread(t.id, { pinned }).catch(() => refreshThreads()); };
  const onSettle = async (t: ChatThread, settled: boolean) => {
    const settledAt = settled ? new Date().toISOString() : null;
    patchThread(t.id, { settledAt });
    await updateThread(t.id, { settledAt }).catch(() => refreshThreads());
  };
  const onRename = async (t: ChatThread, title: string) => { patchThread(t.id, { title }); await updateThread(t.id, { title }).catch(() => refreshThreads()); };
  const onDelete = async (t: ChatThread) => {
    const ok = await appConfirm({ title: "Delete this conversation?", message: `"${t.title || "Untitled"}" and its turns will be removed for everyone. Attachments stay in storage.`, confirmLabel: "Delete" });
    if (!ok) return;
    try {
      await deleteThread(t.id);
      setThreads((ts) => ts.filter((x) => x.id !== t.id));
      if (active?.id === t.id) startNew();
    } catch (e) { showToast({ type: "error", title: (e as Error).message }); }
  };

  // ── Attachments ──
  const addFiles = useCallback((files: File[]) => {
    if (!orgId || !uid) return;
    const room = ATTACHMENT_LIMITS.maxFiles - attachments.length;
    if (room <= 0) { showToast({ type: "error", title: `Up to ${ATTACHMENT_LIMITS.maxFiles} attachments per question.` }); return; }
    for (const file of files.slice(0, room)) {
      const cls = classifyAttachment(file);
      const localId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      if ("error" in cls) {
        setAttachments((as) => [...as, { localId, att: null, name: file.name, size: file.size, kind: "pdf", percent: 0, error: cls.error }]);
        continue;
      }
      const previewUrl = cls.kind === "image" ? URL.createObjectURL(file) : undefined;
      setAttachments((as) => [...as, { localId, att: null, name: file.name, size: file.size, kind: cls.kind, percent: 0, previewUrl }]);
      void uploadChatAttachment({
        orgId, threadId: active?.id ?? null, uid, file, kind: cls.kind,
        onProgress: (p) => setAttachments((as) => as.map((a) => (a.localId === localId ? { ...a, percent: p.percent } : a))),
      }).then(
        (att) => setAttachments((as) => as.map((a) => (a.localId === localId ? { ...a, att, percent: 100 } : a))),
        (e) => setAttachments((as) => as.map((a) => (a.localId === localId ? { ...a, error: (e as Error).message } : a))),
      );
    }
  }, [orgId, uid, attachments.length, active?.id, showToast]);
  const removeAttachment = (localId: string) => setAttachments((as) => {
    const a = as.find((x) => x.localId === localId);
    if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
    return as.filter((x) => x.localId !== localId);
  });

  // ── The turn ──
  const send = useCallback(async (question: string, opts: {
    focus?: string[]; inputs?: string; approved?: string[]; retry?: boolean;
    answerMode?: "answer" | "compliance" | "explore" | "deviation";
  } = {}) => {
    const q = question.trim();
    if (!orgId || !uid || !q || streaming) return;
    if (attachments.some((a) => !a.att && !a.error)) {
      showToast({ type: "info", title: "Wait for the attachment to finish uploading, then ask again." });
      return;
    }
    if (scope !== "tools" && !libraryId) { showToast({ type: "error", title: "Pick a library first." }); return; }
    const atts = attachments.filter((a) => a.att).map((a) => a.att as ChatAttachment);

    // A brand-new conversation that already has instructions is created
    // here so the server has them from the first turn.
    let threadId = active?.id ?? null;
    if (!threadId && draftInstructions.trim()) {
      try {
        const t = await createThread({ orgId, scope, libraryId, title: q.slice(0, 120), uid, userName });
        await updateThread(t.id, { instructions: draftInstructions.trim() });
        threadId = t.id;
      } catch (e) { showToast({ type: "error", title: (e as Error).message }); return; }
    }

    const tmpId = `tmp-${Date.now()}`;
    setMessages((ms) => [...ms, {
      id: tmpId, threadId: threadId ?? "", role: "user", content: q,
      payload: opts.focus || opts.inputs ? { focus: opts.focus, inputs: opts.inputs } : null,
      attachments: atts, userId: uid, userName, status: "done", error: null, createdAt: new Date().toISOString(),
    }]);
    setStreaming({ status: "Starting", draft: "", question: q, attachmentsCount: atts.length });
    setValue(""); setPast(null); dismissedRef.current = "";
    const controller = new AbortController();
    abortRef.current = controller;

    let landedThreadId = threadId;
    let needsAgreement: { text: string } | null = null;
    let overloaded = false;
    try {
      await askTurn({
        orgId, scope, libraryId: scope === "tools" ? null : libraryId, threadId, question: q,
        focus: opts.focus, inputs: opts.inputs, approved: opts.approved, attachments: atts,
        ...(opts.answerMode ? { answerMode: opts.answerMode } : {}),
      }, (ev) => {
        if (controller.signal.aborted) return;
        switch (ev.t) {
          case "thread": {
            const t = ev.thread as Record<string, unknown>;
            landedThreadId = t.id as string;
            if (!active || active.id !== landedThreadId) {
              const mapped: ChatThread = {
                id: t.id as string, orgId: t.org_id as string, scope: t.scope as ChatScope,
                libraryId: (t.library_id as string | null) ?? null, title: (t.title as string) ?? "",
                instructions: (t.instructions as string | null) ?? null, pinned: !!t.pinned,
                settledAt: (t.settled_at as string | null) ?? null, createdBy: (t.created_by as string | null) ?? null,
                createdByName: (t.created_by_name as string | null) ?? null, createdAt: t.created_at as string,
                lastMessageAt: (t.last_message_at as string) ?? (t.created_at as string),
              };
              setActive(mapped);
              setThreads((ts) => (ts.some((x) => x.id === mapped.id) ? ts : [mapped, ...ts]));
            }
            break;
          }
          case "user":
            setMessages((ms) => ms.map((m) => (m.id === tmpId ? mapMessage(ev.message) : m)));
            break;
          case "status":
            setStreaming((s) => (s ? { ...s, status: ev.text } : s));
            break;
          case "delta":
            setStreaming((s) => (s ? { ...s, draft: s.draft + ev.text } : s));
            break;
          case "reset":
            setStreaming((s) => (s ? { ...s, draft: "" } : s));
            break;
          case "result": {
            if (ev.message) setMessages((ms) => [...ms, mapMessage(ev.message as Record<string, unknown>)]);
            const now = new Date().toISOString();
            setThreads((ts) => ts.map((t) => (t.id === ev.threadId ? { ...t, lastMessageAt: now, settledAt: null } : t)));
            setActive((a) => (a && a.id === ev.threadId ? { ...a, lastMessageAt: now, settledAt: null } : a));
            if (active?.settledAt) void updateThread(ev.threadId, { settledAt: null }).catch(() => undefined);
            break;
          }
          case "error": {
            if (ev.agreementRequired) { needsAgreement = { text: String(ev.agreementText ?? "") }; break; }
            if (/overloaded/i.test(String(ev.error ?? "")) && !overloadRetried.current) { overloaded = true; break; }
            if (ev.withdrawn) {
              setMessages((ms) => ms.filter((m) => m.id !== tmpId));
              if (!threadId && ev.threadId) setThreads((ts) => ts.filter((t) => t.id !== ev.threadId));
              if (!threadId) setActive(null);
              showToast({ type: "error", title: String(ev.error ?? "The question didn't run."), duration: 8000 });
            } else if (ev.threadId) {
              // The server recorded the failed turn — show it as it is.
              void listMessages(ev.threadId).then(setMessages).catch(() => undefined);
            }
            break;
          }
          default: break;
        }
      }, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted) {
        setMessages((ms) => ms.filter((m) => m.id !== tmpId));
        showToast({ type: "error", title: (e as Error).message || "The question failed." });
      }
    } finally {
      if (!controller.signal.aborted) {
        setStreaming(null);
        setAttachments((as) => { as.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl)); return []; });
        setStatusBump((b) => b + 1);
        if (landedThreadId && !threadParam) {
          const params = new URLSearchParams();
          params.set("thread", landedThreadId);
          if (libraryFilterId) params.set("library", libraryFilterId);
          router.replace(`/assistant?${params.toString()}`);
        }
      }
    }

    if (needsAgreement) {
      setMessages((ms) => ms.filter((m) => m.id !== tmpId));
      const agreed = await appConfirm({
        title: "Before your first question — the ground rules",
        message: (needsAgreement as { text: string }).text ||
          "Everything you type is sent to the workspace's AI provider. Never enter passwords, financial details, or personal identity information — work questions only.",
        confirmLabel: "I agree",
      });
      if (!agreed) return;
      await acceptAiAgreement(orgId);
      setValue(q);
      showToast({ type: "success", title: "Thanks — send your question again." });
      return;
    }
    if (overloaded) {
      overloadRetried.current = true;
      setMessages((ms) => ms.filter((m) => m.id !== tmpId));
      showToast({ type: "info", title: "The AI provider is briefly overloaded — retrying in a few seconds…" });
      setTimeout(() => { void send(q, { ...opts, retry: true }); }, 6_000);
      return;
    }
    overloadRetried.current = false;
  }, [orgId, uid, scope, libraryId, streaming, attachments, active, draftInstructions, userName, showToast, threadParam, libraryFilterId, router]);

  // ── Asked from the library page: "?ask=" runs the question as soon as the
  //    library it was asked of is selected. Once — the URL is rewritten to
  //    the new thread when it lands, and the ref stops a re-run meanwhile.
  const askParam = searchParams.get("ask");
  const askedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!askParam || askedRef.current === askParam) return;
    if (!orgId || !uid || streaming || active || !libraryFilterId || draftLibraryId !== libraryFilterId) return;
    askedRef.current = askParam;
    void send(askParam);
  }, [askParam, orgId, uid, streaming, active, libraryFilterId, draftLibraryId, send]);

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(null);
    showToast({ type: "info", title: "Stopped. If the answer still lands, reopen the conversation to see it." });
    if (active) void listMessages(active.id).then(setMessages).catch(() => undefined);
  };

  // ── Citations open the real page ──
  const docById = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs]);
  const openCitation = useCallback((c: KnowledgeCitation) => {
    const doc = docById.get(c.documentId ?? "");
    if (!doc) { showToast({ type: "error", title: "That document is no longer in the library." }); return; }
    const pools = messages.map((m) => (m.payload as AssistantPayload | null)?.kind === "library" ? ((m.payload as AssistantPayload & { citations?: KnowledgeCitation[] }).citations ?? []) : []);
    const siblings = pools.find((p) => p.includes(c)) ?? [c];
    const sources = siblings.filter((x) => !x.url && x.documentId).map((x) => {
      const d = docById.get(x.documentId!);
      return d ? { fileKey: d.fileKey, page: x.page ?? 1, quote: x.highlight ?? x.quote ?? null, title: x.documentName ?? d.name, section: x.section ?? null, documentId: d.id, tags: x.tags, n: x.n } : null;
    }).filter((s): s is NonNullable<typeof s> => s !== null);
    const byN = sources.findIndex((s) => s.n === c.n);
    const sourceIndex = Math.max(0, byN >= 0 ? byN : sources.findIndex((s) => s.documentId === c.documentId && s.page === (c.page ?? 1)));
    const target: ViewerTarget = {
      fileKey: doc.fileKey, page: c.page ?? 1, quote: c.highlight ?? c.quote ?? null, title: c.documentName ?? doc.name,
      section: c.section ?? null, documentId: doc.id, tags: c.tags,
      ...(sources.length > 1 ? { sources, sourceIndex } : {}),
    };
    setPanel({ kind: "viewer", target });
  }, [docById, messages, showToast]);
  const openMentionedDoc = useCallback((d: DocLink) => {
    setPanel({ kind: "viewer", target: { fileKey: d.fileKey, page: d.page, quote: null, title: d.name, section: null, documentId: d.id } });
  }, []);
  const openTag = useCallback((documentId: string, page: number, tag: string, documentName: string) => {
    const doc = docById.get(documentId);
    if (!doc) { showToast({ type: "error", title: "That sheet is no longer in the library." }); return; }
    setPanel({ kind: "viewer", target: { fileKey: doc.fileKey, page, quote: null, title: documentName || doc.name, section: null, documentId, tags: [tag] } });
  }, [docById, showToast]);

  // ── Proposed writes: confirm runs EXACTLY the proposal, server-side ──
  const confirmAction = useCallback(async (m: ChatMessage, action: PendingAction) => {
    if (!orgId) return;
    const fp = action.fingerprint;
    setActions((as) => ({ ...as, [m.id]: { approved: as[m.id]?.approved ?? [], outcomes: as[m.id]?.outcomes ?? {}, executing: fp } }));
    let outcome: { ok: boolean; note: string };
    try {
      const result = await executeAction(orgId, action);
      outcome = { ok: true, note: String(result.status ?? "done") };
    } catch (e) {
      outcome = { ok: false, note: e instanceof Error ? e.message : "The action failed." };
    }
    let next: ActionState = { approved: [], outcomes: {} };
    setActions((as) => {
      const cur = as[m.id] ?? { approved: [], outcomes: {} };
      next = { approved: outcome.ok ? [...cur.approved, fp] : cur.approved, outcomes: { ...cur.outcomes, [fp]: outcome }, executing: null };
      return { ...as, [m.id]: next };
    });
    void mergeMessagePayload(m.id, { approved: next.approved, outcomes: next.outcomes }).catch(() => undefined);
  }, [orgId]);

  // ── Memory: reuse a past answer here ──
  const reusePast = useCallback(async (p: PastAnswer) => {
    if (!orgId || !uid) return;
    try {
      let t = active;
      if (!t) {
        t = await createThread({ orgId, scope: p.scope, libraryId: p.libraryId, title: p.question.slice(0, 120), uid, userName });
        setActive(t); setThreads((ts) => [t!, ...ts]);
        const params = new URLSearchParams(); params.set("thread", t.id);
        if (libraryFilterId) params.set("library", libraryFilterId);
        router.replace(`/assistant?${params.toString()}`);
      }
      const added = await insertReplayedTurn({
        orgId, threadId: t.id, uid, userName, question: p.question, answer: p.answer, payload: p.payload,
        replayedFrom: { messageId: p.messageId, threadId: p.threadId, userName: p.userName, createdAt: p.createdAt },
      });
      setMessages((ms) => [...ms, ...added]);
      setValue(""); setPast(null); setPanel(null);
    } catch (e) { showToast({ type: "error", title: (e as Error).message }); }
  }, [orgId, uid, active, userName, libraryFilterId, router, showToast]);

  // ── Instructions + profile ──
  const instructions = active ? (active.instructions ?? "") : draftInstructions;
  const saveInstructions = async (text: string) => {
    if (active) { await updateThread(active.id, { instructions: text.trim() || null }); patchThread(active.id, { instructions: text.trim() || null }); }
    else setDraftInstructions(text);
  };
  const saveProfileNow = async (p: ChatProfile) => { if (!uid) return; await saveProfile(orgId, uid, p); setProfile(p); };
  const promote = async (text: string) => {
    if (!uid) return;
    await saveAiInstruction(orgId, { scope: "knowledge", title: `From a conversation${active?.title ? `: ${active.title.slice(0, 60)}` : ""}`, body: text }, uid, userName ?? undefined);
    setStandingCount((c) => c + 1);
    showToast({ type: "success", title: "Added to the org playbook — applies to every library answer from now on." });
  };

  // ── Thumbs-up settles the conversation (the answered-questions shelf) ──
  const onRated = useCallback((rating: 1 | -1 | 0) => {
    if (!active || rating !== 1 || active.settledAt) return;
    void onSettle(active, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (!orgId) return <div className="p-8 text-sm text-[var(--color-text-muted)]">Select a workspace to continue.</div>;

  const readyDocs = scope === "library" ? docs.filter((d) => d.libraryId === libraryId && d.status === "ready").length : 1;
  const disabledReason = scope === "library" && libraryId && docsFor === libraryId && readyDocs === 0
    ? "Nothing indexed in this library yet — add PDFs on its page, or pick another source."
    : scope !== "tools" && !libraryId ? "Pick a library to ask." : null;
  const libraryFilter = libraryFilterId ? { id: libraryFilterId, name: libraryNames.get(libraryFilterId) ?? "This library" } : null;
  const panelOpen = panel !== null;
  const ScopeIcon = SCOPE_META[scope].icon;

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      {/* Rail */}
      {railOpen && (
        <div className={isMobile
          ? "absolute inset-y-0 left-0 z-40 w-[85vw] max-w-xs shadow-2xl"
          : "w-72 shrink-0"}>
          <ThreadRail
            threads={threads} activeId={active?.id ?? null} libraryNames={libraryNames} uid={uid}
            libraryFilter={libraryFilter}
            onClearLibraryFilter={() => router.replace(active ? `/assistant?thread=${active.id}` : "/assistant")}
            onOpen={openThread} onNew={() => startNew()}
            onPin={onPin} onSettle={onSettle} onRename={onRename} onDelete={onDelete}
            onClose={() => setRailOpen(false)}
            loading={threadsLoading} error={threadsError}
          />
        </div>
      )}
      {isMobile && railOpen && <div className="absolute inset-0 z-30 bg-black/40" onClick={() => setRailOpen(false)} />}

      {/* Stream */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="h-11 px-3 sm:px-4 border-b border-[var(--color-border)] flex items-center gap-2 shrink-0 bg-[var(--color-surface)]/70 backdrop-blur">
          {!railOpen && (
            <button onClick={() => setRailOpen(true)} title="Conversations"
              className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]">
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          )}
          <ScopeIcon className={`w-4 h-4 shrink-0 ${scope === "internet" ? "text-sky-600" : scope === "tools" ? "text-violet-600" : "text-orange-600"}`} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-black text-[var(--color-text)] truncate">{active?.title || "New conversation"}</div>
          </div>
          {streaming && (
            <button onClick={stop} className="hidden sm:inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-[var(--color-border)] text-[10px] font-black text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              <Square className="w-3 h-3" /> Stop
            </button>
          )}
          <StatusChip orgId={orgId} bump={statusBump} />
        </div>

        <MessageStream
          messages={messages} streaming={streaming} scope={scope}
          emptyNote={disabledReason}
          onExample={(q) => void send(q)}
          renderUser={(m) => (
            <UserTurn key={m.id} m={m} mine={m.userId === uid}
              onOpenAttachment={(a) => setPanel({ kind: "attachment", att: a })} />
          )}
          renderAssistant={(m, isLast) => (
            <AssistantTurn
              m={m} isLast={isLast}
              onCite={openCitation} onOpenDoc={openMentionedDoc} onOpenTag={openTag}
              onClarify={(question, focus) => void send(question, { focus })}
              onNeed={(question, values, focus, priorInputs) => void send(question, { focus, inputs: priorInputs ? `${priorInputs}; ${values}` : values })}
              onConfirm={confirmAction}
              actions={actions[m.id] ?? { approved: [], outcomes: {} }}
              onRetry={(question) => void send(question)}
              onRethink={(question, answerMode) => void send(question, answerMode ? { answerMode } : {})}
              onAttach={addFiles}
              onRated={onRated}
            />
          )}
        />

        <div className="shrink-0 px-3 sm:px-6 pb-4 pt-1">
          <div className="mx-auto max-w-3xl">
            {past && !streaming && (
              <MemoryStrip past={past} changed={pastChanged}
                onReview={() => setPanel({ kind: "review", past, changed: pastChanged })}
                onReuse={() => void reusePast(past)}
                onDismiss={() => { dismissedRef.current = value.trim(); setPast(null); }} />
            )}
            <Composer
              value={value} onChange={setValue}
              onSend={() => void send(value)} onStop={stop} busy={!!streaming}
              scope={scope} libraryId={libraryId} libraries={libraries}
              onScopeChange={(s, lib) => {
                if (active) startNew({ scope: s, libraryId: lib });
                else { setDraftScope(s); setDraftLibraryId(lib); }
              }}
              scopeLocked={!!active}
              attachments={attachments} onAddFiles={addFiles} onRemoveAttachment={removeAttachment}
              instructionsActive={!!instructions.trim()}
              instructionCount={standingCount + (instructions.trim() ? 1 : 0)}
              onToggleInstructions={() => setPanel((p) => (p?.kind === "instructions" ? null : { kind: "instructions" }))}
              disabledReason={disabledReason}
              autoFocus={!isMobile}
            />
            <p className="mt-1.5 px-1 text-[10px] text-[var(--color-text-faint)] truncate">{SCOPE_META[scope].hint}</p>
          </div>
        </div>
      </div>

      {/* Panel */}
      {panelOpen && (
        <div className={isMobile
          ? "absolute inset-0 z-40 bg-[var(--color-surface)]"
          : "w-[420px] xl:w-[500px] 2xl:w-[560px] shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface)]"}>
          <RightPanel
            state={panel!} onClose={() => setPanel(null)} orgId={orgId} thread={active} libraries={libraries}
            canPromote={canPromote}
            instructions={instructions} onSaveInstructions={saveInstructions}
            profile={profile} onSaveProfile={saveProfileNow} standingCount={standingCount}
            onPromote={promote} onReuse={(p) => void reusePast(p)} onCite={openCitation}
          />
        </div>
      )}
    </div>
  );
}
