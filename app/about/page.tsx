// app/about/page.tsx: the public front door.
//
// Drawn like the app itself: a calm grey panel, white sheets where data
// sits, graphite type, and the signal color only on what you can do. It
// leads with the most characteristic thing in this world, a drawing
// register in the app's own table style (static example rows written in
// plain refinery terms), and stays restrained after that: ruled tables
// and short lines, no colored slabs.
//
// Compliance language stays honest: we support the documentation; we are
// not a certifier.

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PublicNav, PublicFooter } from "@/components/marketing/PublicChrome";
import { Reveal } from "@/components/marketing/Reveal";
import { ChipCloud } from "@/components/marketing/ChipCloud";
import { RoleDayTabs } from "@/components/marketing/RoleDayTabs";
import { TourTabs } from "@/components/marketing/TourTabs";
import { btnPrimary, btnQuiet, link, tbl, StatusTag, RowEdge, type Tone } from "@/components/admin/kit";

export const metadata = {
  title: "Manufacturing OS - Document control your facility can audit",
  description:
    "Document control, drafting workflow, AI that has read your library, and a living map of your site - for any facility that runs on drawings. Designed to support OSHA PSM 1910.119 and ISO 9001 documentation, with a one-click export of every byte you put in. No lock-in, ever.",
};

export const revalidate = 86400;

const wrap = "max-w-[1200px] mx-auto px-4 sm:px-6";
const sectionGap = "pt-16 sm:pt-24 scroll-mt-16";

function SectionHead({ kicker, title, line, id }: { kicker: string; title: string; line?: React.ReactNode; id?: string }) {
  return (
    <div className="max-w-3xl">
      <div className="text-body font-medium text-[var(--color-text-muted)]">{kicker}</div>
      <h2 id={id} className="mt-1 font-display text-[28px] sm:text-[36px] leading-[1.08] font-semibold tracking-[-0.01em] text-[var(--color-text)]">{title}</h2>
      {line && <p className="mt-2 text-reading leading-snug text-[var(--color-text-muted)]">{line}</p>}
    </div>
  );
}

export default function MarketingPage() {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] text-[var(--color-text)]">
      {/* No JS (crawlers, blocked chunks): reveal everything. A blank front
          door is worse than an unanimated one. */}
      <noscript><style>{"[data-reveal]{opacity:1 !important}"}</style></noscript>
      <PublicNav />
      <main>
        <Hero />
        <DaySection />
        <PillarsSection />
        <TourSection />
        <TrustSection />
        <ComplianceHonestySection />
        <SecuritySection />
        <AudienceSection />
        <FinalCta />
      </main>
      <PublicFooter />
    </div>
  );
}

// ─── Hero: the answer, then the register ────────────────────────────────────

type RegisterRow = { no: string; title: string; rev: string; status: string; tone: Tone; issued: string; note?: string; edge?: "bad" | "warn" };

// Example content, written the way a hydrotreater's register reads.
const REGISTER: RegisterRow[] = [
  { no: "25-PFD-0001", title: "Process flow diagram, Unit 25 diesel hydrotreater", rev: "6", status: "Issued", tone: "good", issued: "Jul 22" },
  { no: "25-PID-2501", title: "P&ID, reactor feed pumps P-2501A/B and charge heater H-2501", rev: "7", status: "Issued", tone: "good", issued: "Oct 14" },
  { no: "25-PID-2502", title: "P&ID, reactor R-2501 and effluent exchangers E-2502A-D", rev: "5", status: "In review", tone: "warn", issued: "Sep 3", note: "Waiting on engineer sign-off", edge: "warn" },
  { no: "25-PID-2503", title: "P&ID, high-pressure separator V-2503 and recycle gas", rev: "4", status: "Checked out", tone: "none", issued: "Sep 30", note: "Drafting has it, since 9:40 AM" },
  { no: "25-ISO-1402", title: "Iso, 6\" feed line, P-2501A/B discharge to E-2501", rev: "2", status: "Markup late", tone: "bad", issued: "Jun 11", note: "Due Nov 12, 8 days late", edge: "bad" },
  { no: "25-PID-2505", title: "P&ID, product stripper T-2505 overhead and reflux", rev: "3", status: "Issued", tone: "good", issued: "Aug 6" },
];

