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
//
// Authority (TRX-1 / TRX-7, decided by the database — this page only draws
// what the person could actually do): every member may DRAFT; issuing,
// voiding, revoking the portal link and recording a receipt are the
// `transmittal.issue` capability's, read from the capability policy per item
// library (DEC-13) — never a role list on the page (DEC-35). Editing a draft
// is its author's, a Document Controller's or a transmit authority's;
// deleting one is what BOTH delete policies admit together — its author, or
// a Document Controller who is also an Admin / Manager or manages the
// draft's project (the permissive 20261133 policy AND the RESTRICTIVE
// 20260818 transmittals_delete_guard).

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Send, Loader2, RefreshCw, AlertTriangle, Plus, Search, X, FileText,
  Printer, CheckCircle2, Trash2, Ban, Pencil, Package, Building2, Mail, User,
  Link as LinkIcon, Unlink, Lock,
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
import ViewTabs, { DOCUMENT_VIEWS } from "@/components/navigation/ViewTabs";
import DocThumb from "@/components/documents/DocThumb";
import DocHoverPreview from "@/components/documents/DocHoverPreview";
import {
  listTransmittals, createTransmittal, updateTransmittalDraft, issueTransmittal,
  acknowledgeTransmittal, voidTransmittal, deleteTransmittal, openTransmittalSheet,
  revokeTransmittalLink, transmittalStatusMeta, isTransmittalIssuable, TRANSMITTAL_PURPOSES,
  transmittalPortalUrl, portalOriginConfigured, portalLinkAvailable, portalLinkState, mayTransmit, mayDeleteDraft, itemIssueBlocker,
  legalHoldNotice, PORTAL_LINK_DAYS, UnstampableItemsError,
  type Transmittal, type TransmittalItem, type IssueFacts, type IssueOutcome, type IssuePhase,
} from "@/lib/transmittals";
import { loadCapabilityPolicy, type CapabilityPolicy } from "@/lib/capabilityPolicy";
import { isControllerPrincipal } from "@/lib/permissions";
import { NOT_CURRENT_STATUSES } from "@/lib/aiBoundary";
import type { Role } from "@/types/schema";

/** The picker's PostgREST filter for the shared not-current set (TRX-3) —
 *  built from NOT_CURRENT_STATUSES, never an inline list. */
const NOT_CURRENT_FILTER = `(${[...NOT_CURRENT_STATUSES].join(",")})`;

interface Principal { role: string | null; roles: string[]; uid: string | null }

interface DocHit {
  id: string;
  number: string;
  title: string;
  rev: string | null;
  versionId: string | null;
}

/** TRX-14: what the issuer does when THIS browser cannot build the portal
 *  link (a Vercel deployment host or loopback with nothing configured). */
const NO_PORTAL_LINK_ADVICE = "set NEXT_PUBLIC_SITE_URL to the public site address and rebuild, then copy the portal link from this register";

/** TRX-10: the issue toast says what actually happened — the email's real
 *  outcome, a missing portal, an unconfigured public origin, an audit gap. */
function issueToast(outcome: IssueOutcome): { type: "success" | "warning"; title: string; message: string } {
  const t = outcome.transmittal;
  const notes: string[] = [];
  const linkHere = portalLinkAvailable();
  if (outcome.portal === "missing") notes.push("issued WITHOUT a recipient portal — this database predates 20260910, so no link exists");
  else if (outcome.email.sent) notes.push(`portal link emailed to ${t.recipientEmail?.trim()}`);
  else if (t.recipientEmail?.trim()) notes.push(`the email was NOT sent (${outcome.email.reason ?? "unknown reason"}) — ${linkHere ? "copy the portal link instead" : NO_PORTAL_LINK_ADVICE}`);
  else notes.push(`no recipient email — ${linkHere ? "copy the portal link to send it" : NO_PORTAL_LINK_ADVICE}`);
  if (outcome.portal === "ready" && !linkHere) {
    notes.push("this browser cannot build the portal link (NEXT_PUBLIC_SITE_URL unset) — the cover sheet carries none");
  } else if (outcome.portal === "ready" && !portalOriginConfigured()) {
    notes.push("NEXT_PUBLIC_SITE_URL is not set, so the copied link and the cover sheet use this browser's address — check it opens from outside before sending");
  }
  if (outcome.auditError) notes.push(`the audit record could not be written (${outcome.auditError})`);
  const clean = outcome.portal === "ready" && (outcome.email.sent || !t.recipientEmail?.trim()) && portalOriginConfigured() && !outcome.auditError;
  return { type: clean ? "success" : "warning", title: "Transmittal issued", message: `${t.number} issued — ${notes.join("; ")}. Cover sheet opened.` };
}

