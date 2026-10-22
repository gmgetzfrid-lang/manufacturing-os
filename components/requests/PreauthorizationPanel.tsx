"use client";

// PreauthorizationPanel — drafting-flow Round G, DF-P22: GAP-109 mechanism 2,
// STANDING PRE-AUTHORIZATION, on the person's own profile.
//
//   * Lists the viewer's own standing pre-authorizations (an Admin sees the
//     workspace's) with what each covers, when it expires and whether it was
//     revoked, and — merge-time fix pass — "not in force — grantor's
//     membership lapsed" for a record whose grantor's membership lapsed after
//     it was created (never used again, reactivation included); the person
//     who recorded one, or an Admin, may revoke it (PREAUTH_REVOCATION_SCOPE:
//     immediately for every use not yet made; a sign-off already completed
//     under it while it was valid stands and keeps naming it).
//   * Records a new one for the VIEWER only: what it covers (a library, a
//     request type, a work class — at least one; the workspace's own lists),
//     a REQUIRED expiry (at most 365 days), and the e-signature ceremony the
//     like-in-kind declaration uses, over the statement the server checks
//     word for word (lib/ticketPreauthorization.ts preauthorizationStatement).
//   * It acts only where a document controller set a review slot to accept a
//     standing pre-authorization — the panel says so; nothing changes for a
//     workspace that never does.
//   * Before 20261264 is pasted the panel says it is not available (the
//     route's 503), and records nothing.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck, Ban } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useRole } from "@/components/providers/RoleContext";
import { recordSignature, type SigningCredential } from "@/lib/eSignatures";
import SignatureCeremony from "@/components/signatures/SignatureCeremony";
import { reviewClassOptions } from "@/lib/reviewModel";
import type { OrgDraftingSettings } from "@/types/schema";
import {
  PREAUTH_SIGNATURE_INTENT, PREAUTH_SIGNATURE_RESOURCE, PREAUTH_MAX_DAYS, PREAUTH_REVOCATION_SCOPE, GRANTOR_MEMBERSHIP_WORDS, preauthDraftRefusal,
  preauthExpiryDay, preauthExpiryFromDay, preauthLatestDay, preauthScopeWords, preauthStanding, preauthorizationStatement, type Preauthorization,
} from "@/lib/ticketPreauthorization";

interface Option { value: string; label: string }

