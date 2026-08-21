"use client";

// /companies — the KNOWN COMPANIES registry: every contractor, vendor,
// rental supplier, and internal crew the org works with, each wearing a
// profile card loaded with the data that matters at selection time.
//
// Nothing on a card is a typed-in opinion. The composite dial and its five
// dimensions (safety, quality, cost discipline, schedule, responsiveness)
// are computed from rows the platform already wrote — awards, change
// orders, turnover reviews, milestones, portal timestamps, safety events —
// so every number can show its work, and "Unrated" stays honest where
// evidence doesn't exist yet.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  HardHat, Plus, Search, Loader2, AlertTriangle, X, Check, Phone, Mail,
  Trophy, GitPullRequestArrow, Briefcase, ShieldAlert, BookOpenCheck, Timer,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell, PageHeaderBar } from "@/components/ui/PageShell";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import {
  listCompanies, saveCompany, gatherCompanyProfile,
  COMPANY_KIND_LABEL, type Company, type CompanyProfileData,
} from "@/lib/companies";
import { scoreBand } from "@/lib/companyScore";
import { ScoreDial, scoreBandColor } from "@/components/ui/ChartKit";
import { fmtMoney } from "@/lib/costs";

const KIND_FILTERS = ["all", "contractor", "vendor", "rental", "internal"] as const;

