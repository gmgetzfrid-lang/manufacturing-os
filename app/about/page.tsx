// app/about/page.tsx: the public front door.
//
// Same identity as the app: charcoal and royal blue cover the big areas,
// orange only on the call to action. Each section has ONE huge headline and
// everything else is small (15 px body, 11 px labels). Depth in three layers:
// a band at the back, white cards overlapping its bottom edge, the orange
// action raised on top.
//
// Story order is deliberate: the promise and the policy (no lock-in, honest
// compliance), then the PERSON (their day, before and after), then the six
// pillars in business order, a tour of the real screens, and trust,
// compliance and security to close.
//
// Facility-agnostic on purpose: refineries, chemical, food and beverage,
// pharma, power, mills. Compliance language stays honest: we support the
// documentation; we are not a certifier.

import Link from "next/link";
import {
  Layout, ShieldCheck, FileCheck2, GitBranch, Database, Workflow, Users,
  Lock, Server, ArrowRight, Check, KeyRound, Factory, Wrench,
  ClipboardCheck, Download, XCircle, CheckCircle2, Webhook,
  FileArchive, Sparkles, Map as MapIcon, QrCode, AtSign, PenLine,
} from "lucide-react";
import { Reveal, RotatingWord } from "@/components/marketing/Reveal";
import { ChipCloud } from "@/components/marketing/ChipCloud";
import { RoleDayTabs } from "@/components/marketing/RoleDayTabs";
import { TourTabs } from "@/components/marketing/TourTabs";

export const metadata = {
  title: "Manufacturing OS - Document control your facility can audit",
  description:
    "Document control, drafting workflow, AI that has read your library, and a living map of your site - for any facility that runs on drawings. Designed to support OSHA PSM 1910.119 and ISO 9001 documentation, with a one-click export of every byte you put in. No lock-in, ever.",
};

export const revalidate = 86400;

// ─── The few pieces every section shares ────────────────────────────────────

/** The one orange action (only on calls to action). */
const cta =
  "inline-flex items-center justify-center gap-2 h-12 px-6 rounded-xl bg-[var(--color-accent)] text-[var(--color-accent-fg)] text-[15px] font-extrabold hover:bg-[var(--color-accent-hover)] shadow-[0_14px_28px_-12px_var(--color-accent)] transition-colors";
/** A quiet button on the blue band. */
const quietOnBand =
  "inline-flex items-center justify-center gap-2 h-12 px-5 rounded-xl border border-[var(--color-ink-line)] bg-[var(--color-ink-2)] text-white text-[15px] font-bold hover:bg-[var(--color-ink-line)] transition-colors";
/** A quiet button on paper or a card. */
const quietOnPaper =
  "inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)] text-[14px] font-bold hover:border-[var(--color-text-muted)] transition-colors";
/** The one huge line of a section. */
const huge = "text-[36px] sm:text-[48px] lg:text-[60px] leading-[1.02] font-black tracking-[-0.035em]";
/** Small all-caps label. */
const label = "text-[13px] font-semibold ";
/** A white card on the paper: soft depth, no outline. */
const card = "rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-card)]";
const wrap = "max-w-[1200px] mx-auto px-4 sm:px-6";

function SectionHead({ kicker, title, children, onDark = false }: {
  kicker: string; title: React.ReactNode; children?: React.ReactNode; onDark?: boolean;
}) {
  return (
    <Reveal className="max-w-3xl">
      <div className={`${label} ${onDark ? "text-[var(--color-ink-muted)]" : "text-[var(--color-text-muted)]"}`}>{kicker}</div>
      <h2 className={`mt-4 ${huge} ${onDark ? "text-white" : "text-[var(--color-text)]"}`}>{title}</h2>
      {children && (
        <p className={`mt-5 text-[15px] sm:text-[16px] leading-relaxed max-w-2xl ${onDark ? "text-[var(--color-ink-text)]" : "text-[var(--color-text-muted)]"}`}>
          {children}
        </p>
      )}
    </Reveal>
  );
}