function Hero() {
  const promises = [
    { title: "No lock-in, ever", body: "Your whole dataset in standard formats, one click.", href: "#trust" },
    { title: "Your AI, your key", body: "Runs on your provider key. Never trains anyone's model.", href: "#capabilities" },
    { title: "Honest compliance", body: "We support the paperwork. We don't sell certification.", href: "#honesty" },
    { title: "Everything on the record", body: "Sign-ins, downloads and approvals in a log nothing can edit.", href: "#security" },
  ];
  return (
    <section className={`${wrap}`}>
      {/* The hero sits on the brand band, edge to edge; the one accent
          button is where the eye lands. */}
      <div className="page-head bg-[var(--color-band)] [box-shadow:0_0_0_100vmax_var(--color-band)] [clip-path:inset(0_-100vmax)] py-10 sm:py-14 flex flex-wrap items-end gap-x-10 gap-y-6">
        <div className="min-w-0 flex-1 basis-[520px]">
          <div className="text-body font-medium text-[var(--color-text-muted)]">For refineries and plants that run on drawings</div>
          <h1 className="mt-2 font-display text-[40px] sm:text-[56px] leading-[1.02] font-semibold tracking-[-0.015em] text-[var(--color-text)]">
            Know which revision is current.
          </h1>
          <p className="mt-3 text-reading sm:text-section leading-snug text-[var(--color-text-muted)] max-w-2xl">
            Drawings, revisions and change requests in one register, with a record of who signed. Designed to support OSHA PSM 1910.119 and ISO 9001 documentation.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/signup" className={`${btnPrimary} h-11 px-5`}>Start a workspace <ArrowRight className="w-4 h-4" /></Link>
          <a href="#tour" className={`${btnQuiet} h-11 px-4 text-reading`}>See it in action</a>
        </div>
      </div>

      {/* The one bold element: the register, as the app draws it. */}
      <div className="mt-8" style={{ animation: "rise 0.6s var(--ease-fluid) 120ms both" }}>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1 mb-2.5">
          <h2 className="font-display text-section font-semibold text-[var(--color-text)]">Unit 25 diesel hydrotreater, drawing register</h2>
          <span className="text-body text-[var(--color-text-muted)]">Example</span>
          <div className="flex-1" />
          <dl className="flex gap-5 text-body text-[var(--color-text-muted)]">
            <div className="flex items-baseline gap-1.5"><dt>Late</dt><dd className="font-display text-section font-semibold tabular-nums text-[var(--state-overdue)]">1</dd></div>
            <div className="flex items-baseline gap-1.5"><dt>Waiting on sign-off</dt><dd className="font-display text-section font-semibold tabular-nums text-[var(--state-held)]">1</dd></div>
            <div className="flex items-baseline gap-1.5"><dt>Issued</dt><dd className="font-display text-section font-semibold tabular-nums text-[var(--color-text)]">3</dd></div>
          </dl>
        </div>
        <div className={tbl.wrap}>
          <table className={`${tbl.table} max-sm:hidden`}>
            <caption className="sr-only">Example drawing register for Unit 25</caption>
            <thead className={tbl.thead}>
              <tr>
                <th className={tbl.th}>Drawing</th>
                <th className={tbl.th}>Title</th>
                <th className={`${tbl.th} text-right`}>Rev</th>
                <th className={tbl.th}>Status</th>
                <th className={`${tbl.th} max-lg:hidden`}>Issued</th>
                <th className={`${tbl.th} max-md:hidden`}>Now</th>
              </tr>
            </thead>
            <tbody className={tbl.tbody}>
              {REGISTER.map((r) => (
                <tr key={r.no}>
                  <td className={`${tbl.td} relative whitespace-nowrap`}>
                    {r.edge && <RowEdge tone={r.edge} />}
                    <span className="font-display text-reading font-semibold tabular-nums text-[var(--color-text)]">{r.no}</span>
                  </td>
                  <td className={`${tbl.td} text-[var(--color-text)]`}>{r.title}</td>
                  <td className={`${tbl.td} text-right font-display text-reading font-semibold tabular-nums`}>{r.rev}</td>
                  <td className={tbl.td}><StatusTag tone={r.tone} colored={r.tone === "bad"}>{r.status}</StatusTag></td>
                  <td className={`${tbl.td} max-lg:hidden whitespace-nowrap text-[var(--color-text-muted)]`}>{r.issued}</td>
                  <td className={`${tbl.td} max-md:hidden text-body ${r.tone === "bad" ? "font-medium text-[var(--state-overdue)]" : "text-[var(--color-text-muted)]"}`}>{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* On a phone: the number and status, then the title and rev. */}
          <ul className="sm:hidden divide-y divide-[var(--color-border)]">
            {REGISTER.map((r) => (
              <li key={r.no} className="relative px-4 py-3">
                {r.edge && <RowEdge tone={r.edge} />}
                <div className="flex items-center gap-3">
                  <span className="font-display text-reading font-semibold tabular-nums">{r.no}</span>
                  <span className="text-body text-[var(--color-text-muted)]">Rev {r.rev}</span>
                  <span className="ml-auto"><StatusTag tone={r.tone} colored={r.tone === "bad"}>{r.status}</StatusTag></span>
                </div>
                <div className="mt-0.5 text-body text-[var(--color-text-muted)] leading-snug">{r.note ?? r.title}</div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* The four commitments, as ruled cells. */}
      <h2 className="sr-only">Our commitments</h2>
      <ul className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border-t border-[var(--color-border-strong)]">
        {promises.map((p, i) => (
          <li key={p.title} className={`py-4 sm:pr-5 border-b border-[var(--color-border)] lg:border-b-0 ${i > 0 ? "lg:pl-5 lg:border-l lg:border-[var(--color-border-strong)]" : ""} ${i % 2 === 1 ? "sm:pl-5 sm:border-l sm:border-[var(--color-border-strong)]" : ""}`}>
            <a href={p.href} className="group block">
              <span className="font-display text-section font-semibold text-[var(--color-text)] group-hover:text-[var(--color-accent-text)]">{p.title}</span>
              <span className="block mt-0.5 text-body leading-snug text-[var(--color-text-muted)]">{p.body}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Your day, easier ───────────────────────────────────────────────────────

function DaySection() {
  return (
    <section id="day" className={`${wrap} ${sectionGap}`}>
      <SectionHead kicker="Your day" title="Pick your job. See what changes." />
      <Reveal className="mt-6">
        <RoleDayTabs />
      </Reveal>
    </section>
  );
}

// ─── The six pillars, in business order ─────────────────────────────────────

const PILLARS: Array<{ title: string; line: string; chips: string[] }> = [
  {
    title: "One source of truth for every document",
    line: "One current revision per drawing, and the only one anyone can print.",
    chips: [
      "Revision history & compare", "Supersession marking", "Status-stamped PDFs",
      "Checkout locks (quick holds release in 24 h)", "Who's editing now", "Metadata-first bulk upload",
      "AI title-block reading", "Automatic numbering", "Short links (/d/DOC-001)",
      "Your own columns and terms", "Saved views & favorites", "Playbooks",
      "Library subscriptions", "Stale-copy recall", "Where-used impact", "Full-text search",
    ],
  },
  {
    title: "An AI that has read your library",
    line: "Ask in plain words. The answer cites the exact page, and only documents you gave it.",
    chips: [
      "Your own AI key", "Page-cited answers", "Highlighted proof",
      "Reads scans", "Equipment tag extraction", "Drawing census & reference check",
      "Line tracing on drawings", "Search by meaning", "Your playbooks in every answer",
      "Shareable AI skills", "Answer-to-graph shaping (admins)", "Per-user caps & metering",
      "Per-document AI exclusion", "Access-aware sources", "An assistant that knows the app",
    ],
  },
  {
    title: "Workflow with authority built in",
    line: "Requests route through drafting and engineer approval. A non-engineer can't sign engineering work.",
    chips: [
      "MOC / RFI / As-built / Inspection requests", "Engineer-routed sign-off", "Redline markup",
      "Revision request loops", "Deliverable rev ladder (1A, 1, 2A, 2)", "Target dates & past-due flags",
      "Work packages", "Acknowledged distribution", "Transmittals + recipient portal",
      "Tokened intake portal", "Contractor redline round-trip", "Legacy transition wizard",
      "Scheduler", "Cost tracking", "Projects with scoped membership",
    ],
  },
  {
    title: "A living map of your site",
    line: "Teach it your numbering once. Drawings, equipment and units become one map.",
    chips: [
      "Site codebook (your numbering, taught once)", "Operating areas", "Equipment registry & photos",
      "Auto-filing from tags & site codes", "Process flow map (drawn or AI-read)",
      "Plot plans with placed markers", "2D/3D graph", "Process / equipment / document lenses",
      "Path between any two items", "Per-tag backlinks", "Guided facility setup",
    ],
  },
  {
    title: "The paper-to-plant bridge",
    line: "Every print carries a QR code that answers one question: is this still current?",
    chips: [
      "QR-stamped prints", "Public check pages (documents, holds, packages, requests)",
      "Equipment labels", "Hold cards with live status", "Request traveler sheets",
      "Print packs with QR covers", "Continue on phone", "Scan-landing quick actions",
    ],
  },
  {
    title: "A team that stays in sync",
    line: "Mentions, watching and live dashboards replace the reply-all thread.",
    chips: [
      "@-mentions with notifications", "Watch documents / requests / libraries",
      "Email + in-app delivery", "Per-person notification settings", "Recently viewed",
      "Personal desk", "Live dashboards", "Command palette with the app's map",
    ],
  },
];

function PillarsSection() {
  return (
    <section id="capabilities" className={`${wrap} ${sectionGap}`}>
      <SectionHead kicker="What's inside" title="Six parts, in the order they matter." />
      <Reveal className="mt-6">
        <ol className={`${tbl.wrap} divide-y divide-[var(--color-border)]`}>
          {PILLARS.map((p, i) => (
            <li key={p.title} className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-x-8 gap-y-3 px-4 sm:px-5 py-5">
              <div className="flex gap-3 min-w-0">
                <span className="font-display text-section font-semibold tabular-nums text-[var(--color-text-faint)] w-5 shrink-0">{i + 1}</span>
                <div className="min-w-0">
                  <h3 className="font-display text-section leading-tight font-semibold text-[var(--color-text)]">{p.title}</h3>
                  <p className="mt-1 text-reading leading-snug text-[var(--color-text-muted)]">{p.line}</p>
                </div>
              </div>
              <div className="min-w-0 max-lg:pl-8">
                <ChipCloud chips={p.chips} />
              </div>
            </li>
          ))}
        </ol>
      </Reveal>
    </section>
  );
}

// ─── The tour ───────────────────────────────────────────────────────────────

function TourSection() {
  return (
    <section id="tour" className={`${wrap} ${sectionGap}`}>
      <TourTabs header={
        <SectionHead kicker="See it in action" title="Six stations, one screen."
          line="The live app's own look, with example data. Click around." />
      } />
    </section>
  );
}

// ─── Trust: no lock-in ──────────────────────────────────────────────────────

function TrustSection() {
  const paths = [
    { title: "Direct download", body: "One click: a JSON file with every record and 24-hour links to every file, or one ZIP with the files inside." },
    { title: "Scheduled push", body: "A fresh export lands in your own S3 or R2 bucket daily, weekly or monthly. Credentials encrypted with AES-256-GCM." },
    { title: "Webhook delivery", body: "An HMAC-signed POST of the ZIP to your endpoint, for your own pipeline or data lake." },
  ];
  const files = ["/manifest.json", "/README.md", "/schema/schema.sql", "/tables/*.json", "/files/<storage-path>"];
  return (
    <section id="trust" className={`${wrap} ${sectionGap}`}>
      <SectionHead kicker="Your data" title="No lock-in. Not now, not ever."
        line="Three ways off the platform. Any admin can use them, any time, with no ticket and no fee." />
      <Reveal className="mt-6">
        <div className={tbl.wrap}>
          <table className={tbl.table}>
            <thead className={`${tbl.thead} max-sm:hidden`}>
              <tr><th className={`${tbl.th} w-[220px]`}>Way out</th><th className={tbl.th}>How it works</th></tr>
            </thead>
            <tbody className={tbl.tbody}>
              {paths.map((p, i) => (
                <tr key={p.title} className="max-sm:flex max-sm:flex-col max-sm:py-2">
                  <td className={`${tbl.td} max-sm:py-1 font-medium whitespace-nowrap`}><span className="font-display tabular-nums text-[var(--color-text-faint)] mr-2">{i + 1}</span>{p.title}</td>
                  <td className={`${tbl.td} max-sm:py-1 text-[var(--color-text-muted)]`}>{p.body}</td>
                </tr>
              ))}
              <tr className="max-sm:flex max-sm:flex-col max-sm:py-2">
                <td className={`${tbl.td} max-sm:py-1 font-medium align-top`}>What&apos;s in the ZIP</td>
                <td className={`${tbl.td} max-sm:py-1`}>
                  <div className="flex flex-wrap gap-1.5">
                    {files.map((f) => (
                      <code key={f} className="inline-flex items-center h-8 px-2 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-body font-mono text-[var(--color-text)]">{f}</code>
                    ))}
                  </div>
                  <p className="mt-2 text-body text-[var(--color-text-muted)]">
                    Enough to rebuild from scratch on any Postgres.{" "}
                    <Link href="/data-portability" className={link}>Read the full commitment</Link>
                  </p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Reveal>
    </section>
  );
}

// ─── Compliance, honestly ───────────────────────────────────────────────────

const SUPPORT: Array<[string, string]> = [
  ["Document control", "Revision history, current-versus-superseded and status stamping (ISO 9001 §7.5, OSHA PSM §(d))."],
  ["Management of Change", "A dedicated MOC request with engineer-routed sign-off (OSHA PSM §(l))."],
  ["An audit trail nothing can edit", "Sign-ins, downloads, approvals and status changes, exportable as evidence."],
  ["Approval by a qualified engineer", "Requesters who aren't engineers can't approve engineering work."],
  ["Data you own", "Full export any time, in standard formats."],
];
const YOURS: Array<[string, string]> = [
  ["Certification", "ISO 9001 certification and PSM audits are done by independent third parties."],
  ["Process hazard analysis", "Your safety team runs the HAZOPs (PSM §(e)). We store the results."],
  ["Mechanical integrity", "PM schedules, inspections and RBI stay in your CMMS."],
  ["Training and competency", "Training records live in your HR or learning system."],
  ["Procedures, incidents, emergency plans", "PSM §(f), §(m), §(n). We store the documents; your team owns them."],
];

function HonestyList({ heading, tone, rows }: { heading: string; tone: Tone; rows: Array<[string, string]> }) {
  return (
    <div className="min-w-0">
      <div className="px-4 sm:px-5 h-11 flex items-center bg-[var(--color-surface-2)] border-b border-[var(--color-border)]">
        <StatusTag tone={tone}>{heading}</StatusTag>
      </div>
      <ul className="divide-y divide-[var(--color-border)]">
        {rows.map(([t, b]) => (
          <li key={t} className="px-4 sm:px-5 py-3">
            <div className="text-reading font-medium text-[var(--color-text)]">{t}</div>
            <div className="mt-0.5 text-body leading-snug text-[var(--color-text-muted)]">{b}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ComplianceHonestySection() {
  return (
    <section id="honesty" className={`${wrap} ${sectionGap}`}>
      <SectionHead kicker="Compliance" title="What we are, and what we aren't."
        line="Software that supports compliance documentation. It doesn't certify you; your PSM lead still owns the program." />
      <Reveal className="mt-6">
        <div className={`${tbl.wrap} grid grid-cols-1 md:grid-cols-2 md:divide-x divide-[var(--color-border)] max-md:divide-y`}>
          <HonestyList heading="What we support" tone="good" rows={SUPPORT} />
          <HonestyList heading="What stays yours" tone="none" rows={YOURS} />
        </div>
      </Reveal>
    </section>
  );
}

// ─── Security ───────────────────────────────────────────────────────────────

function SecuritySection() {
  const items: Array<[string, string]> = [
    ["HTTPS only", "All traffic over TLS. No plain-HTTP fallback."],
    ["Encrypted at rest", "The database by Supabase, file storage by Cloudflare R2."],
    ["Row-level isolation", "Postgres row-level security scopes every query to its organization."],
    ["AES-256-GCM for secrets", "S3 credentials and personal AI keys are never stored in the clear."],
    ["Roles and per-item access", "Eighteen roles, plus access rules on libraries, folders and documents."],
    ["Signing that proves it's you", "Approvals that matter ask you to sign in again at the moment of signing."],
    ["Authority your admins set", "What each role may approve, issue, hold or export, enforced on the server."],
    ["An AI with a fence", "It reads only what the person asking may read. Excluded documents are never cited."],
    ["Privileged work stays on the server", "Server routes re-check membership and role on every call; exports log themselves."],
  ];
  return (
    <section id="security" className={`${wrap} ${sectionGap}`}>
      <SectionHead kicker="Security" title="What your IT auditor will ask about." line="The specific controls, named." />
      <Reveal className="mt-6">
        <div className={tbl.wrap}>
          <table className={tbl.table}>
            <thead className={`${tbl.thead} max-sm:hidden`}>
              <tr><th className={`${tbl.th} w-[300px]`}>Control</th><th className={tbl.th}>What it means</th></tr>
            </thead>
            <tbody className={tbl.tbody}>
              {items.map(([t, b]) => (
                <tr key={t} className="max-sm:flex max-sm:flex-col max-sm:py-2">
                  <td className={`${tbl.td} max-sm:py-0.5 font-medium`}>{t}</td>
                  <td className={`${tbl.td} max-sm:py-0.5 text-[var(--color-text-muted)]`}>{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>
    </section>
  );
}

// ─── Who it's for ───────────────────────────────────────────────────────────

function AudienceSection() {
  const who: Array<[string, string]> = [
    ["Process industries", "Refineries, chemical plants, power, water. MOC records and a revision trail that survives audits."],
    ["Manufacturing and batch plants", "Mills, food and beverage, pharma. The drawings, procedures and change records ISO 9001 asks about."],
    ["EPC and engineering teams", "Projects scope work per client. Contractors submit through a tokened portal and never see the rest of your library."],
  ];
  return (
    <section className={`${wrap} ${sectionGap}`}>
      <SectionHead kicker="Who runs on it" title="Built for sites where the drawings matter." />
      <Reveal className="mt-6">
        <ul className="grid grid-cols-1 md:grid-cols-3 border-t border-[var(--color-border-strong)]">
          {who.map(([t, b], i) => (
            <li key={t} className={`py-4 md:pr-6 max-md:border-b border-[var(--color-border)] ${i > 0 ? "md:pl-6 md:border-l md:border-[var(--color-border-strong)]" : ""}`}>
              <h3 className="font-display text-section font-semibold text-[var(--color-text)]">{t}</h3>
              <p className="mt-1 text-reading leading-snug text-[var(--color-text-muted)]">{b}</p>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  );
}

// ─── The last word ──────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section className={`${wrap} pt-16 sm:pt-24 pb-16 sm:pb-24`}>
      <div className="pt-8 border-t border-[var(--color-border-strong)] flex flex-wrap items-end gap-x-10 gap-y-5">
        <div className="min-w-0 flex-1 basis-[420px]">
          <h2 className="font-display text-[28px] sm:text-[36px] leading-[1.08] font-semibold text-[var(--color-text)]">Stop running your plant off a shared drive.</h2>
          <p className="mt-2 text-reading text-[var(--color-text-muted)]">Set up a workspace and bring in your drawings. The day you leave, you take everything with you.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/signup" className={`${btnPrimary} h-11 px-5`}>Create your workspace <ArrowRight className="w-4 h-4" /></Link>
          <Link href="/" className={`${btnQuiet} h-11 px-4 text-reading`}>Sign in</Link>
        </div>
      </div>
    </section>
  );
}
