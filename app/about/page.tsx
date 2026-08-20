// app/about/page.tsx — public marketing landing.
//
// Structure is deliberate: grab attention with the promise + policy
// (no lock-in, honest compliance), then sell to the PERSON (role-based
// before/after day), then walk business priorities in order — library,
// AI, workflow, site map, field bridge, collaboration — with an
// interactive tour, and close on trust/compliance/security. Concise on
// the surface, complete underneath (chip clouds expand to the full
// feature inventory).
//
// Facility-agnostic on purpose: refineries, chemical, food & beverage,
// pharma, power, mills — the copy never assumes one industry.
//
// Compliance language is deliberately honest — we support documentation
// requirements; we are not a certifier and using the product does not
// make a customer compliant. See "What we are, what we aren't".
//
// Product tour mockups are styled React mirroring the live product's
// layout language — not screenshots, but the same UI DNA.

import Link from "next/link";
import {
  Layout, ShieldCheck, FileCheck2, GitBranch, Database, Workflow, Users,
  Lock, Server, ArrowRight, CheckCircle2, KeyRound, Factory, Wrench,
  ClipboardCheck, ExternalLink, Download, Zap, XCircle, Webhook,
  FileArchive, Eye, Sparkles, Map as MapIcon, QrCode, AtSign, PenLine,
} from "lucide-react";
import { Reveal, RotatingWord } from "@/components/marketing/Reveal";
import { ChipCloud } from "@/components/marketing/ChipCloud";
import { RoleDayTabs } from "@/components/marketing/RoleDayTabs";
import { TourTabs } from "@/components/marketing/TourTabs";

export const metadata = {
  title: "Manufacturing OS — Document control your facility can audit",
  description:
    "Document control, drafting workflow, AI that has read your library, and a living map of your site — for any facility that runs on drawings. Designed to support OSHA PSM 1910.119 and ISO 9001 documentation, with a one-click export of every byte you put in. No lock-in, ever.",
};

export default function MarketingPage() {
  return (
    <div className="min-h-dvh bg-white text-slate-900">
      <Nav />
      <Hero />
      <PromiseStrip />
      <DaySection />
      <PillarsSection />
      <TourSection />
      <TrustSection />
      <ComplianceHonestySection />
      <SecuritySection />
      <AudienceSection />
      <FinalCta />
      <Footer />
    </div>
  );
}

// ─── Nav ──────────────────────────────────────────────────────

function Nav() {
  return (
    <header className="sticky top-0 z-50 bg-white/80 backdrop-blur border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-gradient-to-br from-orange-500 to-orange-700 rounded-lg flex items-center justify-center shadow-sm">
            <Layout className="w-4 h-4 text-white" />
          </div>
          <div className="font-black text-slate-900 text-sm tracking-tight">
            Manufacturing<span className="text-orange-600">OS</span>
          </div>
        </Link>
        <nav className="hidden md:flex items-center gap-5 text-sm font-bold text-slate-600">
          <a href="#day" className="hover:text-slate-900">Your Day</a>
          <a href="#capabilities" className="hover:text-slate-900">What&apos;s Inside</a>
          <a href="#tour" className="hover:text-slate-900">See It</a>
          <a href="#trust" className="hover:text-slate-900">Your Data</a>
          <a href="#honesty" className="hover:text-slate-900">Compliance</a>
          <a href="#security" className="hover:text-slate-900">Security</a>
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/" className="text-sm font-bold text-slate-700 hover:text-slate-900 px-3 py-1.5">
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex items-center gap-1.5 text-sm font-black text-white bg-slate-900 hover:bg-slate-800 px-4 py-2 rounded-lg shadow"
          >
            Get Started <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </header>
  );
}