function IconTile({ children }: { children: React.ReactNode }) {
  return <div className="w-10 h-10 rounded-xl bg-[var(--color-surface-2)] text-[var(--color-text)] grid place-items-center shrink-0">{children}</div>;
}

export default function MarketingPage() {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] text-[var(--color-text)]">
      {/* No JS (crawlers, blocked chunks): reveal everything. A blank front
          door is worse than an unanimated one. */}
      <noscript><style>{"[data-reveal]{opacity:1 !important}"}</style></noscript>
      <Nav />
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
      <Footer />
    </div>
  );
}

// ─── Nav ────────────────────────────────────────────────────────────────────

function Logo({ onDark = false }: { onDark?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className={`w-8 h-8 rounded-lg grid place-items-center ${onDark ? "bg-white text-[var(--color-ink)]" : "bg-[var(--color-ink)] text-white"}`}>
        <Layout className="w-4 h-4" />
      </span>
      <span className={`whitespace-nowrap text-[15px] font-black tracking-tight ${onDark ? "text-white" : "text-[var(--color-text)]"}`}>Manufacturing OS</span>
    </span>
  );
}

function Nav() {
  const links = [
    ["#day", "Your day"], ["#capabilities", "What's inside"], ["#tour", "See it"],
    ["#trust", "Your data"], ["#honesty", "Compliance"], ["#security", "Security"],
  ];
  return (
    <header className="sticky top-0 z-50 bg-[color-mix(in_srgb,var(--color-canvas)_88%,transparent)] backdrop-blur border-b border-[var(--color-border)]">
      <div className={`${wrap} h-16 flex items-center gap-6`}>
        <Link href="/about" aria-label="Manufacturing OS home"><Logo /></Link>
        <nav aria-label="Sections" className="hidden lg:flex items-center gap-5 text-[14px] font-semibold text-[var(--color-text-muted)]">
          {links.map(([href, text]) => <a key={href} href={href} className="hover:text-[var(--color-text)]">{text}</a>)}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <Link href="/" className="h-10 px-3 inline-flex items-center whitespace-nowrap text-[14px] font-bold text-[var(--color-text)] hover:underline underline-offset-4">
            Sign in
          </Link>
          <Link href="/signup"
            className="max-sm:hidden h-10 px-4 inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl bg-[var(--color-ink)] text-white text-[14px] font-bold hover:opacity-90 transition-opacity">
            Get started <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
    </header>
  );
}

// ─── Hero: the blue band, the promises overlapping it ───────────────────────