async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` };
}

export default function PreauthorizationPanel() {
  const { uid, userEmail, activeOrgId, member } = useRole();
  const [records, setRecords] = useState<Preauthorization[] | null>(null);
  const [admin, setAdmin] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [libraries, setLibraries] = useState<Option[]>([]);
  const [requestTypes, setRequestTypes] = useState<Option[]>([]);
  const [workClasses, setWorkClasses] = useState<Option[]>([]);
  const [draft, setDraft] = useState({ libraryId: "", requestType: "", workClass: "", day: "" });
  const [signing, setSigning] = useState<{ id: string; statement: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    setError(null);
    try {
      const res = await fetch(`/api/tickets/preauthorizations?orgId=${encodeURIComponent(activeOrgId)}`, { headers: await authHeader() });
      const out = (await res.json().catch(() => ({}))) as { records?: Preauthorization[]; admin?: boolean; error?: string; code?: string };
      if (res.status === 503 && out.code === "not_migrated") { setUnavailable(out.error ?? "Not available yet."); setRecords([]); return; }
      if (!res.ok) throw new Error(out.error || `Couldn't read your standing pre-authorizations (HTTP ${res.status})`);
      setRecords(out.records ?? []);
      setAdmin(!!out.admin);
    } catch (e) {
      setError((e as Error).message);
      setRecords([]);
    }
  }, [activeOrgId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!activeOrgId) return;
    let alive = true;
    (async () => {
      const [libs, cfg] = await Promise.all([
        supabase.from("libraries").select("id, name").eq("org_id", activeOrgId).order("name"),
        supabase.from("org_configurations").select("data").eq("org_id", activeOrgId).eq("key", "drafting").maybeSingle(),
      ]);
      if (!alive) return;
      setLibraries((((libs.data as Array<{ id: string; name: string | null }> | null) ?? [])).map((l) => ({ value: l.id, label: l.name || l.id })));
      const data = ((cfg.data as { data?: Partial<OrgDraftingSettings> } | null)?.data ?? null) as Partial<OrgDraftingSettings> | null;
      const types = (data?.requestTypes?.options ?? []) as Array<{ value?: unknown; label?: unknown }>;
      setRequestTypes(types.filter((o) => typeof o?.value === "string" && o.value).map((o) => ({ value: String(o.value), label: typeof o.label === "string" && o.label ? o.label : String(o.value) })));
      setWorkClasses(reviewClassOptions(data, "workClasses").map((o) => ({ value: o.value, label: o.label })));
    })();
    return () => { alive = false; };
  }, [activeOrgId]);

  const libraryName = useMemo(() => libraries.find((l) => l.value === draft.libraryId)?.label ?? null, [libraries, draft.libraryId]);
  const expiresAt = draft.day ? preauthExpiryFromDay(draft.day) : "";
  const refusal = preauthDraftRefusal({ libraryId: draft.libraryId || null, requestType: draft.requestType || null, workClass: draft.workClass || null, expiresAt }, Date.now());
  const signerName = (member?.displayName ?? "").trim() || (userEmail?.split("@")[0] ?? "").trim() || "user";

  const startSigning = () => {
    if (refusal) return;
    setSignError(null);
    setSigning({
      id: crypto.randomUUID(),
      expiresAt,
      statement: preauthorizationStatement({ libraryId: draft.libraryId || null, libraryName, requestType: draft.requestType || null, workClass: draft.workClass || null, expiresAt }),
    });
  };

  const revoke = async (id: string) => {
    if (!activeOrgId) return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/tickets/preauthorizations", { method: "PATCH", headers: await authHeader(), body: JSON.stringify({ orgId: activeOrgId, id, action: "revoke" }) });
      const out = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) throw new Error(out.error || `It was not revoked (HTTP ${res.status})`);
      setNotice(out.message || PREAUTH_REVOCATION_SCOPE);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!activeOrgId || !uid) return null;
  const now = Date.now();
  const labelOf = (list: Option[], v: string | null) => (v ? list.find((o) => o.value === v)?.label ?? v : null);

  return (
    <section data-testid="preauthorization-panel" className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-sm p-5 mb-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-[var(--color-accent)]" />
        <div className="text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-widest">Standing pre-authorizations</div>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Give your sign-off ahead of time for a kind of request. It is used only on a review slot your workspace has set to accept a standing pre-authorization, never on engineered work, an engineering sign-off or an assurance check, and never for the last sign-off a review waits on. It always expires (at most {PREAUTH_MAX_DAYS} days), it is in force only while you stay an active member of this workspace (if your membership lapses, it is never used again), and every request that uses it names it. You can revoke it at any time. {PREAUTH_REVOCATION_SCOPE}
      </p>
      {unavailable && <p className="text-xs text-amber-700">{unavailable}</p>}
      {notice && <p role="status" className="text-xs text-[var(--color-text-muted)]">{notice}</p>}
      {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}

      {records !== null && records.length > 0 && (
        <ul className="divide-y divide-[var(--color-border)]">
          {records.map((r) => {
            const standing = preauthStanding(r, now);
            const lapsed = r.grantorMembership && r.grantorMembership !== "continuous" ? GRANTOR_MEMBERSHIP_WORDS[r.grantorMembership] : null;
            return (
              <li key={r.id} className="py-2 flex items-start gap-3 text-xs">
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-[var(--color-text)]">
                    {preauthScopeWords({ libraryId: r.libraryId, libraryName: labelOf(libraries, r.libraryId), requestType: r.requestType, workClass: r.workClass })}
                  </div>
                  <div className="text-[var(--color-text-muted)]">
                    {admin && r.grantorId !== uid ? `${r.grantorName ?? "A member"} · ` : ""}
                    recorded {preauthExpiryDay(r.createdAt)} · {r.revokedAt ? `revoked ${preauthExpiryDay(r.revokedAt)}` : !standing ? `expired ${preauthExpiryDay(r.expiresAt)}` : lapsed ? `${lapsed} · expires ${preauthExpiryDay(r.expiresAt)}` : `expires ${preauthExpiryDay(r.expiresAt)}`}
                  </div>
                </div>
                {standing && (r.grantorId === uid || admin) && (
                  <button type="button" onClick={() => void revoke(r.id)} className="inline-flex items-center gap-1 text-rose-700 hover:underline">
                    <Ban className="w-3 h-3" /> Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {records !== null && records.length === 0 && !unavailable && <p className="text-xs italic text-[var(--color-text-muted)]">You have none.</p>}

      {!unavailable && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
          <label className="text-[11px] text-[var(--color-text-muted)]">Library
            <select aria-label="Library" className="mt-1 w-full border border-[var(--color-border)] rounded px-2 py-1 text-xs" value={draft.libraryId} onChange={(e) => setDraft({ ...draft, libraryId: e.target.value })}>
              <option value="">Any</option>
              {libraries.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-[var(--color-text-muted)]">Request type
            <select aria-label="Request type" className="mt-1 w-full border border-[var(--color-border)] rounded px-2 py-1 text-xs" value={draft.requestType} onChange={(e) => setDraft({ ...draft, requestType: e.target.value })}>
              <option value="">Any</option>
              {requestTypes.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-[var(--color-text-muted)]">Work class
            <select aria-label="Work class" className="mt-1 w-full border border-[var(--color-border)] rounded px-2 py-1 text-xs" value={draft.workClass} onChange={(e) => setDraft({ ...draft, workClass: e.target.value })}>
              <option value="">Any</option>
              {workClasses.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="text-[11px] text-[var(--color-text-muted)]">Expires (required)
            <input aria-label="Expires" type="date" className="mt-1 w-full border border-[var(--color-border)] rounded px-2 py-1 text-xs" value={draft.day} max={preauthLatestDay(now)} onChange={(e) => setDraft({ ...draft, day: e.target.value })} />
          </label>
          <div className="md:col-span-4 flex items-center gap-3">
            <button type="button" disabled={!!refusal || busy} onClick={startSigning} className="px-3 py-1.5 rounded bg-[var(--color-accent)] text-white text-xs font-bold disabled:opacity-50">
              Sign and record
            </button>
            {refusal && (draft.libraryId || draft.requestType || draft.workClass || draft.day) && <span className="text-[11px] text-[var(--color-text-muted)]">{refusal}</span>}
          </div>
        </div>
      )}

      {signing && (
        <SignatureCeremony
          signerName={signerName}
          resourceLabel="your standing pre-authorization"
          defaultIntent={PREAUTH_SIGNATURE_INTENT}
          defaultStatement={signing.statement}
          lockIntent
          busy={busy}
          error={signError}
          onCancel={() => { if (!busy) setSigning(null); }}
          onSign={async (_intent, statement, signatureImage, reauth?: SigningCredential) => {
            if (!activeOrgId || !uid) { setSigning(null); return; }
            setBusy(true);
            setSignError(null);
            try {
              const sig = await recordSignature({
                orgId: activeOrgId, resourceType: PREAUTH_SIGNATURE_RESOURCE, resourceId: signing.id,
                intent: PREAUTH_SIGNATURE_INTENT, statement,
                signerUserId: uid, signerName, signatureImage: signatureImage ?? null, reauth: reauth ?? null,
              });
              const res = await fetch("/api/tickets/preauthorizations", {
                method: "POST", headers: await authHeader(),
                body: JSON.stringify({ orgId: activeOrgId, id: signing.id, libraryId: draft.libraryId || null, requestType: draft.requestType || null, workClass: draft.workClass || null, expiresAt: signing.expiresAt, signatureId: sig.id }),
              });
              const out = (await res.json().catch(() => ({}))) as { error?: string };
              if (!res.ok) throw new Error(out.error || `It was not recorded (HTTP ${res.status})`);
              setSigning(null);
              setDraft({ libraryId: "", requestType: "", workClass: "", day: "" });
              await load();
            } catch (e) {
              setSignError((e as Error)?.message || "It was not recorded.");
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </section>
  );
}