// ─── Hero ───────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative overflow-hidden bg-slate-950 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-orange-700/60 to-transparent" />
      <div className="relative max-w-6xl mx-auto px-6 py-24 md:py-32">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/30 text-orange-300 text-xs font-bold uppercase tracking-widest mb-6"
            style={{ animation: "rise 0.6s var(--ease-fluid) both" }}>
            <Zap className="w-3.5 h-3.5" /> For every facility that runs on drawings
          </div>
          <h1 className="text-4xl md:text-6xl font-black tracking-tight leading-[1.05] mb-5"
            style={{ animation: "rise 0.6s var(--ease-fluid) 80ms both" }}>
            Your{" "}
            <RotatingWord
              words={["refinery", "chemical plant", "mill", "food plant", "pharma site", "power station", "facility"]}
              className="text-orange-500"
            />
            <br />finally in one system.
          </h1>
          <p className="text-lg md:text-xl text-slate-300 leading-relaxed mb-8 max-w-2xl"
            style={{ animation: "rise 0.6s var(--ease-fluid) 160ms both" }}>
            Manufacturing OS replaces shared drives, scattered email threads, and three-binders-deep
            revision tracking with a single source of truth — <b className="text-white">plus an AI that
            has actually read your documents</b>. Designed to support OSHA PSM 1910.119 and ISO 9001
            documentation, and engineered so you own your data, every byte, end-to-end.
          </p>
          <div className="flex flex-wrap gap-3" style={{ animation: "rise 0.6s var(--ease-fluid) 240ms both" }}>
            <Link
              href="/signup"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-sm font-black shadow-lg shadow-orange-900/30"
            >
              Start a workspace <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="#tour"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-white text-sm font-bold backdrop-blur"
            >
              <Eye className="w-4 h-4" /> See it in action
            </Link>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-400"
            style={{ animation: "rise 0.6s var(--ease-fluid) 320ms both" }}>
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Full export, any time</span>
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Your own AI key</span>
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Public schema, no lock-in</span>
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Encrypted at rest</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Promise strip — the policy, up front ───────────────────────────────────