function Hero() {
  const keeps = ["Full export, any time", "Your own AI key", "Public schema, no lock-in", "Encrypted at rest"];
  const promises = [
    { icon: <ShieldCheck className="w-5 h-5" />, title: "No lock-in, ever", body: "Three self-serve ways out. Your whole dataset in standard formats, one click.", href: "#trust" },
    { icon: <KeyRound className="w-5 h-5" />, title: "Your AI, your key", body: "The AI runs on your own provider key with per-user caps. Your documents never train anyone's model.", href: "#capabilities" },
    { icon: <ClipboardCheck className="w-5 h-5" />, title: "Honest compliance", body: "We support the documentation. We don't sell certification, and we draw the line plainly.", href: "#honesty" },
    { icon: <FileCheck2 className="w-5 h-5" />, title: "Everything on the record", body: "Every sign-in, download, approval and export in a log nothing can edit, ready for an auditor.", href: "#security" },
  ];
  return (
    <section className={`${wrap} pt-4 sm:pt-6`}>
      <div className="rounded-[28px] bg-[var(--color-band)] text-white px-5 sm:px-10 lg:px-14 pt-10 sm:pt-16 pb-36 sm:pb-40">
        <div className="grid lg:grid-cols-[1fr_300px] gap-x-12 gap-y-10 items-end">
          <div className="min-w-0">
            <div className={`${label} text-[var(--color-ink-muted)]`} style={{ animation: "rise 0.6s var(--ease-fluid) both" }}>
              For every facility that runs on drawings
            </div>
            {/* Room for three lines, so the words below don't jump as the
                facility word changes length. */}
            <h1 className="mt-5 min-h-[3lh] text-[42px] sm:text-[64px] lg:text-[84px] leading-[0.98] font-black tracking-[-0.04em]"
              style={{ animation: "rise 0.6s var(--ease-fluid) 80ms both" }}>
              Your{" "}
              <RotatingWord
                words={["refinery", "chemical plant", "mill", "food plant", "pharma site", "power station", "facility"]}
              />
              <br />in one system.
            </h1>
            <p className="mt-6 text-[16px] sm:text-[17px] leading-relaxed text-[var(--color-ink-text)] max-w-2xl"
              style={{ animation: "rise 0.6s var(--ease-fluid) 160ms both" }}>
              One place for your drawings, revisions and requests, plus an AI that has actually read them.
              Designed to support OSHA PSM 1910.119 and ISO 9001 documentation. You own every byte.
            </p>
            <div className="mt-8 flex flex-wrap gap-3" style={{ animation: "rise 0.6s var(--ease-fluid) 240ms both" }}>
              <Link href="/signup" className={cta}>Start a workspace <ArrowRight className="w-4 h-4" /></Link>
              <a href="#tour" className={quietOnBand}>See it in action</a>
            </div>
          </div>
          <ul className="border-t border-[var(--color-ink-line)] lg:mb-1" style={{ animation: "rise 0.6s var(--ease-fluid) 320ms both" }}>
            {keeps.map((k) => (
              <li key={k} className="flex items-center gap-2.5 py-3 border-b border-[var(--color-ink-line)] text-[14px] font-semibold text-white">
                <Check className="w-4 h-4 shrink-0 text-[var(--color-ink-muted)]" /> {k}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <h2 className="sr-only">Our commitments</h2>
      <div className="relative -mt-24 sm:-mt-28 px-2 sm:px-6 lg:px-10 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {promises.map((p, i) => (
          <Reveal key={p.title} delay={i * 80}>
            <a href={p.href} className={`${card} group block h-full p-5 hover:-translate-y-0.5 transition-transform`}>
              <IconTile>{p.icon}</IconTile>
              <h3 className="mt-4 text-[15px] font-extrabold text-[var(--color-text)]">{p.title}</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--color-text-muted)]">{p.body}</p>
            </a>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ─── Your day, easier ───────────────────────────────────────────────────────

function DaySection() {
  return (
    <section id="day" className={`${wrap} pt-24 sm:pt-32 scroll-mt-16`}>
      <SectionHead kicker="Your day, easier" title="Pick your job. Watch it get lighter.">
        Your team lives in moments: the fifth &quot;FINAL_rev3&quot; PDF, the audit question nobody can
        answer, the walk across site to see a vessel. Here is what those moments become.
      </SectionHead>
      <Reveal delay={100} className="mt-10">
        <RoleDayTabs />
      </Reveal>
    </section>
  );
}

// ─── The six pillars, in business order ─────────────────────────────────────

function Pillar({ n, icon, title, tagline, bullets, chips, delay = 0 }: {
  n: number; icon: React.ReactNode; title: string; tagline: string;
  bullets: string[]; chips: string[]; delay?: number;
}) {
  return (
    <Reveal delay={delay}>
      <article className={`${card} h-full p-6 sm:p-7 flex flex-col`}>
        <div className="flex items-center gap-3">
          <IconTile>{icon}</IconTile>
          <div className="min-w-0">
            <div className={`${label} text-[var(--color-text-muted)]`}>Pillar {n}</div>
            <h3 className="mt-0.5 text-[15px] font-extrabold text-[var(--color-text)]">{title}</h3>
          </div>
        </div>
        <p className="mt-4 text-[15px] leading-relaxed text-[var(--color-text)]">{tagline}</p>
        <ul className="mt-4 space-y-2.5">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-2.5 text-[14px] leading-relaxed text-[var(--color-text-muted)]">
              <Check className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-text)]" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
        <div className="mt-auto pt-5">
          <div className="pt-4 border-t border-[var(--color-border)]">
            <div className={`${label} text-[var(--color-text-muted)] mb-2.5`}>Everything inside</div>
            <ChipCloud chips={chips} />
          </div>
        </div>
      </article>
    </Reveal>
  );
}

function PillarsSection() {
  return (
    <section id="capabilities" className={`${wrap} pt-24 sm:pt-32 scroll-mt-16`}>
      <SectionHead kicker="What's inside" title="Six pillars, in the order they matter.">
        Each one is deep: open &quot;Show more&quot; on any pillar for the full list. None of it assumes
        what your facility makes.
      </SectionHead>
      <div className="mt-10 grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
        <Pillar n={1} icon={<FileCheck2 className="w-5 h-5" />}
          title="One source of truth for every document"
          tagline="The current revision is plain, provable, and the only one anyone can print. That one fact ends most of the chaos."
          bullets={[
            "Full revision history. Superseded copies are marked and recalled from everyone who downloaded them.",
            "Every issued PDF is stamped with its status and a QR code anyone can check by phone.",
            "Bulk-import old files: details read from file names, AI reads the title blocks, you confirm one grid.",
          ]}
          chips={[
            "Revision history & compare", "Supersession marking", "Status-stamped PDFs",
            "Checkout locks (quick holds release in 24 h)", "Who's editing now", "Metadata-first bulk upload",
            "AI title-block reading", "Automatic numbering", "Short links (/d/DOC-001)",
            "Your own columns and terms", "Saved views & favorites", "Playbooks",
            "Library subscriptions", "Stale-copy recall", "Where-used impact", "Full-text search",
          ]} />
        <Pillar n={2} icon={<Sparkles className="w-5 h-5" />} delay={80}
          title="An AI that has read your library"
          tagline="Ask in plain words. The answer comes back cited to the exact page, with the proof one click away. It can only cite documents you gave it."
          bullets={[
            "Reads scanned and CAD-exported drawings: pulls equipment tags, checks cross-references, traces lines.",
            "Runs on your own AI key (Claude or OpenAI, providers that don't train on your data) with per-user spend caps.",
            "You draw the line: keep any document out of AI reading with one switch. Access rules carry over from document control.",
          ]}
          chips={[
            "Your own AI key", "Page-cited answers", "Highlighted proof",
            "Reads scans", "Equipment tag extraction", "Drawing census & reference check",
            "Line tracing on drawings", "Search by meaning", "Your playbooks in every answer",
            "Shareable AI skills", "Answer-to-graph shaping (admins)", "Per-user caps & metering",
            "Per-document AI exclusion", "Access-aware sources", "An assistant that knows the app",
          ]} />
        <Pillar n={3} icon={<Workflow className="w-5 h-5" />} delay={80}
          title="Workflow with authority built in"
          tagline="Requests route through review, drafting and approval, and the system enforces who may sign. A non-engineer cannot approve engineering work."
          bullets={[
            "MOC, RFI, as-built and inspection requests with target dates, so nothing goes quietly late.",
            "Distribution that proves receipt: acknowledgments per person, transmittals with a recipient portal.",
            "Outside teams work through a tokened intake portal and scoped projects, never inside your library.",
          ]}
          chips={[
            "MOC / RFI / As-built / Inspection requests", "Engineer-routed sign-off", "Redline markup",
            "Revision request loops", "Deliverable rev ladder (1A, 1, 2A, 2)", "Target dates & past-due flags",
            "Work packages", "Acknowledged distribution", "Transmittals + recipient portal",
            "Tokened intake portal", "Contractor redline round-trip", "Legacy transition wizard",
            "Scheduler", "Cost tracking", "Projects with scoped membership",
          ]} />
        <Pillar n={4} icon={<MapIcon className="w-5 h-5" />} delay={160}
          title="A living map of your site"
          tagline="Teach it your numbering once, and imports file themselves. Documents, equipment and operating areas become one map you can walk."
          bullets={[
            "Equipment registry with dated photos. Tap any tag, anywhere, and see the real thing.",
            "A 2D/3D graph with lenses: process flow, equipment, documents, or everything at once.",
            "The AI reads process flow off your flow diagrams and proposes it for a person to confirm.",
          ]}
          chips={[
            "Site codebook (your numbering, taught once)", "Operating areas", "Equipment registry & photos",
            "Auto-filing from tags & site codes", "Process flow map (drawn or AI-read)",
            "Plot plans with placed markers", "2D/3D graph", "Process / equipment / document lenses",
            "Path between any two items", "Per-tag backlinks", "Guided facility setup",
          ]} />
        <Pillar n={5} icon={<QrCode className="w-5 h-5" />} delay={160}
          title="The paper-to-plant bridge"
          tagline="Paper doesn't leave industrial sites, so every print carries a QR code that answers the one question that matters: is this still current?"
          bullets={[
            "Anyone scans a stamped print and sees current or superseded at once. No login, no app.",
            "Equipment labels, hold cards and job travelers print straight from the system, each with live status.",
            "Start at a workstation, carry on from your phone with one scan.",
          ]}
          chips={[
            "QR-stamped prints", "Public check pages (documents, holds, packages, requests)",
            "Equipment labels", "Hold cards with live status", "Request traveler sheets",
            "Print packs with QR covers", "Continue on phone", "Scan-landing quick actions",
          ]} />
        <Pillar n={6} icon={<AtSign className="w-5 h-5" />} delay={240}
          title="A team that stays in sync"
          tagline="Mentions, watching and dashboards replace the reply-all thread, and a command palette that knows every feature means nobody hunts."
          bullets={[
            "@-mention a teammate and they hear about it in the app and by email, their way.",
            "Watch any document, request or library and hear about every change.",
            "Live dashboards show late work, unacknowledged distributions and the protection record.",
          ]}
          chips={[
            "@-mentions with notifications", "Watch documents / requests / libraries",
            "Email + in-app delivery", "Per-person notification settings", "Recently viewed",
            "Personal desk", "Live dashboards", "Command palette with the app's map",
          ]} />
      </div>
    </section>
  );
}

// ─── The tour: tabs on the band, the screen rising out of it ────────────────

function TourSection() {
  return (
    <section id="tour" className={`${wrap} pt-24 sm:pt-32 scroll-mt-16`}>
      <TourTabs header={
        <SectionHead onDark kicker="See it in action" title="Six stations. One screen.">
          Built with the live app&apos;s own look, with generic industrial data dropped in. Click around.
        </SectionHead>
      } />
    </section>
  );
}

// ─── Trust: no lock-in ──────────────────────────────────────────────────────

function TrustSection() {
  const paths = [
    { icon: <Download className="w-5 h-5" />, title: "1. Direct download", body: "One click. A single JSON file with every record, plus a manifest with 24-hour links to every file. Or one ZIP with the files inside." },
    { icon: <Server className="w-5 h-5" />, title: "2. Scheduled push", body: "Point us at your own S3 or R2 bucket. A fresh export lands there daily, weekly or monthly. Credentials encrypted with AES-256-GCM." },
    { icon: <Webhook className="w-5 h-5" />, title: "3. Webhook delivery", body: "An HMAC-signed POST of the ZIP to your endpoint. Build your own pipeline or pipe it into your data lake." },
  ];
  const files = ["/manifest.json", "/README.md", "/schema/schema.sql", "/tables/*.json", "/files/<storage-path>"];
  return (
    <section id="trust" className={`${wrap} pt-24 sm:pt-32 scroll-mt-16`}>
      <SectionHead kicker="Your data, your choice" title="No lock-in. Not now, not ever.">
        Document control is critical infrastructure. You shouldn&apos;t have to wonder whether an outage or a
        contract dispute costs you years of engineering work. So there are three separate ways off this
        platform, and your admins can use any of them, any time, with no ticket and no fee.
      </SectionHead>
      <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-4">
        {paths.map((p, i) => (
          <Reveal key={p.title} delay={i * 90}>
            <div className={`${card} h-full p-5 sm:p-6`}>
              <IconTile>{p.icon}</IconTile>
              <h3 className="mt-4 text-[15px] font-extrabold text-[var(--color-text)]">{p.title}</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--color-text-muted)]">{p.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
      <Reveal delay={150} className="mt-4">
        <div className={`${card} p-5 sm:p-7 flex flex-col md:flex-row md:items-center gap-5`}>
          <IconTile><FileArchive className="w-5 h-5" /></IconTile>
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-extrabold text-[var(--color-text)]">Everything you&apos;d need to rebuild from scratch.</h3>
            <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--color-text-muted)]">
              A portable ZIP: manifest, README, the database schema, one JSON file per table, and every file
              with its path kept. Point a fresh Postgres at the schema, apply the included migrations, load the
              JSON, and you&apos;re back online with any vendor, or none.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {files.map((f) => (
                <span key={f} className="inline-flex items-center h-7 px-2.5 rounded-lg bg-[var(--color-surface-2)] text-[12px] font-mono text-[var(--color-text)]">{f}</span>
              ))}
            </div>
          </div>
          <Link href="/data-portability" className={`${quietOnPaper} shrink-0`}>
            Read the full commitment <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </Reveal>
    </section>
  );
}

