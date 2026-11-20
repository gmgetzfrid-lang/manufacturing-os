"use client";

// /transmittals — the transmittal register. A transmittal is the formal,
// numbered record of ISSUING documents (at specific revs) to a party for a
// stated purpose, with a printable cover sheet and receipt tracking. This is
// the canonical engineering doc-control artifact the rest of the app fed into
// but never produced.
//
// The page is both the register (list of every transmittal) and the composer
// (pick documents, set recipient + purpose, save draft or issue). It degrades
// gracefully if the `transmittals` table hasn't been migrated yet.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Send, Loader2, RefreshCw, AlertTriangle, Plus, Search, X, FileText,
  Printer, CheckCircle2, Trash2, Ban, Pencil, Package, Building2, Mail, User,
  Link as LinkIcon,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { supabase } from "@/lib/supabase";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet } from "@/components/ui/PageHero";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { useEscapeClose } from "@/components/documents/useEscapeClose";
import { useDraft } from "@/hooks/useDraft";
import {
  listTransmittals, createTransmittal, updateTransmittalDraft, issueTransmittal,
  acknowledgeTransmittal, voidTransmittal, deleteTransmittal, openTransmittalSheet,
  transmittalStatusMeta, isTransmittalIssuable, TRANSMITTAL_PURPOSES,
  transmittalPortalUrl,
  type Transmittal, type TransmittalItem,
} from "@/lib/transmittals";

interface DocHit {
  id: string;
  number: string;
  title: string;
  rev: string | null;
  versionId: string | null;
}

const TONE_CHIP: Record<string, string> = {
  slate: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]",
  blue: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]",
  emerald: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  rose: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-900",
};

