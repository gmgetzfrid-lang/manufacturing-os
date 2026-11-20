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
import { useRouter } from "next/navigation";
import LoadingBlock from "@/components/ui/LoadingBlock";
import { useDraft } from "@/hooks/useDraft";
import { Plus, Search, Loader2, HardHat } from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { PageShell } from "@/components/ui/PageShell";
import { PageHero, PageBody, Card, heroPrimary, heroQuiet, type HeroFact } from "@/components/ui/PageHero";
import { Modal, ModalHeader, ModalBody, ModalFooter } from "@/components/ui/Modal";
import { StatusTag } from "@/components/requests/RequestBits";
import { bandInput, bandInputIcon, bandSeg, bandSegItem, plural } from "@/components/admin/band";
import {
  listCompanies, saveCompany, gatherCompanyProfile,
  COMPANY_KIND_LABEL, type Company, type CompanyProfileData,
} from "@/lib/companies";
import { type DimensionScore } from "@/lib/companyScore";
import { ScoreBadge, ScoreFigure } from "./score";
import { fmtMoney } from "@/lib/costs";

const KIND_FILTERS = ["all", "contractor", "vendor", "rental", "internal"] as const;

export default function CompaniesPage() {
  const { activeOrgId, uid, hasAnyRole } = useRole();
  const canManage = hasAnyRole(["Admin", "DocCtrl"]);
  const router = useRouter();
  const [profileFailed, setProfileFailed] = useState<Set<string>>(new Set());

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
          } catch { setProfileFailed((prev) => new Set(prev).add(c.id)); }
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

  const doNotUse = companies.filter((c) => c.status === "do_not_use").length;
  const rated = companies.filter((c) => profiles.get(c.id)?.scorecard.composite != null).length;
  const contractors = companies.filter((c) => c.kind === "contractor").length;
  const answer = loading ? "Known companies" : error && companies.length === 0 ? "Couldn't load the companies."
    : companies.length === 0 ? "No companies yet." : `${plural(companies.length, "company", "companies")} on record.`;
  const facts: HeroFact[] = loading || companies.length === 0 ? [] : [
    { label: "Contractors", value: contractors },
    { label: "Rated", value: rated },
    { label: "Do not use", value: doNotUse, tone: doNotUse > 0 ? "bad" : undefined },
  ];
  const [limit, setLimit] = useState(20);

  return (
    <PageShell width="work">
      <PageHero
        kicker="Known companies"
        title={answer}
        sub="Scored only on recorded work, never on opinion."
        facts={facts}
        primary={canManage ? (
          <button type="button" onClick={() => setShowAdd(true)} className={heroPrimary}><Plus className="w-4 h-4" /> Add company</button>
        ) : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search className={bandInputIcon} />
            <label htmlFor="company-search" className="sr-only">Search companies</label>
            <input id="company-search" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Find by name or trade (piping, E&I)"
              className={bandInput} />
          </div>
          <div className={bandSeg} role="group" aria-label="Kind of company">
            {KIND_FILTERS.map((k) => (
              <button key={k} type="button" onClick={() => setKindFilter(k)} aria-pressed={kindFilter === k} className={bandSegItem(kindFilter === k)}>
                {k === "all" ? "All" : COMPANY_KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>
      </PageHero>

      <PageBody className="!space-y-3">
      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-[15px] text-[var(--color-text)]">
          <span className="relative pl-3"><span aria-hidden className="absolute left-0 top-1 bottom-1 w-[3px] bg-[var(--state-overdue)]" />Couldn&apos;t load the companies: {error}</span>
          <button type="button" onClick={() => void refresh()} className="text-[var(--color-accent-text)] hover:underline underline-offset-2">Try again</button>
        </div>
      )}

      {loading ? (
        <Card><LoadingBlock what="companies" className="border-0 p-0" /></Card>
      ) : shown.length === 0 ? (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-12 text-center">
          <span aria-hidden className="ui-icon-tile mx-auto mb-3"><HardHat className="w-5 h-5" /></span>
          <div className="font-display text-[19px] font-semibold text-[var(--color-text)]">
            {companies.length === 0 ? "Start the registry" : "No companies match"}
          </div>
          <p className="mt-1 text-[15px] text-[var(--color-text-muted)] max-w-md mx-auto">
            {companies.length === 0
              ? "Add the contractors and vendors you work with. Their record fills in as projects run."
              : "Try a different filter or search."}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
          <table className="w-full text-[15px] max-sm:hidden">
            <thead className="bg-[var(--color-surface-2)] text-[13px] text-[var(--color-text-muted)] text-left">
              <tr>
                <th className="font-semibold px-4 h-10 w-full">Company</th>
                <th className="font-semibold px-4 h-10 hidden md:table-cell whitespace-nowrap">Kind</th>
                <th className="font-semibold px-4 h-10 whitespace-nowrap">Score</th>
                {DIMENSIONS.map(([key, label]) => (
                  <th key={key} className="font-semibold px-3 h-10 hidden lg:table-cell text-right whitespace-nowrap">{label}</th>
                ))}
                <th className="font-semibold px-4 h-10 hidden xl:table-cell text-right whitespace-nowrap">Jobs</th>
                <th className="font-semibold px-4 h-10 hidden xl:table-cell text-right whitespace-nowrap">Bids won</th>
                <th className="font-semibold px-4 h-10 hidden 2xl:table-cell text-right whitespace-nowrap">Change orders</th>
                <th className="font-semibold px-4 h-10 hidden 2xl:table-cell whitespace-nowrap">Contact</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {shown.slice(0, limit).map((c) => (
                <CompanyRow key={c.id} company={c} profile={profiles.get(c.id) ?? null} failed={profileFailed.has(c.id)} onOpen={() => router.push(`/companies/${c.id}`)}
                  onKind={(KIND_FILTERS as readonly string[]).includes(c.kind) ? () => setKindFilter(kindFilter === c.kind ? "all" : (c.kind as (typeof KIND_FILTERS)[number])) : undefined}
                  onTrade={c.trade ? () => setSearch(search === c.trade ? "" : c.trade!) : undefined} />
              ))}
            </tbody>
          </table>
          <ul className="sm:hidden divide-y divide-[var(--color-border)]">
            {shown.slice(0, limit).map((c) => (
              <CompanyItem key={c.id} company={c} profile={profiles.get(c.id) ?? null} failed={profileFailed.has(c.id)} />
            ))}
          </ul>
          {shown.length > limit && (
            <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-[var(--color-border)] text-[13px]">
              <span className="text-[var(--color-text-muted)] tabular-nums">{limit} of {shown.length} shown</span>
              <button type="button" onClick={() => setLimit((n) => n + 40)} className={heroQuiet}>
                Show {Math.min(40, shown.length - limit)} more
              </button>
            </div>
          )}
        </div>
      )}
      </PageBody>

      {showAdd && activeOrgId && uid && (
        <AddCompanyModal orgId={activeOrgId} actorId={uid}
          onClose={() => setShowAdd(false)}
          onCreated={(created) => { setShowAdd(false); router.push(`/companies/${created.id}`); }} />
      )}
    </PageShell>
  );
}

// ── One company, one row ─────────────────────────────────────────────────

const DIMENSIONS: Array<[DimensionScore["key"], string]> = [
  ["safety", "Safety"], ["quality", "Quality"], ["cost", "Cost"], ["schedule", "Schedule"], ["responsiveness", "Response"],
];

function useCompanyFacts(profile: CompanyProfileData | null) {
  return useMemo(() => {
    const ev = profile?.events ?? [];
    const recordables = ev.filter((e) => e.kind === "recordable").length;
    const stopWorks = ev.filter((e) => e.kind === "stop_work").length;
    const approved = profile?.changeOrders.filter((co) => co.status === "approved") ?? [];
    return {
      recordables, stopWorks,
      jobs: profile?.projects.length ?? 0,
      bidsWon: profile?.bids.filter((b) => b.won).length ?? 0,
      bidsTotal: profile?.bids.length ?? 0,
      coCount: approved.length,
      coAmount: approved.reduce((s, co) => s + co.amount, 0),
    };
  }, [profile]);
}

function ScoreCell({ profile, failed }: { profile: CompanyProfileData | null; failed?: boolean }) {
  if (!profile) {
    return failed
      ? <span className="text-[13px] text-[var(--color-text-muted)]" title="Open the company to try again">Couldn&apos;t gather</span>
      : <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-text-faint)]"><Loader2 className="w-3 h-3 animate-spin" /> Gathering</span>;
  }
  const sc = profile.scorecard;
  return (
    <span title={sc.evidenceCount > 0 ? `${sc.evidenceCount} evidence point${sc.evidenceCount === 1 ? "" : "s"} back this score` : "No recorded work yet"}>
      <ScoreBadge score={sc.composite} />
    </span>
  );
}