export default function CompaniesPage() {
  const { activeOrgId, uid, hasAnyRole } = useRole();
  const canManage = hasAnyRole(["Admin", "DocCtrl"]);

  const [companies, setCompanies] = useState<Company[]>([]);
  const [profiles, setProfiles] = useState<Map<string, CompanyProfileData>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<(typeof KIND_FILTERS)[number]>("all");
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeOrgId) return;
    setError(null);
    try {
      const list = await listCompanies(activeOrgId);
      setCompanies(list);
      setLoading(false);
      // Evidence gathers run AFTER the cards paint, a few at a time — the
      // page is instant, the scores stream in.
      const queue = [...list];
      const workers = Array.from({ length: 4 }, async () => {
        for (;;) {
          const c = queue.shift();
          if (!c) return;
          try {
            const p = await gatherCompanyProfile(c);
            setProfiles((prev) => new Map(prev).set(c.id, p));
          } catch { /* card stays basic */ }
        }
      });
      await Promise.all(workers);
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  }, [activeOrgId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return companies.filter((c) =>
      (kindFilter === "all" || c.kind === kindFilter) &&
      (!q || c.name.toLowerCase().includes(q) || (c.trade ?? "").toLowerCase().includes(q)));
  }, [companies, search, kindFilter]);

  return (
    <PageShell width="work">
      <PageHeaderBar
        icon={HardHat}
        title="Known Companies"
        subtitle={<>Every contractor, vendor, and crew you work with — scored on the evidence this platform witnesses, never on opinion.</>}
        actions={canManage ? (
          <Button onClick={() => setShowAdd(true)}><Plus className="w-4 h-4" /> Add company</Button>
        ) : undefined}
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {KIND_FILTERS.map((k) => (
          <button key={k} onClick={() => setKindFilter(k)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
              kindFilter === k
                ? "bg-slate-900 text-white"
                : "bg-[var(--color-surface)] text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)]"}`}>
            {k === "all" ? "All" : COMPANY_KIND_LABEL[k]}
          </button>
        ))}
        <div className="relative flex-1 min-w-56">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-faint)]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or trade…"
            className="w-full pl-9 pr-3 py-2 bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] text-sm focus:ring-2 focus:ring-[var(--color-accent-ring)] outline-none" />
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-500/50 bg-rose-500/[0.08] px-3 py-2.5 text-xs font-bold text-rose-700 dark:text-rose-300">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] p-8"><Spinner size="sm" /> Loading the registry…</div>
      ) : shown.length === 0 ? (
        <div className="bg-[var(--color-surface)] border border-dashed border-[var(--color-border-strong)] rounded-2xl p-12 text-center">
          <HardHat className="w-10 h-10 mx-auto text-slate-300 mb-3" />
          <h3 className="text-base font-black text-[var(--color-text)] mb-1">
            {companies.length === 0 ? "No companies in the registry yet" : "No companies match"}
          </h3>
          <p className="text-xs text-[var(--color-text-muted)] max-w-md mx-auto">
            {companies.length === 0
              ? "Add the contractors and vendors you work with. Their record — awards, change orders, turnover acceptance, safety events — builds itself as projects run."
              : "Try a different filter or search."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {shown.map((c) => (
            <CompanyCard key={c.id} company={c} profile={profiles.get(c.id) ?? null} />
          ))}
        </div>
      )}

      {showAdd && activeOrgId && uid && (
        <AddCompanyModal orgId={activeOrgId} actorId={uid}
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); void refresh(); }} />
      )}
    </PageShell>
  );
}

// ── The juicy card ───────────────────────────────────────────────────────

function CompanyCard({ company: c, profile }: { company: Company; profile: CompanyProfileData | null }) {
  const sc = profile?.scorecard ?? null;
  const band = scoreBand(sc?.composite ?? null);
  const safety = useMemo(() => {
    const ev = profile?.events ?? [];
    return {
      recordables: ev.filter((e) => e.kind === "recordable").length,
      nearMisses: ev.filter((e) => e.kind === "near_miss").length,
      stopWorks: ev.filter((e) => e.kind === "stop_work").length,
      commendations: ev.filter((e) => e.kind === "commendation").length,
    };
  }, [profile]);
  const bidsWon = profile?.bids.filter((b) => b.won).length ?? 0;
  const bidsTotal = profile?.bids.length ?? 0;
  const coCount = profile?.changeOrders.filter((co) => co.status === "approved").length ?? 0;
  const coAmount = profile?.changeOrders.filter((co) => co.status === "approved").reduce((s, co) => s + co.amount, 0) ?? 0;

  return (
    <Link href={`/companies/${c.id}`}
      className="group block bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] p-4 shadow-sm hover-lift hover:border-[var(--color-accent-ring)]">
      <div className="flex items-start gap-4">
        {/* Dial */}
        <div className="shrink-0 flex flex-col items-center">
          <ScoreDial score={sc?.composite ?? null} size={76} label={band.label} />
          {sc && sc.evidenceCount > 0 && (
            <span className="mt-1 text-[9px] text-[var(--color-text-faint)]" title="How much recorded evidence backs this score">
              {sc.evidenceCount} evidence point{sc.evidenceCount === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {/* Identity + dimensions */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-black text-[var(--color-text)] truncate group-hover:text-[var(--color-accent)] transition-colors">{c.name}</span>
            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)]">{COMPANY_KIND_LABEL[c.kind]}</span>
            {c.trade && <span className="text-[10px] text-[var(--color-text-muted)]">{c.trade}</span>}
            {c.status === "do_not_use" && (
              <span className="text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300">Do not use</span>
            )}
            {c.status === "inactive" && <span className="text-[9px] font-bold text-[var(--color-text-faint)]">inactive</span>}
          </div>

          {/* The five dimensions — each shows its work on hover AND in text. */}
          <div className="mt-2 space-y-1">
            {(sc?.dimensions ?? []).map((d) => (
              <div key={d.key} className="flex items-center gap-2 text-[10px]" title={d.detail}>
                <span className="w-24 shrink-0 font-bold text-[var(--color-text-muted)]">{d.label}</span>
                {d.score != null ? (
                  <>
                    <span className="h-1.5 w-24 rounded-full bg-[var(--viz-track)] overflow-hidden shrink-0">
                      <span className="block h-full rounded-full" style={{ width: `${d.score}%`, background: scoreBandColor(d.score) }} />
                    </span>
                    <span className="tabular-nums font-black text-[var(--color-text)] w-7 shrink-0">{Math.round(d.score)}</span>
                    <span className="text-[var(--color-text-muted)] truncate">{d.detail}</span>
                  </>
                ) : (
                  <span className="text-[var(--color-text-faint)] italic">{d.detail}</span>
                )}
              </div>
            ))}
            {!profile && (
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-faint)]"><Loader2 className="w-3 h-3 animate-spin" /> gathering the record…</div>
            )}
          </div>
        </div>
      </div>

      {/* Fact strip — the juicy row. */}
      <div className="mt-3 pt-2.5 border-t border-[var(--color-border)] flex flex-wrap gap-x-4 gap-y-1.5 text-[10px] text-[var(--color-text-muted)]">
        {(profile?.projects.length ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1" title={profile!.projects.map((p) => p.projectName).join(", ")}>
            <Briefcase className="w-3 h-3" /> {profile!.projects.length} job{profile!.projects.length === 1 ? "" : "s"}
          </span>
        )}
        {bidsTotal > 0 && (
          <span className="inline-flex items-center gap-1" title="Quotes submitted / awarded">
            <Trophy className="w-3 h-3" /> {bidsWon}/{bidsTotal} bids won
          </span>
        )}
        {coCount > 0 && (
          <span className="inline-flex items-center gap-1" title="Approved change orders on their scopes">
            <GitPullRequestArrow className="w-3 h-3" /> {coCount} CO{coCount === 1 ? "" : "s"} · {fmtMoney(coAmount)}
          </span>
        )}
        {(safety.recordables > 0 || safety.stopWorks > 0) && (
          <span className="inline-flex items-center gap-1 font-bold text-rose-700 dark:text-rose-300">
            <ShieldAlert className="w-3 h-3" /> {safety.recordables > 0 ? `${safety.recordables} recordable${safety.recordables === 1 ? "" : "s"}` : ""}{safety.recordables > 0 && safety.stopWorks > 0 ? " · " : ""}{safety.stopWorks > 0 ? `${safety.stopWorks} stop-work${safety.stopWorks === 1 ? "" : "s"}` : ""}
          </span>
        )}
        {c.qualityManualScore != null && (
          <span className="inline-flex items-center gap-1" title="Quality-manual coverage vs the ISO 9001-shaped rubric (human-confirmed)">
            <BookOpenCheck className="w-3 h-3" /> QM {Math.round(c.qualityManualScore)}%
          </span>
        )}
        {sc?.dimensions.find((d) => d.key === "responsiveness")?.score != null && (
          <span className="inline-flex items-center gap-1" title={sc.dimensions.find((d) => d.key === "responsiveness")!.detail}>
            <Timer className="w-3 h-3" /> {sc.dimensions.find((d) => d.key === "responsiveness")!.detail.split(" · ")[0]}
          </span>
        )}
        {c.contactName && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" /> {c.contactName}</span>}
        {c.contactEmail && <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" /> {c.contactEmail}</span>}
      </div>
    </Link>
  );
}

// ── Add modal ────────────────────────────────────────────────────────────

function AddCompanyModal({ orgId, actorId, onClose, onCreated }: {
  orgId: string; actorId: string; onClose: () => void; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Company["kind"]>("contractor");
  const [trade, setTrade] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await saveCompany({
        orgId, name, kind, trade,
        contactName, contactEmail, contactPhone, notes,
        actorId,
      });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-slate-900/60 backdrop-blur-sm animate-in fade-in flex items-start sm:items-center justify-center overflow-y-auto p-4">
      <div className="w-full max-w-lg bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-border)] overflow-hidden animate-in fade-in zoom-in-95">
        <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center gap-3">
          <div className="p-2 bg-[var(--color-accent-soft)] rounded-lg"><HardHat className="w-5 h-5 text-[var(--color-accent)]" /></div>
          <div className="flex-1">
            <div className="text-sm font-black text-[var(--color-text)]">Add a known company</div>
            <div className="text-xs text-[var(--color-text-muted)]">Their record builds itself from real work — this is just the front of the file.</div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 rounded-lg hover:bg-[var(--color-surface-2)] text-[var(--color-text-faint)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company name *" autoFocus
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
            <select value={kind} onChange={(e) => setKind(e.target.value as Company["kind"])}
              className="px-2 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]">
              {(Object.keys(COMPANY_KIND_LABEL) as Company["kind"][]).map((k) => (
                <option key={k} value={k}>{COMPANY_KIND_LABEL[k]}</option>
              ))}
            </select>
          </div>
          <input value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="Trade (piping, E&I, scaffolding…)"
            className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
          <div className="grid grid-cols-3 gap-3">
            <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Contact name"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
            <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Email"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
            <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="Phone"
              className="px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm bg-[var(--color-surface)]" />
          </div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Notes"
            className="w-full px-3 py-2 border border-[var(--color-border-strong)] rounded-lg text-sm resize-y bg-[var(--color-surface)]" />
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-rose-500/40 bg-rose-500/[0.07] text-xs font-bold text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {error}
            </div>
          )}
        </div>
        <div className="px-6 py-3 bg-[var(--color-surface-2)] border-t border-[var(--color-border)] flex items-center justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-text)] bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-2)] disabled:opacity-50">Cancel</button>
          <button onClick={() => void submit()} disabled={busy || !name.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-[var(--color-accent-fg)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-60">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Add company
          </button>
        </div>
      </div>
    </div>
  );
}