const TONE_CHIP: Record<string, string> = {
  slate: "bg-[var(--color-surface-2)] text-[var(--color-text)] border-[var(--color-border)]",
  blue: "bg-blue-100 text-blue-800 border-blue-200",
  emerald: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rose: "bg-rose-100 text-rose-800 border-rose-200",
};

export default function TransmittalsPage() {
  const { activeOrgId, uid, userEmail, activeRole, roles } = useRole();
  const { showToast } = useToast();
  const [list, setList] = useState<Transmittal[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editing, setEditing] = useState<Transmittal | null>(null);
  const [preloadDoc, setPreloadDoc] = useState<TransmittalItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // TRX-1: the capability policy (null until read) and each live item's
  // library — the resource the capability is evaluated against (DEC-13).
  const [policy, setPolicy] = useState<CapabilityPolicy | null>(null);
  const [libOf, setLibOf] = useState<Map<string, string | null>>(new Map());
  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    void loadCapabilityPolicy(activeOrgId).then((p) => { if (alive) setPolicy(p); }).catch(() => { if (alive) setPolicy({}); });
    return () => { alive = false; };
  }, [activeOrgId]);
  const principal = useMemo<Principal>(() => ({ role: activeRole ?? null, roles: (roles ?? []) as string[], uid: uid ?? null }), [activeRole, roles, uid]);
  const isController = useMemo(() => isControllerPrincipal({ role: (activeRole ?? "Viewer") as Role, roles: (roles ?? []) as Role[] }), [activeRole, roles]);
  const canTransmit = useCallback((t: Transmittal) =>
    policy !== null && mayTransmit(policy, principal, t.items.map((i) => libOf.get(i.documentId) ?? null)), [policy, principal, libOf]);
  const canEditDraft = (t: Transmittal) => isController || (!!uid && t.createdBy === uid) || (policy !== null && mayTransmit(policy, principal, []));
  // TRX-7: Delete is drawn from the COMBINED rule (mayDeleteDraft): the
  // permissive policy admits the author or a controller; the RESTRICTIVE
  // transmittals_delete_guard (20260818, unchanged) also requires an Admin /
  // Manager, the author, or someone who manages the draft's project — so a
  // controller's project arm needs the projects they manage (owner, or an
  // owner / collaborator on the roster).
  const [managedProjects, setManagedProjects] = useState<Set<string>>(new Set());
  useEffect(() => {
    setManagedProjects(new Set());
    if (!activeOrgId || !uid || !isController) return;
    let alive = true;
    void (async () => {
      const [owned, rostered] = await Promise.all([
        supabase.from("projects").select("id").eq("org_id", activeOrgId).eq("owner_user_id", uid),
        supabase.from("project_members").select("project_id, role").eq("user_id", uid),
      ]);
      if (!alive) return;
      const ids = new Set<string>();
      for (const p of ((owned.data ?? []) as Array<{ id: string }>)) ids.add(String(p.id));
      for (const m of ((rostered.data ?? []) as Array<{ project_id: string; role: string | null }>)) {
        const r = m.role ?? "collaborator";
        if (r === "owner" || r === "collaborator") ids.add(String(m.project_id));
      }
      setManagedProjects(ids);
    })().catch(() => { /* unreadable: the project arm stays closed; the other arms still decide */ });
    return () => { alive = false; };
  }, [activeOrgId, uid, isController]);
  const canDeleteDraft = (t: Transmittal) => mayDeleteDraft(t, principal, managedProjects);

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
        const { data } = await supabase.from("documents").select("id, rev, library_id").in("id", docIds);
        const docs = ((data ?? []) as Array<{ id: string; rev: string | null; library_id: string | null }>);
        const revOf = new Map(docs.map((d) => [d.id, d.rev]));
        setLibOf(new Map(docs.map((d) => [d.id, d.library_id ?? null])));
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
          .select("id, document_number, title, name, rev, current_version_id, status, archived_at")
          .eq("id", docId)
          .maybeSingle();
        // TRX-3: a withdrawn document is never pre-loaded onto a transmittal.
        const withdrawn = !!data && (!!data.archived_at || NOT_CURRENT_STATUSES.has(String(data.status ?? "")));
        if (withdrawn) {
          showToast({ type: "warning", title: "Not transmittable", message: `${(data!.document_number as string) || "That document"} is withdrawn (${String(data!.archived_at ? "archived" : data!.status).toLowerCase()}) and cannot be issued on a transmittal.` });
        }
        if (data && !withdrawn) {
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
  }, [activeOrgId, showToast]);

  const openNew = () => { setEditing(null); setPreloadDoc(null); setComposerOpen(true); };
  const openEdit = (t: Transmittal) => { setEditing(t); setPreloadDoc(null); setComposerOpen(true); };

  const doAcknowledge = async (t: Transmittal) => {
    const name = await appPrompt({ message: "Who acknowledged receipt? (name)", defaultValue: t.recipientName || "" });
    if (name === null) return;
    setBusyId(t.id);
    try {
      await acknowledgeTransmittal(t.id, name, actor);
      showToast({ type: "success", title: "Receipt recorded", message: `${t.number} marked acknowledged — recorded on the register in your name.` });
      await refresh();
    } catch (e) {
      showToast({ type: "error", title: "Couldn't record receipt", message: (e as Error).message });
    } finally { setBusyId(null); }
  };

  const doVoid = async (t: Transmittal) => {
    if (!(await appConfirm({
      title: `Void ${t.number}?`,
      message: "It stays on the register as a voided record (it was issued, so it can't be deleted). Voiding says it was issued in error — to cut off the recipient's access without that, revoke the portal link instead.",
      tone: "danger",
    }))) return;
    setBusyId(t.id);
    try {
      const { auditError } = await voidTransmittal(t.id, actor);
      showToast(auditError
        ? { type: "warning", title: "Transmittal voided", message: `${t.number} marked voided — but the audit record could not be written (${auditError}).` }
        : { type: "success", title: "Transmittal voided", message: `${t.number} marked voided.` });
      await refresh();
    } catch (e) {
      showToast({ type: "error", title: "Couldn't void", message: (e as Error).message });
    } finally { setBusyId(null); }
  };

  // TRX-4: cut the portal link WITHOUT repudiating the record.
  const doRevoke = async (t: Transmittal) => {
    if (!(await appConfirm({
      title: `Revoke the portal link for ${t.number}?`,
      message: "The recipient's link stops working at once. The transmittal stays on the register as issued — revoking access is not voiding the issue. A revoked link cannot be restored; issue a new transmittal to send again.",
      tone: "danger",
      confirmLabel: "Revoke link",
    }))) return;
    setBusyId(t.id);
    try {
      const { auditError } = await revokeTransmittalLink(t.id, actor);
      showToast(auditError
        ? { type: "warning", title: "Portal link revoked", message: `${t.number}'s link no longer works — but the audit record could not be written (${auditError}).` }
        : { type: "success", title: "Portal link revoked", message: `${t.number}'s link no longer works. The transmittal stays issued.` });
      await refresh();
    } catch (e) {
      showToast({ type: "error", title: "Couldn't revoke the link", message: (e as Error).message });
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
    return <div className="min-h-full flex items-center justify-center"><Spinner /></div>;
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
              const link = portalLinkState(t);
              const transmitter = canTransmit(t);
              return (
                <div key={t.id} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm p-4 flex flex-wrap items-start gap-x-4 gap-y-2">
                  <div className="flex-1 min-w-[200px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm font-black text-[var(--color-text)]">{t.number}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${TONE_CHIP[meta.tone]}`}>{meta.label}</span>
                      {t.purpose && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-100">{t.purpose}</span>}
                      {staleIds.has(t.id) && (
                        <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200" title="At least one transmitted document has revved since — the recipient holds a superseded revision. Consider issuing a superseding transmittal.">
                          superseded rev in circulation
                        </span>
                      )}
                      {/* TRX-4: the portal link's own state, separate from the record's. */}
                      {link === "revoked" && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border border-[var(--color-border)]" title={t.portalRevokedAt ? `Revoked ${new Date(t.portalRevokedAt).toLocaleString()}` : undefined}>portal link revoked</span>
                      )}
                      {link === "expired" && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[var(--color-surface-2)] text-[var(--color-text-muted)] border border-[var(--color-border)]">portal link expired</span>
                      )}
                    </div>
                    <div className="text-sm font-bold text-[var(--color-text)] mt-1">{t.subject || "Document Transmittal"}</div>
                    <div className="text-xs text-[var(--color-text-muted)] mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      {(t.recipientName || t.recipientCompany) && (
                        <span className="inline-flex items-center gap-1"><User className="w-3 h-3" />{[t.recipientName, t.recipientCompany].filter(Boolean).join(" · ")}</span>
                      )}
                      <span className="inline-flex items-center gap-1"><Package className="w-3 h-3" />{t.items.length} doc{t.items.length === 1 ? "" : "s"}</span>
                      {t.issuedAt && <span>Issued {new Date(t.issuedAt).toLocaleDateString()}</span>}
                      {link === "live" && t.portalExpiresAt && <span title="The recipient's portal link stops working on this date">Link until {new Date(t.portalExpiresAt).toLocaleDateString()}</span>}
                      {/* TRX-4 dw4: did the recipient ever collect the documents? */}
                      {t.portalToken && t.status !== "draft" && t.portalOpenCount != null && (
                        <span title={t.portalLastUsedAt ? `Last portal activity ${new Date(t.portalLastUsedAt).toLocaleString()}` : "The portal has recorded no activity"}>
                          {(t.portalOpenCount ?? 0) === 0 && (t.portalDownloadCount ?? 0) === 0
                            ? "Portal not opened yet"
                            : `Portal opened ${t.portalOpenCount ?? 0}× · ${t.portalDownloadCount ?? 0} download${(t.portalDownloadCount ?? 0) === 1 ? "" : "s"}`}
                        </span>
                      )}
                      {t.status === "acknowledged" && t.acknowledgedAt && <span className="text-emerald-700">Ack&apos;d {new Date(t.acknowledgedAt).toLocaleDateString()}{t.acknowledgedByName ? ` by ${t.acknowledgedByName}` : ""}{t.acknowledgedVia === "portal" ? ` · via portal (their side)${t.acknowledgedMeta?.ip ? ` from ${t.acknowledgedMeta.ip}` : ""}` : t.acknowledgedVia === "manual" ? ` · recorded internally${t.acknowledgedMeta?.recordedByEmail ? ` by ${t.acknowledgedMeta.recordedByEmail}` : ""}` : ""}</span>}
                      {/* TRX-13 dw3: the recipient's own note, visible in the app. */}
                      {t.status !== "draft" && t.acknowledgedMeta?.note && <span className="text-emerald-700 italic" title="Note recorded with the receipt">“{t.acknowledgedMeta.note}”</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    <button onClick={() => openTransmittalSheet(t)} title="Open the printable cover sheet" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors">
                      <Printer className="w-3.5 h-3.5" /> Cover sheet
                    </button>
                    {link === "live" && (transmitter || (!!uid && t.createdBy === uid)) && (
                      <button
                        disabled={!portalLinkAvailable()}
                        onClick={() => {
                          const url = transmittalPortalUrl(t.portalToken!);
                          if (!url) { showToast({ type: "error", title: "No portal link", message: "This browser cannot build the portal link (NEXT_PUBLIC_SITE_URL unset)." }); return; }
                          void navigator.clipboard.writeText(url);
                          showToast({
                            type: portalOriginConfigured() ? "success" : "warning",
                            title: "Portal link copied",
                            message: `Send it to ${t.recipientName || t.recipientCompany || "the recipient"} — they can download the files and acknowledge receipt themselves.${portalOriginConfigured() ? "" : " NEXT_PUBLIC_SITE_URL is not set, so the link uses this browser's address — check it opens from outside before sending."}`,
                          });
                        }}
                        title={portalLinkAvailable()
                          ? "Copy the recipient's secure portal link — no account needed on their side"
                          : "No portal link: this browser cannot build one (NEXT_PUBLIC_SITE_URL unset) — set it and rebuild"}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border bg-[var(--color-accent-soft)] border-[var(--color-accent-ring)]/40 text-[var(--color-accent)] hover:brightness-95 transition-[filter] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
                      >
                        <LinkIcon className="w-3.5 h-3.5" /> Portal link
                      </button>
                    )}
                    {t.status === "draft" && (
                      <>
                        {canEditDraft(t) && (
                          <button onClick={() => openEdit(t)} title="Edit draft" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] transition-colors">
                            <Pencil className="w-3.5 h-3.5" /> Edit
                          </button>
                        )}
                        {canDeleteDraft(t) && (
                          <button onClick={() => doDelete(t)} disabled={busyId === t.id} title="Delete draft" className="inline-flex items-center justify-center w-8 h-8 rounded-lg border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-rose-600 hover:border-rose-200 transition-colors">
                            {busyId === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </>
                    )}
                    {/* TRX-1 / TRX-7: receipt, revoke and void are transmit authority's — shown only to who can do them. */}
                    {t.status === "issued" && transmitter && (
                      <button onClick={() => doAcknowledge(t)} disabled={busyId === t.id} title="Record recipient receipt on their behalf (recorded in your name)" className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold border bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-500 transition-colors">
                        {busyId === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} Receipt
                      </button>
                    )}
                    {link === "live" && transmitter && (
                      <button onClick={() => doRevoke(t)} disabled={busyId === t.id} title="Revoke the portal link — cuts the recipient's access; the transmittal stays issued" className="inline-flex items-center justify-center w-8 h-8 rounded-lg border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-amber-600 hover:border-amber-200 transition-colors">
                        <Unlink className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {(t.status === "issued" || t.status === "acknowledged") && transmitter && (
                      <button onClick={() => doVoid(t)} disabled={busyId === t.id} title="Void — issued in error" className="inline-flex items-center justify-center w-8 h-8 rounded-lg border bg-[var(--color-surface)] border-[var(--color-border)] text-[var(--color-text-faint)] hover:text-rose-600 hover:border-rose-200 transition-colors">
                        <Ban className="w-3.5 h-3.5" />
                      </button>
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
          policy={policy}
          principal={principal}
          onClose={() => { setComposerOpen(false); setEditing(null); setPreloadDoc(null); }}
          onSaved={async (result) => {
            setComposerOpen(false); setEditing(null); setPreloadDoc(null);
            await refresh();
            if (result.kind === "issued") {
              // TRX-10: the sheet is printed from the row the database wrote —
              // portal token, as-sent snapshot and all.
              void openTransmittalSheet(result.outcome.transmittal);
              showToast(issueToast(result.outcome));
            } else if (result.kind === "issue-failed") {
              showToast({ type: "error", title: "Saved as a draft — not issued", message: `${result.draft.number}: ${result.error}` });
            } else {
              showToast({ type: "success", title: "Draft saved", message: "Saved to the register." });
            }
          }}
          onError={(msg) => showToast({ type: "error", title: "Couldn't save", message: msg })}
        />
      )}
    </PageShell>
  );
}

// ─── Composer ───────────────────────────────────────────────────────────────

type ComposerResult =
  | { kind: "draft"; draft: Transmittal | null }
  | { kind: "issued"; outcome: IssueOutcome }
  | { kind: "issue-failed"; draft: Transmittal; error: string };

interface ComposerProps {
  orgId: string;
  editing: Transmittal | null;
  preloadDoc: TransmittalItem | null;
  actor: { orgId: string; actorUserId: string; actorName?: string; actorRole?: string };
  policy: CapabilityPolicy | null;
  principal: Principal;
  onClose: () => void;
  onSaved: (result: ComposerResult) => void | Promise<void>;
  onError: (msg: string) => void;
}

function TransmittalComposer({ orgId, editing, preloadDoc, actor, policy, principal, onClose, onSaved, onError }: ComposerProps) {
  const [subject, setSubject] = useState(editing?.subject ?? "");
  const [recipientName, setRecipientName] = useState(editing?.recipientName ?? "");
  const [recipientCompany, setRecipientCompany] = useState(editing?.recipientCompany ?? "");
  const [recipientEmail, setRecipientEmail] = useState(editing?.recipientEmail ?? "");
  const [purpose, setPurpose] = useState<string>(editing?.purpose ?? "For Review");
  const [notes, setNotes] = useState(editing?.notes ?? "");
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
  // TRX-16 (P15 review fix): what the issue is doing, said in the footer.
  const [issuePhase, setIssuePhase] = useState<IssuePhase | null>(null);

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
        // TRX-3: the picker offers only CURRENT documents — never one in the
        // shared not-current set (Superseded / Void / Archived) or archived.
        const { data } = await supabase
          .from("documents")
          .select("id, document_number, title, name, rev, current_version_id")
          .eq("org_id", orgId)
          .not("status", "in", NOT_CURRENT_FILTER)
          .is("archived_at", null)
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

  // TRX-3 / TRX-1: what the composer knows about each item's document — its
  // status, holds (fail closed: an unreadable hold set blocks), legal hold and
  // library (the resource transmit authority is evaluated against). The
  // database re-checks all of it at the issue transition (20261133).
  const [facts, setFacts] = useState<Map<string, IssueFacts & { libraryId?: string | null }> | null>(null);
  const itemKey = items.map((i) => i.documentId).join(",");
  useEffect(() => {
    let alive = true;
    const ids = itemKey ? itemKey.split(",") : [];
    if (ids.length === 0) { setFacts(new Map()); return; }
    setFacts(null);
    (async () => {
      const [docsRes, holdsRes] = await Promise.all([
        supabase.from("documents").select("id, status, archived_at, current_version_id, legal_hold, library_id, rev").eq("org_id", orgId).in("id", ids),
        supabase.from("document_holds").select("document_id, reason").in("document_id", ids).is("released_at", null),
      ]);
      if (!alive) return;
      const docs = (docsRes.data as Array<Record<string, unknown>> | null) ?? [];
      const holdRows = (holdsRes.data as Array<Record<string, unknown>> | null) ?? [];
      // Status truth: the label of each document's CURRENT file, so a pin to
      // a superseded revision, or a Rev field that drifted from the file, is
      // named here instead of refused by the database at issue. Unreadable =
      // unknown (the database still decides).
      const currentIds = [...new Set(docs.map((d) => d.current_version_id as string | null).filter((v): v is string => !!v))];
      const labelOf = new Map<string, string | null>();
      if (currentIds.length > 0) {
        const versRes = await supabase.from("document_versions").select("id, revision_label").eq("org_id", orgId).in("id", currentIds);
        if (!alive) return;
        if (!versRes.error) for (const v of ((versRes.data ?? []) as Array<Record<string, unknown>>)) labelOf.set(String(v.id), (v.revision_label as string | null) ?? null);
      }
      const out = new Map<string, IssueFacts & { libraryId?: string | null }>();
      for (const id of ids) {
        const d = docs.find((x) => String(x.id) === id);
        if (!d || docsRes.error) { out.set(id, { found: false }); continue; }
        out.set(id, {
          found: true,
          status: (d.status as string) ?? null,
          archivedAt: (d.archived_at as string) ?? null,
          currentVersionId: (d.current_version_id as string) ?? null,
          rev: (d.rev as string) ?? null,
          currentRevisionLabel: d.current_version_id && labelOf.has(String(d.current_version_id)) ? labelOf.get(String(d.current_version_id)) : undefined,
          legalHold: !!d.legal_hold,
          libraryId: (d.library_id as string) ?? null,
          holds: holdsRes.error ? null : holdRows.filter((h) => String(h.document_id) === id).map((h) => String(h.reason ?? "hold")),
        });
      }
      setFacts(out);
    })().catch(() => { if (alive) setFacts(new Map(ids.map((id) => [id, { found: false }]))); });
    return () => { alive = false; };
  }, [itemKey, orgId]);

  const basicsReady = isTransmittalIssuable({ items, recipientName, recipientCompany });
  const issuable = !!facts && isTransmittalIssuable({ items, recipientName, recipientCompany }, facts);
  const canIssue = policy !== null && mayTransmit(policy, principal, items.map((i) => facts?.get(i.documentId)?.libraryId ?? null));
  const blockers = facts ? items.map((i) => ({ id: i.documentId, why: itemIssueBlocker(i, facts.get(i.documentId)) })).filter((b) => b.why) : [];
  const footerHint = saving === "issue" && issuePhase === "checking"
    ? "Checking each file the recipient's portal will stamp — large PDFs take a moment…"
    : saving === "issue" && issuePhase === "issuing" ? "Issuing…"
    : !basicsReady ? "Add a document + recipient to issue"
    : !facts ? "Checking the documents…"
    : blockers.length > 0 ? blockers[0].why!
    : !canIssue ? "Saving a draft is open to everyone; issuing needs transmit authority (the \"Issue transmittals\" capability) — a Document Controller can issue your draft."
    : `Ready to issue — the recipient's portal link will work for ${PORTAL_LINK_DAYS} days`;

  const save = async (issue: boolean) => {
    if (issue && !issuable) { onError(blockers[0]?.why ?? "Add at least one document and a recipient before issuing."); return; }
    if (issue && !canIssue) { onError("You do not hold transmit authority for these documents — save the draft and ask a Document Controller to issue it."); return; }
    if (issue && facts) {
      // TRX-3 dw2: a legal hold does not block — it asks for a deliberate yes.
      const notice = legalHoldNotice(items, facts);
      if (notice && !(await appConfirm({ title: "Documents under a legal hold", message: notice, confirmLabel: "Issue anyway" }))) return;
    }
    setSaving(issue ? "issue" : "draft");
    let draft: Transmittal | null = null;
    try {
      const fields = { subject, recipientName, recipientCompany, recipientEmail, purpose, notes, items, projectId: projectId || null };
      if (editing) {
        await updateTransmittalDraft(editing.id, fields);
        draft = { ...editing, ...fields };
      } else {
        draft = await createTransmittal({ orgId, ...fields, actorUserId: actor.actorUserId, actorName: actor.actorName, actorRole: actor.actorRole });
      }
    } catch (e) {
      onError((e as Error).message);
      setSaving(null);
      return;
    }
    if (!issue) {
      setSaving(null);
      await onSaved({ kind: "draft", draft });
      return;
    }
    try {
      // TRX-10: the outcome carries the row the database wrote.
      let outcome: IssueOutcome;
      try {
        outcome = await issueTransmittal(draft.id, actor, { onPhase: setIssuePhase });
      } catch (e) {
        if (!(e instanceof UnstampableItemsError)) throw e;
        setIssuePhase(null); // the check answered; the issuer decides
        // TRX-16: warned at issue, before anything was sent — the issuer
        // fixes the file(s) or issues anyway (DEC-61 §5: released unmarked,
        // recorded so; the acceptance goes on the TRANSMITTAL_ISSUED row).
        if (!(await appConfirm({ title: "Files the portal cannot mark", message: <span className="whitespace-pre-line">{e.message}</span>, confirmLabel: "Issue anyway" }))) {
          await onSaved({ kind: "issue-failed", draft, error: "Not issued — fix the file(s) the portal cannot mark, then issue again." });
          return;
        }
        outcome = await issueTransmittal(draft.id, actor, { acceptedUnstampable: e.items, onPhase: setIssuePhase });
      }
      await onSaved({ kind: "issued", outcome });
    } catch (e) {
      await onSaved({ kind: "issue-failed", draft, error: (e as Error).message });
    } finally {
      setSaving(null);
      setIssuePhase(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 backdrop-blur-sm animate-in fade-in p-0 sm:p-4" onClick={onClose}>
      <div className="bg-[var(--color-surface)] w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[92vh] flex flex-col animate-in fade-in zoom-in-95" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <h2 className="text-base font-black text-[var(--color-text)] flex items-center gap-2">
            <Send className="w-5 h-5 text-orange-500" /> {editing ? `Edit ${editing.number}` : "New transmittal"}
          </h2>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-[var(--color-surface-2)] flex items-center justify-center text-[var(--color-text-faint)] transition-colors"><X className="w-4 h-4" /></button>
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
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Issued for Construction — Area 200" />
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
            <div className="text-xs font-bold text-[var(--color-text-muted)] mb-1.5 flex items-center gap-1.5"><Package className="w-3.5 h-3.5" /> Documents ({items.length})</div>
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
                      {h.rev && <span className="text-[9px] font-bold bg-[var(--color-surface-2)] text-[var(--color-text-muted)] px-1 rounded">R{h.rev}</span>}
                      {h.title && h.title !== h.number && <span className="text-xs text-[var(--color-text-muted)] truncate">{h.title}</span>}
                      <span className="ml-auto text-[10px] font-bold text-orange-600">{added ? "Added" : "+ Add"}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {items.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {items.map((it) => {
                  const f = facts?.get(it.documentId);
                  const why = facts ? itemIssueBlocker(it, f) : null;
                  return (
                  <li key={it.documentId} className={`flex items-center gap-2 bg-[var(--color-surface-2)] border rounded-lg px-3 py-2 ${why ? "border-rose-300" : "border-[var(--color-border)]"}`}>
                    <DocHoverPreview documentId={it.documentId}>
                      <DocThumb documentId={it.documentId} width={28} />
                    </DocHoverPreview>
                    <span className="font-mono text-xs font-bold text-[var(--color-text)]">{it.number}</span>
                    {it.rev && <span className="text-[9px] font-bold bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] px-1 rounded">R{it.rev}</span>}
                    {f?.status && <span className="text-[9px] font-bold text-[var(--color-text-muted)]">{f.status}</span>}
                    {f?.legalHold && <span className="text-[9px] font-black text-amber-700 inline-flex items-center gap-0.5" title="Under a legal hold — issuing asks for confirmation"><Lock className="w-2.5 h-2.5" />LEGAL HOLD</span>}
                    {it.title && it.title !== it.number && <span className="text-xs text-[var(--color-text-muted)] truncate">{it.title}</span>}
                    {why && <span className="text-[10px] font-bold text-rose-700 truncate" title={why}>{why}</span>}
                    <button onClick={() => removeItem(it.documentId)} className="ml-auto text-[var(--color-text-faint)] hover:text-rose-600 transition-colors"><X className="w-3.5 h-3.5" /></button>
                  </li>
                  );
                })}
              </ul>
            )}
            {items.length === 0 && <div className="mt-2 text-xs text-[var(--color-text-faint)] italic">No documents yet — search above to add the drawings/specs you&apos;re issuing.</div>}
          </div>

          <Field label="Notes (optional)">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Anything the recipient should know…" className="resize-y" />
          </Field>
        </div>

        <div className="px-5 py-4 border-t border-[var(--color-border)] flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--color-text-faint)]">{footerHint}</span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => save(false)} disabled={!!saving} loading={saving === "draft"}>
              Save draft
            </Button>
            <Button size="sm" onClick={() => save(true)} disabled={!!saving || !issuable || !canIssue} loading={saving === "issue"}>
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
      <span className="text-xs font-bold text-[var(--color-text-muted)] mb-1 flex items-center gap-1.5">{Icon && <Icon className="w-3.5 h-3.5" />}{label}</span>
      {children}
    </label>
  );
}