// ─── Compliance, honestly ───────────────────────────────────────────────────

function Honesty({ title, body }: { title: string; body: string }) {
  return (
    <li className="py-3.5 border-t first:border-t-0 border-[var(--color-border)]">
      <div className="text-[14px] font-bold text-[var(--color-text)]">{title}</div>
      <div className="mt-0.5 text-[14px] leading-relaxed text-[var(--color-text-muted)]">{body}</div>
    </li>
  );
}

function ComplianceHonestySection() {
  return (
    <section id="honesty" className={`${wrap} pt-24 sm:pt-32 scroll-mt-16`}>
      <SectionHead kicker="Honest about compliance" title="What we are, and what we aren't.">
        Manufacturing OS is software that supports compliance documentation. It is not a certification,
        and running it does not by itself make you compliant with any standard. Your QMS coordinator or PSM
        lead still owns the program. We are the system of record they rely on. Here is the line.
      </SectionHead>
      <div className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-5">
        <Reveal>
          <div className={`${card} h-full p-5 sm:p-7`}>
            <div className={`${label} flex items-center gap-2 text-emerald-700 dark:text-emerald-400`}>
              <CheckCircle2 className="w-4 h-4" /> What we support
            </div>
            <ul className="mt-2">
              <Honesty title="Document control" body="Revision history, current-versus-superseded clarity and status stamping: the backbone ISO 9001 §7.5 and OSHA PSM §(d) call for." />
              <Honesty title="Management of Change requests" body="A dedicated MOC request type with engineer-routed sign-off, for the records OSHA PSM §(l) requires when a covered process changes." />
              <Honesty title="An audit trail nothing can edit" body="Every sign-in, download, approval and status change in an append-only log. Export it as evidence for internal or outside audits." />
              <Honesty title="Approval only by a qualified engineer" body="Requesters who aren't engineers can't approve engineering work. The system routes it to one." />
              <Honesty title="Data you own" body="Full export any time, in standard formats, for vendor-risk and disaster-recovery policies." />
            </ul>
          </div>
        </Reveal>
        <Reveal delay={90}>
          <div className={`${card} h-full p-5 sm:p-7`}>
            <div className={`${label} flex items-center gap-2 text-[var(--color-text-muted)]`}>
              <XCircle className="w-4 h-4" /> What stays yours
            </div>
            <ul className="mt-2">
              <Honesty title="Certification" body="We are not auditors and we don't certify anyone. ISO 9001 certification and PSM audits are done by independent third parties." />
              <Honesty title="Process hazard analysis" body="OSHA PSM §(e) requires PHA studies (HAZOP, what-if). Your safety team runs them. We store the results." />
              <Honesty title="Mechanical integrity" body="PM schedules, inspection records and RBI are outside this product. We sit next to your CMMS, not in place of it." />
              <Honesty title="Training and competency" body="Training matrices and competency records live in your HR or learning system, not here." />
              <Honesty title="Procedures, incidents, emergency planning" body="PSM elements §(f), §(m) and §(n). We can store the documents; your team writes and keeps them." />
            </ul>
          </div>
        </Reveal>
      </div>
      <Reveal delay={120} className="mt-4">
        <p className="rounded-2xl bg-[var(--color-ink)] text-white/80 px-5 sm:px-7 py-5 text-[15px] leading-relaxed">
          <b className="text-white">In plain words:</b> Manufacturing OS makes it much easier to <b className="text-white">produce</b> the
          documentation an auditor would accept. It does not <b className="text-white">grant</b> compliance, and using it
          doesn&apos;t replace running your program. Your compliance standing is yours.
        </p>
      </Reveal>
    </section>
  );
}