function CompanyRow({ company: c, profile, failed, onOpen, onKind, onTrade }: { company: Company; profile: CompanyProfileData | null; failed?: boolean; onOpen: () => void; onKind?: () => void; onTrade?: () => void }) {
  const f = useCompanyFacts(profile);
  const dims = new Map((profile?.scorecard.dimensions ?? []).map((d) => [d.key, d]));
  const blocked = c.status === "do_not_use";
  return (
    <tr onClick={(e) => { if ((e.target as HTMLElement).closest("a,button")) return; onOpen(); }} className="cursor-pointer hover:bg-[var(--color-surface-2)]">
      <td className="px-4 py-3 relative max-w-0">
        {blocked && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
        <Link href={`/companies/${c.id}`} className="block truncate font-semibold text-[var(--color-text)] hover:text-[var(--color-accent-text)]">{c.name}</Link>
        {(blocked || c.status === "inactive" || c.trade) && (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
            {blocked && <StatusTag tone="bad">Do not use</StatusTag>}
            {c.status === "inactive" && <StatusTag>Inactive</StatusTag>}
            {c.trade && (onTrade
              ? <button type="button" onClick={onTrade} title={`Find every ${c.trade} company`} className="ui-tag max-w-full truncate">{c.trade}</button>
              : <span className="ui-tag">{c.trade}</span>)}
          </div>
        )}
      </td>
      <td className="px-4 py-3 hidden md:table-cell whitespace-nowrap">
        {onKind
          ? <button type="button" onClick={onKind} title={`Show only ${COMPANY_KIND_LABEL[c.kind]}`} className="ui-tag">{COMPANY_KIND_LABEL[c.kind]}</button>
          : <span className="ui-tag">{COMPANY_KIND_LABEL[c.kind]}</span>}
      </td>
      <td className="px-4 py-3"><ScoreCell profile={profile} failed={failed} /></td>
      {DIMENSIONS.map(([key]) => {
        const d = dims.get(key);
        return (
          <td key={key} className="px-3 py-3 hidden lg:table-cell text-right whitespace-nowrap" title={d?.detail}>
            {d?.score != null
              ? <ScoreFigure score={d.score} className="text-[17px]" />
              : <span className="text-[var(--color-text-faint)]">{profile ? "None" : ""}</span>}
            {key === "safety" && (f.recordables > 0 || f.stopWorks > 0) && (
              <div className="text-[13px] font-semibold text-[var(--state-overdue)]">
                {f.recordables > 0 ? plural(f.recordables, "recordable") : plural(f.stopWorks, "stop work", "stop works")}
              </div>
            )}
          </td>
        );
      })}
      <td className="px-4 py-3 hidden xl:table-cell text-right">{profile ? <span className={`ui-count ${f.jobs > 0 ? "" : "!bg-transparent !text-[var(--color-text-faint)]"}`}>{f.jobs}</span> : ""}</td>
      <td className="px-4 py-3 hidden xl:table-cell text-right tabular-nums whitespace-nowrap">{profile ? (f.bidsTotal > 0 ? `${f.bidsWon} of ${f.bidsTotal}` : <span className="text-[var(--color-text-faint)]">None</span>) : ""}</td>
      <td className="px-4 py-3 hidden 2xl:table-cell text-right tabular-nums whitespace-nowrap">{profile ? (f.coCount > 0 ? <>{f.coCount} <span className="text-[var(--color-text-muted)]">{fmtMoney(f.coAmount)}</span></> : <span className="text-[var(--color-text-faint)]">None</span>) : ""}</td>
      <td className="px-4 py-3 hidden 2xl:table-cell whitespace-nowrap">
        {c.contactName || c.contactEmail
          ? <><div>{c.contactName || c.contactEmail}</div>{c.contactName && c.contactEmail && <div className="text-[13px] text-[var(--color-text-muted)]">{c.contactEmail}</div>}</>
          : <span className="text-[var(--color-text-faint)]">None</span>}
      </td>
    </tr>
  );
}

/** The same company as a stacked row on a phone. */
function CompanyItem({ company: c, profile, failed }: { company: Company; profile: CompanyProfileData | null; failed?: boolean }) {
  const f = useCompanyFacts(profile);
  const blocked = c.status === "do_not_use";
  return (
    <li className="relative">
      {blocked && <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />}
      <Link href={`/companies/${c.id}`} className="block px-4 py-3 active:bg-[var(--color-surface-2)]">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 font-semibold text-[15px] text-[var(--color-text)] truncate">{c.name}</span>
          <ScoreCell profile={profile} failed={failed} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
          {blocked && <StatusTag tone="bad">Do not use</StatusTag>}
          <span className="ui-tag">{COMPANY_KIND_LABEL[c.kind]}</span>
          {c.trade && <span className="ui-tag">{c.trade}</span>}
          {profile && f.jobs > 0 && <span>{plural(f.jobs, "job")}</span>}
          {f.recordables > 0 && <span className="font-semibold text-[var(--state-overdue)]">{plural(f.recordables, "recordable")}</span>}
        </div>
      </Link>
    </li>
  );
}

// ── Add modal ────────────────────────────────────────────────────────────

function AddCompanyModal({ orgId, actorId, onClose, onCreated }: {
  orgId: string; actorId: string; onClose: () => void; onCreated: (created: Company) => void;
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
  const notesDraft = useDraft<string>(`new-company-notes:${orgId}`, notes, setNotes, (v) => !v.trim());

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const created = await saveCompany({
        orgId, name, kind, trade,
        contactName, contactEmail, contactPhone, notes,
        actorId,
      });
      notesDraft.clear();
      // Straight to the new company's file.
      onCreated(created);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const field = "w-full h-10 px-3 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[15px] text-[var(--color-text)] outline-none focus:border-[var(--color-main)] focus:ring-2 focus:ring-[var(--color-accent-ring)]/40";
  const label = "block text-[13px] font-semibold text-[var(--color-text-muted)] mb-1.5";
  return (
    <Modal onClose={onClose} dismissable={!busy} size="lg">
      <ModalHeader title="Add a known company" subtitle="Their record fills in from real work." onClose={busy ? undefined : onClose} />
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) void submit(); }} className="contents">
        <ModalBody className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_200px] gap-4">
            <div><label htmlFor="co-name" className={label}>Company name</label><input id="co-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required className={field} /></div>
            <div>
              <label htmlFor="co-kind" className={label}>Kind</label>
              <select id="co-kind" value={kind} onChange={(e) => setKind(e.target.value as Company["kind"])} className={field}>
                {(Object.keys(COMPANY_KIND_LABEL) as Company["kind"][]).map((k) => (
                  <option key={k} value={k}>{COMPANY_KIND_LABEL[k]}</option>
                ))}
              </select>
            </div>
          </div>
          <div><label htmlFor="co-trade" className={label}>Trade <span className="font-normal">(optional)</span></label><input id="co-trade" value={trade} onChange={(e) => setTrade(e.target.value)} placeholder="Piping, E&I, scaffolding" className={field} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div><label htmlFor="co-cname" className={label}>Contact <span className="font-normal">(optional)</span></label><input id="co-cname" value={contactName} onChange={(e) => setContactName(e.target.value)} className={field} /></div>
            <div><label htmlFor="co-email" className={label}>Email <span className="font-normal">(optional)</span></label><input id="co-email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className={field} /></div>
            <div><label htmlFor="co-phone" className={label}>Phone <span className="font-normal">(optional)</span></label><input id="co-phone" type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} className={field} /></div>
          </div>
          <div><label htmlFor="co-notes" className={label}>Notes <span className="font-normal">(optional)</span></label><textarea id="co-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${field} h-auto py-2 resize-y`} /></div>
          {error && (
            <p role="alert" className="relative pl-3 text-[13px] font-semibold text-[var(--color-text)]">
              <span aria-hidden className="absolute left-0 inset-y-0 w-[3px] bg-[var(--state-overdue)]" />{error}
            </p>
          )}
        </ModalBody>
        <ModalFooter>
          <button type="button" onClick={onClose} disabled={busy} className={heroQuiet}>Cancel</button>
          <button type="submit" disabled={busy || !name.trim()} className={heroPrimary}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Add company
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