export default function TransmittalsPage() {
  const { activeOrgId, uid, userEmail, activeRole } = useRole();
  const { showToast } = useToast();
  const [list, setList] = useState<Transmittal[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editing, setEditing] = useState<Transmittal | null>(null);
  const [preloadDoc, setPreloadDoc] = useState<TransmittalItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // ?t=<id> (from a notification or a document's trail) opens the register at
  // that transmittal: scrolled to and outlined. A just-saved one gets the same.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = new URLSearchParams(window.location.search).get("t");
    if (t) setHighlightId(t);
  }, []);
  useEffect(() => {
    if (!highlightId || !list) return;
    const el = document.querySelector(`[data-transmittal-id="${CSS.escape(highlightId)}"]`);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, [highlightId, list]);

  const actor = useMemo(() => ({
    orgId: activeOrgId ?? "",
    actorUserId: uid ?? "",
    actorName: userEmail ?? undefined,
    actorRole: activeRole ?? undefined,
  }), [activeOrgId, uid, userEmail, activeRole]);

  // Transmittals whose recipient now holds a superseded rev (any live item
  // whose as-sent rev differs from the document's current rev).
  const [staleIds, setStaleIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true); setError(null);
    try {
      const rows = await listTransmittals(activeOrgId);
      setList(rows);
      const live = rows.filter((t) => t.status === "issued" || t.status === "acknowledged");
      const docIds = [...new Set(live.flatMap((t) => t.items.map((i) => i.documentId)).filter(Boolean))];
      if (docIds.length) {
        const { data } = await supabase.from("documents").select("id, rev").in("id", docIds);
        const revOf = new Map((((data ?? []) as Array<{ id: string; rev: string | null }>)).map((d) => [d.id, d.rev]));
        setStaleIds(new Set(live
          .filter((t) => t.items.some((i) => i.rev && revOf.has(i.documentId) && revOf.get(i.documentId) && revOf.get(i.documentId) !== i.rev))
          .map((t) => t.id)));
      } else {
        setStaleIds(new Set());
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeOrgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Deep-link: /transmittals?compose=1&doc=<id> opens the composer with that
  // document pre-added (so the inspector can "Issue via transmittal").
  useEffect(() => {
    if (typeof window === "undefined" || !activeOrgId) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("compose") !== "1") return;
    const docId = params.get("doc");
    // Clear the params so a refresh doesn't reopen.
    window.history.replaceState(null, "", "/transmittals");
    (async () => {
      if (docId) {
        const { data } = await supabase
          .from("documents")
          .select("id, document_number, title, name, rev, current_version_id")
          .eq("id", docId)
          .maybeSingle();
        if (data) {
          setPreloadDoc({
            documentId: String(data.id),
            number: (data.document_number as string) || (data.title as string) || (data.name as string) || "-",
            title: (data.title as string) || null,
            rev: (data.rev as string) ?? null,
            versionId: (data.current_version_id as string) ?? null,
          });
        }
      }
      setEditing(null);
      setComposerOpen(true);
    })();
  }, [activeOrgId]);

  const openNew = () => { setEditing(null); setPreloadDoc(null); setComposerOpen(true); };
  const openEdit = (t: Transmittal) => { setEditing(t); setPreloadDoc(null); setComposerOpen(true); };

  const doAcknowledge = async (t: Transmittal) => {
    const name = await appPrompt({ message: "Who acknowledged receipt? (name)", defaultValue: t.recipientName || "" });
    if (name === null) return;
    setBusyId(t.id);
    try {
      await acknowledgeTransmittal(t.id, name, actor);
      showToast({ type: "success", title: "Receipt recorded", message: `${t.number} marked acknowledged.` });
      await refresh();
    } catch (e) {
      showToast({ type: "error", title: "Couldn't record receipt", message: (e as Error).message });
    } finally { setBusyId(null); }
  };

  const doVoid = async (t: Transmittal) => {
    if (!(await appConfirm({
      title: `Void ${t.number}?`,
      message: "It stays on the register as a voided record (it was issued, so it can't be deleted).",
      tone: "danger",
    }))) return;
    setBusyId(t.id);
    try {
      await voidTransmittal(t.id, actor);
      showToast({ type: "success", title: "Transmittal voided", message: `${t.number} marked voided.` });
      await refresh();
    } catch (e) {
      showToast({ type: "error", title: "Couldn't void", message: (e as Error).message });
    } finally { setBusyId(null); }
  };

  const doDelete = async (t: Transmittal) => {
    if (!(await appConfirm({
      title: `Delete draft ${t.number}?`,
      message: "This can't be undone.",
      tone: "danger",
    }))) return;
    setBusyId(t.id);
    try {
      await deleteTransmittal(t.id);
      showToast({ type: "success", title: "Draft deleted", message: `${t.number} removed.` });
      await refresh();
    } catch (e) {
      showToast({ type: "error", title: "Couldn't delete", message: (e as Error).message });
    } finally { setBusyId(null); }
  };

  const needsMigration = error?.toLowerCase().includes("aren't set up") || error?.toLowerCase().includes("migration");

  if (loading && !list) {
    return <div className="p-4 sm:p-6"><LoadingBlock what="the transmittals" rows={5} /></div>;
  }

  // The answer: how many went out, and how many still owe a receipt.
  const all = list ?? [];
  const waiting = all.filter((t) => t.status === "issued").length;
  const drafts = all.filter((t) => t.status === "draft").length;
  const received = all.filter((t) => t.status === "acknowledged").length;
  const answer = error && all.length === 0 ? "Transmittals didn't load."
    : all.length === 0 ? "No transmittals yet."
    : `${all.length.toLocaleString()} transmittal${all.length === 1 ? "" : "s"}${waiting > 0 ? `, ${waiting} waiting on a receipt` : ""}.`;
  const subBits: string[] = [];
  if (staleIds.size > 0) subBits.push(`${staleIds.size} went out with a revision that's now old.`);
  if (drafts > 0) subBits.push(`${drafts} draft${drafts === 1 ? "" : "s"} not issued.`);
  if (received > 0) subBits.push(`${received} received.`);
  const answerSub = subBits.length > 0 ? subBits.join(" ") : "Documents issued to others, each with a number, a cover sheet and a receipt.";

  return (
    <PageShell width="work">
      <PageHero
        kicker="Document control · Transmittals"
        title={answer}
        sub={answerSub}
        tools={
          <button type="button" onClick={() => void refresh()} disabled={loading} className={heroQuiet} aria-label="Refresh" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        }
        primary={
          <button type="button" onClick={openNew} className={heroPrimary}>
            <Plus className="w-4 h-4" /> New transmittal
          </button>
        }
      >
        <ViewTabs tabs={DOCUMENT_VIEWS} variant="dark" />
      </PageHero>

      <PageBody>
        {error && (
          <Card>
            <div role="alert" className={`text-[14px] flex items-start gap-2 ${needsMigration ? "text-amber-800 dark:text-amber-300" : "text-rose-700 dark:text-rose-300"}`}>
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-bold">{needsMigration ? "Transmittals aren't set up in this workspace yet" : "Couldn't load the transmittals"}</div>
                <div className="mt-0.5 text-[13px]">{error}</div>
              </div>
            </div>
          </Card>
        )}
        {highlightId && list && !list.some((t) => t.id === highlightId) && !error && (
          <Card>
            <p className="text-[14px] text-amber-800 dark:text-amber-300">
              That transmittal isn&apos;t on this register. It may have been deleted, or it&apos;s in another workspace.
            </p>
          </Card>
        )}

        {!error && (list?.length ?? 0) === 0 ? (
          <Card>
            <div className="py-6 text-center">
              <Send className="w-8 h-8 mx-auto text-[var(--color-text-faint)] mb-3" />
              <p className="text-[14px] text-[var(--color-text-muted)] max-w-md mx-auto">
                A transmittal issues documents to someone outside, at the revision they get, with a cover sheet and a receipt. Use New transmittal to send the first one.
              </p>
            </div>
          </Card>
        ) : (list ?? []).length > 0 && (
          <Card label="Register" pad={false} className="overflow-hidden">
            <div className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {(list ?? []).map((t) => {
              const meta = transmittalStatusMeta(t.status);
              return (
                <div key={t.id} data-transmittal-id={t.id} className={`px-4 sm:px-5 py-4 flex flex-wrap items-start gap-x-4 gap-y-2 scroll-mt-24 ${highlightId === t.id ? "bg-[var(--color-surface-2)] shadow-[inset_3px_0_0_0_var(--color-text)]" : ""}`}>
                  <div className="flex-1 min-w-[200px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[14px] font-black text-[var(--color-text)]">{t.number}</span>
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${TONE_CHIP[meta.tone]}`}>{meta.label}</span>
                      {t.purpose && <span className="text-[12px] text-[var(--color-text-muted)]">{t.purpose}</span>}
                      {staleIds.has(t.id) && (
                        <span className="text-[12px] font-bold text-rose-700 dark:text-rose-300" title="A document on it has a newer revision now. The recipient has an old one.">
                          They have an old revision
                        </span>
                      )}
                    </div>
                    <div className="text-[14px] font-semibold text-[var(--color-text)] mt-1">{t.subject || "Document Transmittal"}</div>
                    <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      {(t.recipientName || t.recipientCompany) && (
                        <span className="inline-flex items-center gap-1"><User className="w-3 h-3" />{[t.recipientName, t.recipientCompany].filter(Boolean).join(" · ")}</span>
                      )}
                      <span className="inline-flex items-center gap-1"><Package className="w-3 h-3" />{t.items.length} doc{t.items.length === 1 ? "" : "s"}</span>
                      {t.issuedAt && <span>Issued {new Date(t.issuedAt).toLocaleDateString()}</span>}
                      {t.status === "acknowledged" && t.acknowledgedAt && <span className="text-emerald-700 dark:text-emerald-400">Received {new Date(t.acknowledgedAt).toLocaleDateString()}{t.acknowledgedByName ? ` by ${t.acknowledgedByName}` : ""}{t.acknowledgedVia === "portal" ? ", confirmed by them" : t.acknowledgedVia === "manual" ? ", recorded by us" : ""}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    <button onClick={() => openTransmittalSheet(t)} title="Open the printable cover sheet" className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] text-[13px] font-semibold border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
                      <Printer className="w-3.5 h-3.5" /> Cover sheet
                    </button>
                    {t.portalToken && t.status !== "voided" && (
                      <button
                        onClick={() => {
                          void navigator.clipboard.writeText(transmittalPortalUrl(t.portalToken!));
                          showToast({ type: "success", title: "Portal link copied", message: `Send it to ${t.recipientName || t.recipientCompany || "the recipient"} - they can download the files and acknowledge receipt themselves.` });
                        }}
                        title="Copy the recipient's secure portal link, no account needed on their side"
                        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] text-[13px] font-semibold border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors"
                      >
                        <LinkIcon className="w-3.5 h-3.5" /> Portal link
                      </button>
                    )}
                    {t.status === "draft" && (
                      <>
                        <button onClick={() => openEdit(t)} title="Edit draft" className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] text-[13px] font-semibold border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
                          <Pencil className="w-3.5 h-3.5" /> Edit
                        </button>
                        <button onClick={() => doDelete(t)} disabled={busyId === t.id} title="Delete draft" aria-label="Delete draft" className="inline-flex items-center justify-center w-9 h-9 rounded-[10px] border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-rose-600 hover:border-rose-200 transition-colors">
                          {busyId === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      </>
                    )}
                    {t.status === "issued" && (
                      <>
                        <button onClick={() => doAcknowledge(t)} disabled={busyId === t.id} title="Record that they received it" className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] text-[13px] font-semibold border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition-colors">
                          {busyId === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Receipt
                        </button>
                        <button onClick={() => doVoid(t)} disabled={busyId === t.id} title="Void (issued in error)" aria-label="Void" className="inline-flex items-center justify-center w-9 h-9 rounded-[10px] border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-rose-600 hover:border-rose-200 transition-colors">
                          <Ban className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            </div>
          </Card>
        )}
      </PageBody>

      {composerOpen && (
        <TransmittalComposer
          orgId={activeOrgId ?? ""}
          editing={editing}
          preloadDoc={preloadDoc}
          actor={actor}
          onClose={() => { setComposerOpen(false); setEditing(null); setPreloadDoc(null); }}
          onSaved={async (issued, t) => {
            setComposerOpen(false); setEditing(null); setPreloadDoc(null);
            await refresh();
            // Straight to what was just saved: scrolled to and outlined.
            if (t?.id) setHighlightId(t.id);
            if (issued && t) openTransmittalSheet(t);
            showToast({
              type: "success",
              title: issued ? "Transmittal issued" : "Draft saved",
              message: issued
                ? `${t?.number} issued - ${t?.recipientEmail?.trim() ? `portal link emailed to ${t.recipientEmail.trim()} and ` : ""}cover sheet opened.`
                : "Saved to the register.",
            });
          }}
          onError={(msg) => showToast({ type: "error", title: "Couldn't save", message: msg })}
        />
      )}
    </PageShell>
  );
}

// ─── Composer ───────────────────────────────────────────────────────────────

interface ComposerProps {
  orgId: string;
  editing: Transmittal | null;
  preloadDoc: TransmittalItem | null;
  actor: { orgId: string; actorUserId: string; actorName?: string; actorRole?: string };
  onClose: () => void;
  onSaved: (issued: boolean, t: Transmittal | null) => void | Promise<void>;
  onError: (msg: string) => void;
}

function TransmittalComposer({ orgId, editing, preloadDoc, actor, onClose, onSaved, onError }: ComposerProps) {
  const [subject, setSubject] = useState(editing?.subject ?? "");
  const [recipientName, setRecipientName] = useState(editing?.recipientName ?? "");
  const [recipientCompany, setRecipientCompany] = useState(editing?.recipientCompany ?? "");
  const [recipientEmail, setRecipientEmail] = useState(editing?.recipientEmail ?? "");
  // A new transmittal starts from the purpose used last time on this device.
  const [purpose, setPurpose] = useState<string>(() => {
    if (editing?.purpose) return editing.purpose;
    try {
      const last = typeof window !== "undefined" ? window.localStorage.getItem(`mfg.transmittal.purpose.${orgId}`) : null;
      if (last && (TRANSMITTAL_PURPOSES as readonly string[]).includes(last)) return last;
    } catch { /* private mode */ }
    return "For Review";
  });
  const [notes, setNotes] = useState(editing?.notes ?? "");
  // A new transmittal's notes are kept on this device until it's saved.
  useDraft<string>(editing ? null : `transmittal-new:${orgId}`, notes, setNotes, (v) => !v.trim());
  useEscapeClose(() => onClose());
  const [projectId, setProjectId] = useState<string>(editing?.projectId ?? "");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  // Known outside companies (intake links + cost parties) feed the
  // recipient-company suggestions so the same contractor isn't three
  // different free-typed strings across the system.
  const [companySuggestions, setCompanySuggestions] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [{ data: pj }, { data: links }, { data: parties }] = await Promise.all([
        supabase.from("projects").select("id, name").eq("org_id", orgId).in("status", ["active", "paused"]).order("name"),
        supabase.from("project_intake_links").select("company_name").eq("org_id", orgId).limit(200),
        supabase.from("project_parties").select("name").eq("org_id", orgId).limit(200),
      ]);
      if (!alive) return;
      setProjects(((pj ?? []) as Array<{ id: string; name: string }>));
      const names = new Set<string>();
      for (const r of ((links ?? []) as Array<{ company_name: string | null }>)) if (r.company_name) names.add(r.company_name);
      for (const r of ((parties ?? []) as Array<{ name: string | null }>)) if (r.name) names.add(r.name);
      setCompanySuggestions([...names].sort());
    })();
    return () => { alive = false; };
  }, [orgId]);
  const [items, setItems] = useState<TransmittalItem[]>(() => {
    const base = editing?.items ? [...editing.items] : [];
    if (preloadDoc && !base.some((i) => i.documentId === preloadDoc.documentId)) base.push(preloadDoc);
    return base;
  });
  const [saving, setSaving] = useState<null | "draft" | "issue">(null);

  // Document picker.
  const [pq, setPq] = useState("");
  const [hits, setHits] = useState<DocHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = pq.trim();
    if (q.length < 2) { setHits([]); return; }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      // Sanitize for the PostgREST .or() filter (commas/parens/wildcards are meta).
      const safe = q.replace(/[,()*%]/g, " ").trim();
      try {
        const { data } = await supabase
          .from("documents")
          .select("id, document_number, title, name, rev, current_version_id")
          .eq("org_id", orgId)
          .neq("status", "Archived")
          .or(`document_number.ilike.*${safe}*,title.ilike.*${safe}*,name.ilike.*${safe}*`)
          .limit(12);
        if (cancelled) return;
        setHits(((data ?? []) as Array<Record<string, unknown>>).map((d) => ({
          id: String(d.id),
          number: (d.document_number as string) || (d.title as string) || (d.name as string) || "-",
          title: (d.title as string) || "",
          rev: (d.rev as string) ?? null,
          versionId: (d.current_version_id as string) ?? null,
        })));
      } catch { if (!cancelled) setHits([]); /* a failed search just shows no matches; typing again retries */ }
      finally { if (!cancelled) setSearching(false); }
    }, 250);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [pq, orgId]);

  const addDoc = (h: DocHit) => {
    setItems((prev) => prev.some((i) => i.documentId === h.id) ? prev : [...prev, {
      documentId: h.id, number: h.number, title: h.title || null, rev: h.rev, versionId: h.versionId,
    }]);
    setPq(""); setHits([]);
  };
  const removeItem = (documentId: string) => setItems((prev) => prev.filter((i) => i.documentId !== documentId));

  const issuable = isTransmittalIssuable({ items, recipientName, recipientCompany });

  const save = async (issue: boolean) => {
    if (issue && !issuable) { onError("Add at least one document and a recipient before issuing."); return; }
    setSaving(issue ? "issue" : "draft");
    try { window.localStorage.setItem(`mfg.transmittal.purpose.${orgId}`, purpose); } catch { /* private mode */ }
    try {
      const fields = { subject, recipientName, recipientCompany, recipientEmail, purpose, notes, items, projectId: projectId || null };
      if (editing) {
        await updateTransmittalDraft(editing.id, fields);
        if (issue) await issueTransmittal(editing.id, actor);
        await onSaved(issue, issue ? { ...editing, ...fields, status: "issued", issuedAt: new Date().toISOString() } : { ...editing, ...fields });
      } else {
        const created = await createTransmittal({ orgId, ...fields, actorUserId: actor.actorUserId, actorName: actor.actorName, actorRole: actor.actorRole, issueNow: issue });
        setNotes("");
        await onSaved(issue, created);
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[color-mix(in_srgb,var(--color-ink)_58%,transparent)] animate-in fade-in p-0 sm:p-4" onClick={onClose}>
      <div className="bg-[var(--color-surface)] w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[92vh] flex flex-col animate-in fade-in zoom-in-95" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <h2 className="text-[15px] font-extrabold text-[var(--color-text)] flex items-center gap-2">
            <Send className="w-4 h-4 text-[var(--color-text-muted)]" /> {editing ? `Edit ${editing.number}` : "New transmittal"}
          </h2>
          <button aria-label="Close" onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-[var(--color-surface-2)] flex items-center justify-center text-[var(--color-text-faint)] transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Recipient + purpose */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Recipient name" icon={User}>
              <Input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder="Jane Doe" />
            </Field>
            <Field label="Company" icon={Building2}>
              <Input value={recipientCompany} onChange={(e) => setRecipientCompany(e.target.value)} placeholder="BuildCo" list="transmittal-companies" />
              <datalist id="transmittal-companies">
                {companySuggestions.map((c) => <option key={c} value={c} />)}
              </datalist>
            </Field>
            <Field label="Email (optional)" icon={Mail}>
              <Input value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} placeholder="jane@buildco.com" />
            </Field>
            <Field label="Purpose">
              <Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                {TRANSMITTAL_PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </Field>
          </div>

          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Issued for Construction - Area 200" />
          </Field>

          {projects.length > 0 && (
            <Field label="Project (ties this transmittal to the project record + evidence pack)">
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full h-9 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2.5 text-sm"
              >
                <option value="">No project</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
          )}

          {/* Document picker */}
          <div>
            <div className="text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5 flex items-center gap-1.5"><Package className="w-3.5 h-3.5" /> Documents ({items.length})</div>
            <div className="relative">
              <Search className="w-4 h-4 text-[var(--color-text-faint)] absolute left-3 top-1/2 -translate-y-1/2" />
              <Input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Search by number or title to add…" className="pl-9" />
              {searching && <Spinner size="sm" className="absolute right-3 top-1/2 -translate-y-1/2" />}
            </div>
            {hits.length > 0 && (
              <div className="mt-1.5 border border-[var(--color-border)] rounded-xl divide-y divide-[var(--color-border)] overflow-hidden shadow-sm max-h-52 overflow-y-auto">
                {hits.map((h) => {
                  const added = items.some((i) => i.documentId === h.id);
                  return (
                    <button key={h.id} onClick={() => addDoc(h)} disabled={added} className="w-full text-left px-3 py-2 hover:bg-[var(--color-surface-2)] transition-colors flex items-center gap-2 disabled:opacity-50">
                      <FileText className="w-3.5 h-3.5 text-[var(--color-text-faint)] shrink-0" />
                      <span className="font-mono text-xs font-bold text-[var(--color-text)]">{h.number}</span>
                      {h.rev && <span className="text-[11px] font-bold bg-[var(--color-surface-2)] text-[var(--color-text-muted)] px-1 rounded">R{h.rev}</span>}
                      {h.title && h.title !== h.number && <span className="text-xs text-[var(--color-text-muted)] truncate">{h.title}</span>}
                      <span className="ml-auto text-[11px] font-bold text-[var(--color-text)]">{added ? "Added" : "+ Add"}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {items.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {items.map((it) => (
                  <li key={it.documentId} className="flex items-center gap-2 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-3 py-2">
                    <DocHoverPreview documentId={it.documentId}>
                      <DocThumb documentId={it.documentId} width={28} />
                    </DocHoverPreview>
                    <span className="font-mono text-xs font-bold text-[var(--color-text)]">{it.number}</span>
                    {it.rev && <span className="text-[11px] font-bold bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] px-1 rounded">R{it.rev}</span>}
                    {it.title && it.title !== it.number && <span className="text-xs text-[var(--color-text-muted)] truncate">{it.title}</span>}
                    <button aria-label="Remove" onClick={() => removeItem(it.documentId)} className="ml-auto text-[var(--color-text-faint)] hover:text-rose-600 transition-colors"><X className="w-3.5 h-3.5" /></button>
                  </li>
                ))}
              </ul>
            )}
            {items.length === 0 && <div className="mt-2 text-[13px] text-[var(--color-text-muted)]">No documents yet. Search above to add them.</div>}
          </div>

          <Field label="Notes (optional)">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Anything the recipient should know…" className="resize-y" />
          </Field>
        </div>

        <div className="px-5 py-4 border-t border-[var(--color-border)] flex items-center justify-between gap-2">
          <span className="text-[13px] text-[var(--color-text-muted)]">{issuable ? "Ready to issue" : "Add a document and a recipient to issue"}</span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => save(false)} disabled={!!saving} loading={saving === "draft"}>
              Save draft
            </Button>
            <Button size="sm" onClick={() => save(true)} disabled={!!saving || !issuable} loading={saving === "issue"}>
              {saving !== "issue" && <Send className="w-3.5 h-3.5" />} Issue
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, icon: Icon, children }: { label: string; icon?: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] font-semibold text-[var(--color-text-muted)] mb-1 flex items-center gap-1.5">{Icon && <Icon className="w-3.5 h-3.5" />}{label}</span>
      {children}
    </label>
  );
}