// ─── Security: the charcoal band, the controls overlapping it ───────────────

function SecuritySection() {
  const items = [
    { icon: <Lock className="w-5 h-5" />, title: "HTTPS only", body: "All traffic over TLS. No plain-HTTP fallback." },
    { icon: <Database className="w-5 h-5" />, title: "Encrypted at rest", body: "The database is encrypted at rest by Supabase, file storage by Cloudflare R2." },
    { icon: <Server className="w-5 h-5" />, title: "Row-level isolation", body: "Postgres row-level security scopes every query to its organization, at the database itself." },
    { icon: <KeyRound className="w-5 h-5" />, title: "AES-256-GCM for secrets", body: "Your S3 credentials and personal AI keys are encrypted at rest, never stored in the clear." },
    { icon: <Users className="w-5 h-5" />, title: "Roles and per-item access", body: "Eighteen roles, from Admin and Doc Control to Contractor, Auditor and four engineer tiers, plus access rules on libraries, folders and documents." },
    { icon: <PenLine className="w-5 h-5" />, title: "Signing that proves it's you", body: "Approvals that matter ask you to sign in again at the moment of signing, and record it with the signature." },
    { icon: <GitBranch className="w-5 h-5" />, title: "Authority your admins set", body: "What each role may approve, issue, hold or export is policy, enforced on the server, with a view-as preview." },
    { icon: <Factory className="w-5 h-5" />, title: "An AI with a fence", body: "The AI reads only what the person asking may read. Excluded documents are never indexed, retrieved or cited." },
    { icon: <ClipboardCheck className="w-5 h-5" />, title: "Privileged work stays on the server", body: "Browsers never hold keys that skip access rules. Server routes re-check membership and role on every call, and exports log themselves." },
  ];
  return (
    <section id="security" className={`${wrap} pt-24 sm:pt-32 scroll-mt-16`}>
      <div className="rounded-[28px] bg-[var(--color-ink)] px-5 sm:px-10 lg:px-14 pt-10 sm:pt-14 pb-32 sm:pb-36">
        <Reveal className="max-w-3xl">
          <div className={`${label} text-white/60`}>Security</div>
          <h2 className={`mt-4 ${huge} text-white`}>What your IT auditor will ask about.</h2>
          <p className="mt-5 text-[15px] sm:text-[16px] leading-relaxed text-white/70 max-w-2xl">
            No vague promises. The specific controls, named.
          </p>
        </Reveal>
      </div>
      <div className="relative -mt-20 sm:-mt-24 px-2 sm:px-6 lg:px-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {items.map((s, i) => (
          <Reveal key={s.title} delay={(i % 3) * 80}>
            <div className={`${card} h-full p-5`}>
              <div className="flex items-center gap-3">
                <IconTile>{s.icon}</IconTile>
                <h3 className="text-[15px] font-extrabold text-[var(--color-text)]">{s.title}</h3>
              </div>
              <p className="mt-3 text-[14px] leading-relaxed text-[var(--color-text-muted)]">{s.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ─── Who it's for ───────────────────────────────────────────────────────────

function AudienceSection() {
  const who = [
    { icon: <Factory className="w-5 h-5" />, title: "Process industries", body: "Refineries, chemical plants, power, water treatment. The records OSHA PSM 1910.119 §(l) asks for in Management of Change: engineer-routed approvals and a revision trail that survives audits." },
    { icon: <ClipboardCheck className="w-5 h-5" />, title: "Manufacturing and batch plants", body: "Mills, food and beverage, pharma, discrete manufacturing. One system for the drawings, procedures and change records ISO 9001 surveillance keeps asking about, that the floor actually uses." },
    { icon: <Wrench className="w-5 h-5" />, title: "EPC and engineering teams", body: "Projects scope work per client. Contractors submit through a tokened portal without ever touching the rest of your library, and redlines come back clean." },
  ];
  return (
    <section className={`${wrap} pt-24 sm:pt-32`}>
      <SectionHead kicker="Who runs on it" title="Built for sites where the drawings matter.">
        If your facility runs on controlled documents, whatever it makes, this is for you.
      </SectionHead>
      <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-4">
        {who.map((a, i) => (
          <Reveal key={a.title} delay={i * 90}>
            <div className={`${card} h-full p-5 sm:p-6`}>
              <IconTile>{a.icon}</IconTile>
              <h3 className="mt-4 text-[15px] font-extrabold text-[var(--color-text)]">{a.title}</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--color-text-muted)]">{a.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ─── The last word ──────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section className={`${wrap} pt-24 sm:pt-32 pb-16 sm:pb-24`}>
      <Reveal>
        <div className="rounded-[28px] bg-[var(--color-band)] text-white px-5 sm:px-10 lg:px-14 py-12 sm:py-16">
          <div className={`${label} text-[var(--color-ink-muted)]`}>Start today</div>
          <h2 className={`mt-4 ${huge} max-w-4xl`}>Stop running your facility off a shared drive.</h2>
          <p className="mt-5 text-[15px] sm:text-[16px] leading-relaxed text-[var(--color-ink-text)] max-w-2xl">
            Set up a workspace, bring in your documents, teach it your numbering, and let the guided setup walk
            you the rest of the way. The day you leave, you take everything with you.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/signup" className={cta}>Create your workspace <ArrowRight className="w-4 h-4" /></Link>
            <Link href="/" className={quietOnBand}>Sign in</Link>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

// ─── Footer ─────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="bg-[var(--color-ink)] text-white/70">
      <div className={`${wrap} py-12 grid grid-cols-2 md:grid-cols-4 gap-8`}>
        <div className="col-span-2">
          <Logo onDark />
          <p className="mt-4 text-[14px] leading-relaxed max-w-sm">
            Document control, drafting workflow and an AI that has read your library. Your data is yours, your
            audit trail is real, and leaving takes one click.
          </p>
        </div>
        <div>
          <div className={`${label} text-white/50 mb-3`}>Product</div>
          <ul className="space-y-2 text-[14px]">
            <li><a href="#day" className="hover:text-white">Your day</a></li>
            <li><a href="#capabilities" className="hover:text-white">What&apos;s inside</a></li>
            <li><a href="#tour" className="hover:text-white">See it</a></li>
            <li><a href="#trust" className="hover:text-white">Your data</a></li>
            <li><a href="#honesty" className="hover:text-white">Compliance</a></li>
            <li><a href="#security" className="hover:text-white">Security</a></li>
            <li><Link href="/data-portability" className="hover:text-white">Data portability</Link></li>
          </ul>
        </div>
        <div>
          <div className={`${label} text-white/50 mb-3`}>Account</div>
          <ul className="space-y-2 text-[14px]">
            <li><Link href="/" className="hover:text-white">Sign in</Link></li>
            <li><Link href="/signup" className="hover:text-white">Create a workspace</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/10">
        <div className={`${wrap} py-4 text-[12px] text-white/50`}>
          &copy; {new Date().getFullYear()} Manufacturing OS. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