function PromiseStrip() {
  const promises = [
    { icon: <ShieldCheck className="w-5 h-5 text-emerald-700" />, title: "No lock-in, ever", body: "Three self-serve exit paths. Your whole dataset in standard formats, one click.", href: "#trust" },
    { icon: <KeyRound className="w-5 h-5 text-orange-700" />, title: "Your AI, your key", body: "The AI runs on your own provider key with per-user caps. Your documents never train anyone's model.", href: "#capabilities" },
    { icon: <ClipboardCheck className="w-5 h-5 text-blue-700" />, title: "Honest compliance", body: "We support the documentation; we don't sell certification. The line is drawn explicitly.", href: "#honesty" },
    { icon: <FileCheck2 className="w-5 h-5 text-violet-700" />, title: "Everything audited", body: "Every login, download, approval, and export in a tamper-evident log you can hand to an auditor.", href: "#security" },
  ];
  return (
    <section className="bg-slate-50 border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {promises.map((p, i) => (
            <Reveal key={p.title} delay={i * 80}>
              <a href={p.href} className="block h-full bg-white border border-slate-200 rounded-2xl p-4 shadow-sm hover:shadow-md hover:border-slate-300 hover:-translate-y-0.5 transition-all">
                <div className="p-1.5 bg-slate-100 rounded-lg w-fit mb-2.5">{p.icon}</div>
                <h3 className="text-sm font-black text-slate-900 mb-1">{p.title}</h3>
                <p className="text-xs text-slate-600 leading-relaxed">{p.body}</p>
              </a>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Your day, easier ───────────────────────────────────────────────────────

function DaySection() {
  return (
    <section id="day" className="bg-white">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <Reveal className="max-w-3xl mb-10">
          <div className="text-xs font-black uppercase tracking-widest text-orange-600 mb-3">Your day, easier</div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-4">Pick your job. Watch it get lighter.</h2>
          <p className="text-base text-slate-600 leading-relaxed">
            Software pitches love feature lists. Your team lives in moments — the fifth &quot;FINAL_rev3&quot;
            PDF, the audit question nobody can answer, the walk across the site to see what a vessel looks
            like. Here&apos;s what those moments become.
          </p>
        </Reveal>
        <Reveal delay={100}>
          <RoleDayTabs />
        </Reveal>
      </div>
    </section>
  );
}

// ─── Pillars — business priorities, in order ───────────────────────────────

function Pillar({
  n, icon, iconBg, accent, title, tagline, bullets, chips, delay = 0,
}: {
  n: string;
  icon: React.ReactNode;
  iconBg: string;
  accent: string;
  title: string;
  tagline: string;
  bullets: string[];
  chips: string[];
  delay?: number;
}) {
  return (
    <Reveal delay={delay}>
      <div className="bg-white border border-slate-200 rounded-3xl p-6 md:p-8 shadow-sm hover:shadow-md transition-shadow h-full">
        <div className="flex items-start gap-4 mb-4">
          <div className={`p-3 rounded-2xl ${iconBg} shrink-0`}>{icon}</div>
          <div>
            <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-0.5">{n}</div>
            <h3 className="text-xl md:text-2xl font-black text-slate-900 leading-tight">{title}</h3>
          </div>
        </div>
        <p className="text-sm text-slate-600 leading-relaxed mb-4">{tagline}</p>
        <ul className="space-y-2 mb-5">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-2 text-[13px] text-slate-800 font-medium">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
        <div className="pt-4 border-t border-slate-100">
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Everything inside</div>
          <ChipCloud chips={chips} accent={accent} />
        </div>
      </div>
    </Reveal>
  );
}

function PillarsSection() {
  return (
    <section id="capabilities" className="bg-slate-50 border-y border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <Reveal className="max-w-3xl mb-12">
          <div className="text-xs font-black uppercase tracking-widest text-orange-600 mb-3">What&apos;s inside</div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-4">Six pillars, in the order they matter to your business.</h2>
          <p className="text-base text-slate-600 leading-relaxed">
            Each one is deep — tap <b>&quot;+ more&quot;</b> on any pillar for the full inventory. None of it
            assumes what your facility makes.
          </p>
        </Reveal>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Pillar
            n="Pillar 1"
            icon={<FileCheck2 className="w-6 h-6 text-blue-700" />}
            iconBg="bg-blue-100"
            accent="blue"
            title="One source of truth for every document"
            tagline="The current revision is unambiguous, provable, and the only one anyone can print. That single fact ends most of the chaos."
            bullets={[
              "Full revision history — superseded copies visibly marked and recalled from everyone who downloaded them",
              "Every issued PDF stamped with status, watermark, and a QR anyone can verify by phone",
              "Bulk-import legacy files: metadata parses from filenames, AI reads the title blocks, you confirm one staging grid",
            ]}
            chips={[
              "Revision history & compare", "Supersession marking", "Status-stamped PDFs",
              "Checkout locks (24h auto-release)", "Live editing-now chips", "Metadata-first bulk upload",
              "AI title-block ingest", "Auto document numbering", "Short links (/d/DOC-001)",
              "Custom columns & terminology", "Saved views & favorites", "Curated playbooks",
              "Library subscriptions", "Stale-copy recall", "Where-used impact panel", "Full-text search",
            ]}
          />
          <Pillar
            n="Pillar 2"
            icon={<Sparkles className="w-6 h-6 text-orange-700" />}
            iconBg="bg-orange-100"
            accent="orange"
            title="An AI that has read your library"
            tagline="Ask in plain language; the answer comes back cited to the exact page with the highlighted proof one click away. It can only reference documents you gave it — nothing invented."
            bullets={[
              "Reads scanned and CAD-exported drawings with vision — extracts equipment tags, audits cross-references, even traces lines",
              "Runs on your own AI key (Claude, OpenAI, or Gemini) with per-user spend caps and full usage metering",
              "You draw the boundary: exclude any document from AI reading with one switch; sources sync from document control with your ACLs intact",
            ]}
            chips={[
              "Bring-your-own AI key", "Page-cited answers", "Highlighted proof viewer",
              "Vision reading of scans", "Equipment tag extraction", "Drawing census & reference audit",
              "Line tracing on drawings", "Semantic search", "Org playbooks in every answer",
              "Buildable, shareable AI skills", "Answer-to-graph shaping (admins)", "Per-user caps & metering",
              "Per-document AI exclusion", "ACL-aware source sync", "Assistant that knows the app's map",
            ]}
            delay={80}
          />
          <Pillar
            n="Pillar 3"
            icon={<Workflow className="w-6 h-6 text-emerald-700" />}
            iconBg="bg-emerald-100"
            accent="emerald"
            title="Workflow with authority built in"
            tagline="Requests route through review, drafting, and approval — and the system enforces who is allowed to sign. A non-engineer cannot approve engineering work, period."
            bullets={[
              "MOC, RFI, as-built, and inspection tickets with SLA targets and past-due chips that keep nothing lost",
              "Distribution that proves receipt: acknowledgments tracked per person, transmittals with a recipient portal",
              "External teams work through a tokened intake portal and scoped projects — never inside your library",
            ]}
            chips={[
              "MOC / RFI / As-built / Inspection tickets", "Engineer-routed sign-off", "Redline markup",
              "Revision request loops", "Deliverable rev ladder (1A→1→2A→2)", "SLA targets & past-due chips",
              "Work packages", "Acknowledged distribution", "Transmittals + recipient portal",
              "Tokened intake portal", "Contractor redline round-trip", "Legacy transition-in wizard",
              "Scheduler", "Cost tracking", "Projects with scoped membership",
            ]}
            delay={80}
          />
          <Pillar
            n="Pillar 4"
            icon={<MapIcon className="w-6 h-6 text-violet-700" />}
            iconBg="bg-violet-100"
            accent="violet"
            title="A living map of your site"
            tagline="Teach it your numbering system once, and imports categorize and file themselves. Documents, equipment, and operating areas become one navigable graph."
            bullets={[
              "Equipment registry with date-stamped photo galleries — tap any tag, anywhere, and see the physical thing",
              "Interactive 2D/3D graph with lenses: process flow, equipment, documents — or everything at once",
              "The AI reads process flows straight off your flow diagrams and proposes them for human confirmation",
            ]}
            chips={[
              "Site Codebook (your numbering, taught once)", "Operating areas hub", "Equipment registry & photos",
              "Auto-categorize from tags & site codes", "Process flow map (drawn or AI-read)",
              "Plot plans with placed markers", "2D/3D interactive graph", "Process / equipment / document lenses",
              "Path finding between any two nodes", "Per-tag backlinks", "3D point-cloud viewer",
              "Guided facility setup navigator",
            ]}
            delay={160}
          />
          <Pillar
            n="Pillar 5"
            icon={<QrCode className="w-6 h-6 text-cyan-700" />}
            iconBg="bg-cyan-100"
            accent="cyan"
            title="The paper-to-plant bridge"
            tagline="Paper doesn't disappear from industrial sites — so every print carries a QR that answers the only question that matters: is this still current?"
            bullets={[
              "Anyone scans a stamped print and gets current-or-superseded instantly — no login, no app install",
              "Equipment labels, hold cards, and job travelers printed straight from the system, each with live status",
              "Start on a workstation, continue on your phone with one scan",
            ]}
            chips={[
              "QR-stamped prints", "Public verify pages (docs, holds, packages, tickets)",
              "Equipment labels", "Hold cards with live status", "Ticket traveler sheets",
              "Print packs with QR covers", "Continue-on-phone", "Scan-landing quick actions",
            ]}
            delay={160}
          />
          <Pillar
            n="Pillar 6"
            icon={<AtSign className="w-6 h-6 text-rose-700" />}
            iconBg="bg-rose-100"
            accent="rose"
            title="A team that stays in sync"
            tagline="Mentions, watching, and dashboards replace the reply-all thread — and a command palette that knows every feature means nobody hunts for anything."
            bullets={[
              "@-mention a teammate and they're notified in-app and by email, with per-user preferences",
              "Watch any document, ticket, or library and hear about every change",
              "Live dashboards show past-due work, unacknowledged distributions, and the protection record at a glance",
            ]}
            chips={[
              "@-mentions with notifications", "Watch documents / tickets / libraries",
              "Email + in-app delivery", "Per-user notification preferences", "Recently viewed",
              "Personal desk panel", "Live dashboards", "Command palette with built-in app map",
            ]}
            delay={240}
          />
        </div>
      </div>
    </section>
  );
}

// ─── Product tour ───────────────────────────────────────────────────────────

function TourSection() {
  return (
    <section id="tour" className="bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <Reveal className="max-w-3xl mb-8">
          <div className="text-xs font-black uppercase tracking-widest text-orange-600 mb-3">See it in action</div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-4">Six stations. One screen. Click around.</h2>
          <p className="text-base text-slate-600 leading-relaxed">
            Built with the same design language as the live app — these aren&apos;t marketing renders,
            they&apos;re the real UI with generic industrial data dropped in.
          </p>
        </Reveal>
        <Reveal delay={100}>
          <TourTabs />
        </Reveal>
      </div>
    </section>
  );
}

// ─── Trust / Data Portability ────────────────────────────────────────

function TrustSection() {
  return (
    <section id="trust" className="bg-gradient-to-b from-emerald-50 to-white border-b border-emerald-200">
      <div className="max-w-6xl mx-auto px-6 py-24">
        <Reveal className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-100 border border-emerald-300 text-emerald-800 text-xs font-bold uppercase tracking-widest mb-5">
            <ShieldCheck className="w-3.5 h-3.5" /> Your data, your choice
          </div>
          <h2 className="text-3xl md:text-5xl font-black tracking-tight mb-5">No lock-in. Not now, not ever.</h2>
          <p className="text-base md:text-lg text-slate-700 leading-relaxed mb-8">
            Industrial document control is critical infrastructure. You can&apos;t afford to wonder whether a
            vendor outage or a contract dispute will cost you years of engineering work. So we built three
            independent paths off this platform — and your administrators can use any of them, any time,
            with no special tooling, no support ticket, and no per-export cost.
          </p>
        </Reveal>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            { icon: <Download className="w-5 h-5 text-blue-700" />, title: "1. Direct download", body: "One click. A single JSON file with every record, plus a manifest with 24-hour presigned URLs for every file. Or a full ZIP with the binaries inline." },
            { icon: <Server className="w-5 h-5 text-emerald-700" />, title: "2. Scheduled push", body: "Point us at your own S3 / R2 bucket. We push a fresh export there daily, weekly, or monthly. Credentials encrypted with AES-256-GCM. You own the backups." },
            { icon: <Webhook className="w-5 h-5 text-purple-700" />, title: "3. Webhook delivery", body: "HMAC-signed POST to your endpoint with the ZIP body. Build your own pipeline. Re-export to anywhere. Pipe into your data lake." },
          ].map((p, i) => (
            <Reveal key={p.title} delay={i * 90}>
              <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm h-full">
                <div className="p-2 bg-slate-100 rounded-lg w-fit mb-3">{p.icon}</div>
                <h3 className="text-sm font-black text-slate-900 mb-1.5">{p.title}</h3>
                <p className="text-xs text-slate-600 leading-relaxed">{p.body}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={150}>
          <div className="mt-12 bg-white border-2 border-emerald-200 rounded-2xl p-6 shadow-sm">
            <div className="flex flex-col md:flex-row items-start md:items-center gap-5">
              <div className="p-3 bg-emerald-100 rounded-xl shrink-0">
                <FileArchive className="w-8 h-8 text-emerald-700" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-black text-slate-900 mb-1">Everything you&apos;d need to rebuild from scratch.</h3>
                <p className="text-sm text-slate-600 leading-relaxed mb-3">
                  The export is a portable ZIP: manifest, README, the database schema DDL, one JSON file per
                  table, and every binary file path-preserved. Unzip it, point a fresh Postgres at the schema,
                  bulk-load the JSON, and you&apos;re back online — with any document-control vendor, or none.
                </p>
                <div className="flex flex-wrap gap-2 text-[11px] text-slate-500 font-mono">
                  <Chip>/manifest.json</Chip>
                  <Chip>/README.md</Chip>
                  <Chip>/schema/schema.sql</Chip>
                  <Chip>/tables/*.json</Chip>
                  <Chip>/files/&lt;storage-path&gt;</Chip>
                </div>
              </div>
              <Link
                href="/data-portability"
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-black shadow shrink-0"
              >
                Read the full commitment <ExternalLink className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-700">{children}</span>
  );
}

// ─── Compliance Honesty ──────────────────────────────────────────────

function ComplianceHonestySection() {
  return (
    <section id="honesty" className="bg-white border-b border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <Reveal className="max-w-3xl mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-100 border border-slate-300 text-slate-700 text-xs font-bold uppercase tracking-widest mb-4">
            <ClipboardCheck className="w-3.5 h-3.5" /> Honest about compliance
          </div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-4">What we are, and what we aren&apos;t.</h2>
          <p className="text-base text-slate-600 leading-relaxed">
            Manufacturing OS is <b>software that supports compliance documentation</b>. It is not a
            certification. Running this product does not, by itself, make your organization compliant with
            any standard. Your QMS coordinator, PSM officer, or compliance lead remains responsible for the
            overall program. We&apos;re the system of record they rely on — not a substitute for their
            judgment. Here&apos;s the line, drawn explicitly.
          </p>
        </Reveal>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Reveal>
            <div className="bg-emerald-50 border-2 border-emerald-200 rounded-2xl p-6 h-full">
              <div className="flex items-center gap-2 mb-4">
                <CheckCircle2 className="w-5 h-5 text-emerald-700" />
                <h3 className="text-base font-black text-emerald-900">What we do support</h3>
              </div>
              <ul className="space-y-2.5 text-sm text-slate-700">
                <Honesty title="Document control infrastructure" body="Revision history, current-vs-superseded clarity, status stamping — the documentation backbone called for by ISO 9001 §7.5 and OSHA PSM §(d)." />
                <Honesty title="Management of Change (MOC) tickets" body="Dedicated MOC ticket type with engineer-routed sign-off, addressing the documentation OSHA PSM §(l) requires when modifying covered processes." />
                <Honesty title="Immutable audit trail" body="Every login, download, approval, status change written to a tamper-evident log. Exportable as evidence for internal or external audits." />
                <Honesty title="Engineer-routed approval enforcement" body="Non-engineer requesters cannot self-approve engineering work; the system enforces routing to a qualified engineer." />
                <Honesty title="Customer-owned data" body="Full data export anytime, in standard formats. Supports vendor risk management policies and disaster recovery requirements." />
              </ul>
            </div>
          </Reveal>

          <Reveal delay={90}>
            <div className="bg-slate-50 border-2 border-slate-300 rounded-2xl p-6 h-full">
              <div className="flex items-center gap-2 mb-4">
                <XCircle className="w-5 h-5 text-slate-600" />
                <h3 className="text-base font-black text-slate-900">What stays your responsibility</h3>
              </div>
              <ul className="space-y-2.5 text-sm text-slate-700">
                <Honesty title="Certification" body="We are not auditors and we do not certify your organization. ISO 9001 certification and PSM compliance audits are conducted by independent third parties, not by us." />
                <Honesty title="Process Hazard Analysis (PHA)" body="OSHA PSM §(e) requires PHA studies (HAZOP, what-if, etc.). We don't run them; your safety team does. We store the resulting documents." />
                <Honesty title="Mechanical Integrity programs" body="PM schedules, inspection records, RBI — outside this product's scope. We're a complement to your CMMS / inspection tool, not a replacement." />
                <Honesty title="Training records & competency" body="Personnel training matrices and competency assessments are managed in your HR or LMS system, not here." />
                <Honesty title="Operating procedures, incident investigation, emergency planning" body="PSM elements §(f), §(m), §(n). We can store the documents; your team produces and maintains them." />
              </ul>
            </div>
          </Reveal>
        </div>

        <Reveal delay={120}>
          <div className="mt-8 p-4 bg-slate-900 text-slate-300 rounded-xl text-sm leading-relaxed">
            <b className="text-white">In plain English:</b> Manufacturing OS makes it dramatically easier to
            <b className="text-white"> produce </b>the documentation an auditor would accept. It does not
            <b className="text-white"> grant </b>compliance, and using it does not absolve you of running your
            program. Final compliance posture is yours.
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Honesty({ title, body }: { title: string; body: string }) {
  return (
    <li className="flex flex-col gap-0.5">
      <span className="text-sm font-black text-slate-900">{title}</span>
      <span className="text-xs text-slate-600 leading-relaxed">{body}</span>
    </li>
  );
}

// ─── Security ──────────────────────────────────────────────────────

function SecuritySection() {
  const items = [
    { icon: <Lock className="w-5 h-5 text-blue-300" />, title: "HTTPS-only transport", body: "All traffic over TLS. No HTTP fallback." },
    { icon: <Database className="w-5 h-5 text-blue-300" />, title: "Encryption at rest", body: "Postgres encrypted at rest by Supabase. File storage encrypted at rest by Cloudflare R2." },
    { icon: <Server className="w-5 h-5 text-blue-300" />, title: "Row-level isolation", body: "Postgres RLS scopes every query to its org. No cross-tenant leakage possible at the database layer." },
    { icon: <KeyRound className="w-5 h-5 text-blue-300" />, title: "AES-256-GCM for secrets", body: "Customer S3 credentials and personal AI provider keys encrypted at rest — never stored in the clear." },
    { icon: <Users className="w-5 h-5 text-blue-300" />, title: "Roles + per-node access control", body: "Admin, Manager, Supervisor, Engineer, Drafter, Doc Control, Requester — plus ACLs on libraries, folders, and documents, evaluated as one chain." },
    { icon: <PenLine className="w-5 h-5 text-blue-300" />, title: "Signature ceremony", body: "Approvals that matter require re-entering your password at the moment of signing — a session left open can't sign for you." },
    { icon: <GitBranch className="w-5 h-5 text-blue-300" />, title: "Configurable authority policies", body: "What each role may do — approve, issue, hold, export — is policy your admins set, enforced server-side, with a view-as simulator to preview it." },
    { icon: <Factory className="w-5 h-5 text-blue-300" />, title: "Governed AI boundary", body: "AI reads only what document-control ACLs allow for the person asking. Excluded documents are never indexed, retrieved, or cited." },
    { icon: <ClipboardCheck className="w-5 h-5 text-blue-300" />, title: "Audited service-role usage", body: "The only code that bypasses RLS is the export endpoint — and exports log themselves to your audit trail." },
  ];
  return (
    <section id="security" className="bg-slate-950 text-white">
      <div className="max-w-6xl mx-auto px-6 py-24">
        <Reveal className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-300 text-xs font-bold uppercase tracking-widest mb-5">
            <Lock className="w-3.5 h-3.5" /> Security posture
          </div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-5">The same things your IT auditor is going to ask about.</h2>
          <p className="text-base text-slate-300 leading-relaxed mb-12">No vague marketing. The specific technical controls, named.</p>
        </Reveal>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((s, i) => (
            <Reveal key={s.title} delay={(i % 3) * 80}>
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 h-full">
                <div className="p-1.5 bg-blue-500/10 rounded-lg w-fit mb-3">{s.icon}</div>
                <h3 className="text-sm font-black text-white mb-1.5">{s.title}</h3>
                <p className="text-xs text-slate-400 leading-relaxed">{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Audience ──────────────────────────────────────────────────────

function AudienceSection() {
  return (
    <section className="bg-white">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <Reveal className="max-w-3xl mb-12">
          <div className="text-xs font-black uppercase tracking-widest text-orange-600 mb-3">Who runs on it</div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-4">Built for sites where the drawings matter.</h2>
          <p className="text-base text-slate-600 leading-relaxed">
            If your facility runs on controlled documents — whatever it makes — this is for you.
          </p>
        </Reveal>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {[
            { icon: <Factory className="w-6 h-6 text-orange-700" />, title: "Process industries", body: "Refineries, chemical plants, power generation, water treatment. Captures the documentation OSHA PSM 1910.119 §(l) calls for in Management of Change — engineer-routed approvals and revision lineage that survives audits." },
            { icon: <ClipboardCheck className="w-6 h-6 text-orange-700" />, title: "Manufacturing & batch plants", body: "Mills, food & beverage, pharma, discrete manufacturing. One system for the drawings, procedures, and change records ISO 9001 surveillance keeps asking about — that the floor actually uses." },
            { icon: <Wrench className="w-6 h-6 text-orange-700" />, title: "EPC & engineering teams", body: "Project containers scope work per client. Contractors submit through a tokened portal without ever touching the rest of your library — and redlines round-trip cleanly." },
          ].map((a, i) => (
            <Reveal key={a.title} delay={i * 90}>
              <div className="bg-gradient-to-b from-orange-50 to-white border border-orange-200 rounded-2xl p-6 h-full">
                <div className="p-2.5 bg-white rounded-lg w-fit mb-4 shadow-sm border border-orange-100">{a.icon}</div>
                <h3 className="text-base font-black text-slate-900 mb-2">{a.title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{a.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Final CTA ───────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section className="bg-gradient-to-br from-orange-600 to-orange-700 text-white">
      <div className="max-w-4xl mx-auto px-6 py-20 text-center">
        <Reveal>
          <h2 className="text-3xl md:text-5xl font-black tracking-tight mb-5">Stop running your facility off a shared drive.</h2>
          <p className="text-base md:text-lg text-orange-50 leading-relaxed mb-8 max-w-2xl mx-auto">
            Stand up a workspace, import your documents, teach it your numbering system, and let the guided
            setup walk you the rest of the way. And the day you decide to leave, you take everything with you.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-white hover:bg-slate-50 text-orange-700 text-sm font-black shadow-lg">
              Create your workspace <ArrowRight className="w-4 h-4" />
            </Link>
            <Link href="/" className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-white/10 hover:bg-white/15 border border-white/30 text-white text-sm font-bold backdrop-blur">
              Sign in to existing workspace
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ─── Footer ───────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="bg-slate-950 text-slate-400 border-t border-slate-800">
      <div className="max-w-6xl mx-auto px-6 py-12 grid grid-cols-2 md:grid-cols-4 gap-8">
        <div className="col-span-2">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-7 h-7 bg-gradient-to-br from-orange-500 to-orange-700 rounded-md flex items-center justify-center">
              <Layout className="w-3.5 h-3.5 text-white" />
            </div>
            <div className="font-black text-white text-sm">Manufacturing<span className="text-orange-500">OS</span></div>
          </div>
          <p className="text-xs leading-relaxed max-w-sm">
            Industrial document control, drafting workflow, and an AI that has read your library. Built so
            your data is yours, your audit trail is real, and your exit story is one click.
          </p>
        </div>
        <div>
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">Product</div>
          <ul className="space-y-2 text-xs">
            <li><a href="#day" className="hover:text-white">Your Day</a></li>
            <li><a href="#capabilities" className="hover:text-white">What&apos;s Inside</a></li>
            <li><a href="#tour" className="hover:text-white">See It</a></li>
            <li><a href="#trust" className="hover:text-white">Your Data</a></li>
            <li><a href="#honesty" className="hover:text-white">Compliance</a></li>
            <li><a href="#security" className="hover:text-white">Security</a></li>
            <li><Link href="/data-portability" className="hover:text-white">Data Portability</Link></li>
          </ul>
        </div>
        <div>
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">Account</div>
          <ul className="space-y-2 text-xs">
            <li><Link href="/" className="hover:text-white">Sign in</Link></li>
            <li><Link href="/signup" className="hover:text-white">Create workspace</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-slate-800">
        <div className="max-w-6xl mx-auto px-6 py-4 flex flex-col md:flex-row items-center justify-between gap-2 text-[11px]">
          <span>&copy; {new Date().getFullYear()} Manufacturing OS. All rights reserved.</span>
          <span className="font-mono text-slate-600">built for industrial workloads</span>
        </div>
      </div>
    </footer>
  );
}
