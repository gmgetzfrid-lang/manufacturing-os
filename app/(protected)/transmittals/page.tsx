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
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { useToast } from "@/components/providers/ToastProvider";
import { supabase } from "@/lib/supabase";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Field";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { appConfirm, appPrompt } from "@/components/providers/DialogProvider";
import AiDraftButton from "@/components/ai/AiDraftButton";
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";
import {
  listTransmittals, createTransmittal, updateTransmittalDraft, issueTransmittal,
  acknowledgeTransmittal, voidTransmittal, deleteTransmittal, openTransmittalSheet,
  transmittalStatusMeta, isTransmittalIssuable, TRANSMITTAL_PURPOSES,
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
  slate: "bg-slate-100 text-slate-700 border-slate-200",
  blue: "bg-blue-100 text-blue-800 border-blue-200",
  emerald: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rose: "bg-rose-100 text-rose-800 border-rose-200",
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

  const actor = useMemo(() => ({
    orgId: activeOrgId ?? "",
    actorUserId: uid ?? "",
    actorName: userEmail ?? undefined,
    actorRole: activeRole ?? undefined,
  }), [activeOrgId, uid, userEmail, activeRole]);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setLoading(true); setError(null);
    try {
      setList(await listTransmittals(activeOrgId));
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
            number: (data.document_number as string) || (data.title as string) || (data.name as string) || "—",
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
    return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>;
  }

  return (
    <PageShell width="work">
        <ViewTabs title="Documents" tabs={DOCUMENT_VIEWS} />
        <PageHeaderBar
          icon={Send}
          title="Transmittals"
          subtitle="The formal record of documents issued — numbered, with a printable cover sheet and tracked receipt."
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
              </Button>
              <Button size="sm" onClick={openNew}>
                <Plus className="w-4 h-4" /> New transmittal
              </Button>
            </>
          }
        />

        {error && (
          <div className={`mb-4 rounded-xl border p-3 text-xs flex items-start gap-2 ${needsMigration ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-800"}`}>
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-bold">{needsMigration ? "One quick migration needed" : "Couldn't load transmittals"}</div>
              <div className="mt-0.5">{error}</div>
            </div>
          </div>
        )}

        {!error && (list?.length ?? 0) === 0 ? (
          <EmptyState
            icon={Send}
            title="No transmittals yet"
            description="Issue a set of documents to a recipient with a tracked cover sheet. Every transmittal gets a number and lands here."
            action={
              <Button onClick={openNew}>
                <Plus className="w-4 h-4" /> New transmittal
              </Button>
            }
          />
        ) : (
          <div className="space-y-2">
            {(list ?? []).map((t) => {
              const meta = transmittalStatusMeta(t.status);
              return (
                <div key={t.id} className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4 flex flex-wrap items-start gap-x-4 gap-y-2">
                  <div className="flex-1 min-w-[200px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm font-black text-slate-900">{t.number}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${TONE_CHIP[meta.tone]}`}>{meta.label}</span>
                      {t.purpose && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-100">{t.purpose}</span>}
                    </div>
                    <div className="text-sm font-bold text-slate-800 mt-1">{t.subject || "Document Transmittal"}</div>
                    <div className="text-xs text-slate-500 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      {(t.recipientName || t.recipientCompany) && (
                        <span className="inline-flex items-center gap-1"><User className="w-3 h-3" />{[t.recipientName, t.recipientCompany].filter(Boolean).join(" · ")}</span>
                      )}
                      <span className="inline-flex items-center gap-1"><Package className="w-3 h-3" />{t.items.length} doc{t.items.length === 1 ? "" : "s"}</span>
                      {t.issuedAt && <span>Issued {new Date(t.issuedAt).toLocaleDateString()}</span>}
                      {t.status === "acknowledged" && t.acknowledgedAt && <span className="text-emerald-700">Ack&apos;d {new Date(t.acknowledgedAt).toLocaleDateString()}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => openTransmittalSheet(t)} title="Open the printable cover sheet" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border bg-white border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors">
                      <Printer className="w-3.5 h-3.5" /> Cover sheet
                    </button>
                    {t.status === "draft" && (
                      <>
                        <button onClick={() => openEdit(t)} title="Edit draft" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border bg-white border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors">
                          <Pencil className="w-3.5 h-3.5" /> Edit
                        </button>
                        <button onClick={() => doDelete(t)} disabled={busyId === t.id} title="Delete draft" className="inline-flex items-center justify-center w-8 h-8 rounded-lg border bg-white border-slate-200 text-slate-400 hover:text-rose-600 hover:border-rose-200 transition-colors">
                          {busyId === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      </>
                    )}
                    {t.status === "issued" && (
                      <>
                        <button onClick={() => doAcknowledge(t)} disabled={busyId === t.id} title="Record recipient receipt" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-500 transition-colors">
                          {busyId === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Receipt
                        </button>
                        <button onClick={() => doVoid(t)} disabled={busyId === t.id} title="Void — issued in error" className="inline-flex items-center justify-center w-8 h-8 rounded-lg border bg-white border-slate-200 text-slate-400 hover:text-rose-600 hover:border-rose-200 transition-colors">
                          <Ban className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

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
            if (issued && t) openTransmittalSheet(t);
            showToast({ type: "success", title: issued ? "Transmittal issued" : "Draft saved", message: issued ? `${t?.number} issued — cover sheet opened.` : "Saved to the register." });
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
  const [purpose, setPurpose] = useState<string>(editing?.purpose ?? "For Review");
  const [notes, setNotes] = useState(editing?.notes ?? "");
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
          number: (d.document_number as string) || (d.title as string) || (d.name as string) || "—",
          title: (d.title as string) || "",
          rev: (d.rev as string) ?? null,
          versionId: (d.current_version_id as string) ?? null,
        })));
      } catch { if (!cancelled) setHits([]); }
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
    try {
      const fields = { subject, recipientName, recipientCompany, recipientEmail, purpose, notes, items };
      if (editing) {
        await updateTransmittalDraft(editing.id, fields);
        if (issue) await issueTransmittal(editing.id, actor);
        await onSaved(issue, issue ? { ...editing, ...fields, status: "issued", issuedAt: new Date().toISOString() } : { ...editing, ...fields });
      } else {
        const created = await createTransmittal({ orgId, ...fields, actorUserId: actor.actorUserId, actorName: actor.actorName, actorRole: actor.actorRole, issueNow: issue });
        await onSaved(issue, created);
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 backdrop-blur-sm animate-in fade-in p-0 sm:p-4" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[92vh] flex flex-col animate-in fade-in zoom-in-95" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-base font-black text-slate-900 flex items-center gap-2">
            <Send className="w-5 h-5 text-orange-500" /> {editing ? `Edit ${editing.number}` : "New transmittal"}
          </h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center text-slate-400 transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Recipient + purpose */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Recipient name" icon={User}>
              <Input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder="Jane Doe" />
            </Field>
            <Field label="Company" icon={Building2}>
              <Input value={recipientCompany} onChange={(e) => setRecipientCompany(e.target.value)} placeholder="BuildCo" />
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
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Issued for Construction — Area 200" />
          </Field>

          {/* Document picker */}
          <div>
            <div className="text-xs font-bold text-slate-600 mb-1.5 flex items-center gap-1.5"><Package className="w-3.5 h-3.5" /> Documents ({items.length})</div>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <Input value={pq} onChange={(e) => setPq(e.target.value)} placeholder="Search by number or title to add…" className="pl-9" />
              {searching && <Spinner size="sm" className="absolute right-3 top-1/2 -translate-y-1/2" />}
            </div>
            {hits.length > 0 && (
              <div className="mt-1.5 border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden shadow-sm max-h-52 overflow-y-auto">
                {hits.map((h) => {
                  const added = items.some((i) => i.documentId === h.id);
                  return (
                    <button key={h.id} onClick={() => addDoc(h)} disabled={added} className="w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors flex items-center gap-2 disabled:opacity-50">
                      <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="font-mono text-xs font-bold text-slate-800">{h.number}</span>
                      {h.rev && <span className="text-[9px] font-bold bg-slate-100 text-slate-600 px-1 rounded">R{h.rev}</span>}
                      {h.title && h.title !== h.number && <span className="text-xs text-slate-500 truncate">{h.title}</span>}
                      <span className="ml-auto text-[10px] font-bold text-orange-600">{added ? "Added" : "+ Add"}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {items.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {items.map((it) => (
                  <li key={it.documentId} className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    <DocHoverPreview documentId={it.documentId}>
                      <DocThumb documentId={it.documentId} width={28} />
                    </DocHoverPreview>
                    <span className="font-mono text-xs font-bold text-slate-800">{it.number}</span>
                    {it.rev && <span className="text-[9px] font-bold bg-white border border-slate-200 text-slate-600 px-1 rounded">R{it.rev}</span>}
                    {it.title && it.title !== it.number && <span className="text-xs text-slate-500 truncate">{it.title}</span>}
                    <button onClick={() => removeItem(it.documentId)} className="ml-auto text-slate-400 hover:text-rose-600 transition-colors"><X className="w-3.5 h-3.5" /></button>
                  </li>
                ))}
              </ul>
            )}
            {items.length === 0 && <div className="mt-2 text-xs text-slate-400 italic">No documents yet — search above to add the drawings/specs you&apos;re issuing.</div>}
          </div>

          <Field label="Notes (optional)">
            <div className="flex items-center justify-end mb-1.5">
              <AiDraftButton
                label="Draft cover note"
                mode="handoff"
                buildContext={() => {
                  const docLines = items.map((it) => `- ${it.number ?? ""} ${it.title ?? ""} (Rev ${it.rev ?? "—"})`).join("\n");
                  return [
                    `Draft a brief, professional transmittal cover note.`,
                    `Purpose: ${purpose}.`,
                    recipientName || recipientCompany ? `Recipient: ${[recipientName, recipientCompany].filter(Boolean).join(", ")}.` : "",
                    subject ? `Subject: ${subject}.` : "",
                    items.length ? `Documents being issued:\n${docLines}` : "",
                  ].filter(Boolean).join("\n");
                }}
                onUse={(text) => setNotes(text)}
              />
            </div>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Anything the recipient should know…" className="resize-y" />
          </Field>
        </div>

        <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-between gap-2">
          <span className="text-[11px] text-slate-400">{issuable ? "Ready to issue" : "Add a document + recipient to issue"}</span>
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
      <span className="text-xs font-bold text-slate-600 mb-1 flex items-center gap-1.5">{Icon && <Icon className="w-3.5 h-3.5" />}{label}</span>
      {children}
    </label>
  );
}
