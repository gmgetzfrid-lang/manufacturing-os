// app/page.tsx — public marketing landing.
//
// This is the front door. Unauthenticated visitors land here.
// Sections, in order: nav, hero, problem, capabilities, trust
// (data portability), security, who-it's-for, final CTA, footer.
//
// Login form lives at /login. Signup at /signup. Public data
// portability commitment at /data-portability.

import Link from "next/link";
import {
  Layout, ShieldCheck, FileCheck2, GitBranch, Database,
  Workflow, Users, Lock, Server, ArrowRight, CheckCircle2,
  AtSign, Eye, Clock, FileArchive, Webhook, KeyRound,
  AlertTriangle, Factory, Wrench, ClipboardCheck, ExternalLink,
  Download, Zap, ScrollText,
} from "lucide-react";

export const metadata = {
  title: "Manufacturing OS — Document control your plant can audit",
  description:
    "The drafting workflow, document control, and audit trail your refinery actually runs on. OSHA PSM-ready, engineer-routed approvals, and a one-click export of every byte you put in — no lock-in, ever.",
};

export default function MarketingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <Nav />
      <Hero />
      <ProblemSection />
      <CapabilitiesSection />
      <TrustSection />
      <SecuritySection />
      <AudienceSection />
      <FinalCta />
      <Footer />
    </div>
  );
}

// ─── Nav ──────────────────────────────────────────────────────────────────

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
        <nav className="hidden md:flex items-center gap-6 text-sm font-bold text-slate-600">
          <a href="#capabilities" className="hover:text-slate-900">Capabilities</a>
          <a href="#trust" className="hover:text-slate-900">Your Data</a>
          <a href="#security" className="hover:text-slate-900">Security</a>
          <Link href="/data-portability" className="hover:text-slate-900">Portability</Link>
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

// ─── Hero ─────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative overflow-hidden bg-slate-950 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black" />
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-orange-700/60 to-transparent" />
      <div className="relative max-w-6xl mx-auto px-6 py-24 md:py-32">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/30 text-orange-300 text-xs font-bold uppercase tracking-widest mb-6">
            <Zap className="w-3.5 h-3.5" /> For refineries & plants
          </div>
          <h1 className="text-4xl md:text-6xl font-black tracking-tight leading-[1.05] mb-5">
            Document control your{" "}
            <span className="text-orange-500">plant can audit.</span>
          </h1>
          <p className="text-lg md:text-xl text-slate-300 leading-relaxed mb-8 max-w-2xl">
            Manufacturing OS replaces shared drives, scattered email threads, and three-binders-deep
            revision tracking with a single source of truth — built for OSHA PSM 1910.119 compliance,
            engineered so <b className="text-white">you own your data, every byte, end-to-end</b>.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-sm font-black shadow-lg shadow-orange-900/30"
            >
              Start a workspace <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/data-portability"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white/10 hover:bg-white/15 border border-white/20 text-white text-sm font-bold backdrop-blur"
            >
              <ShieldCheck className="w-4 h-4" /> Read the data-portability promise
            </Link>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Full export, any time</span>
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Standard JSON + PDFs</span>
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Public schema, no lock-in</span>
            <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> Encrypted at rest</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Problem ──────────────────────────────────────────────────────────────

function ProblemSection() {
  return (
    <section className="bg-slate-50 border-y border-slate-200">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <div className="max-w-3xl">
          <div className="text-xs font-black uppercase tracking-widest text-orange-600 mb-3">The problem</div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-5">
            Your engineering library is held together with email and goodwill.
          </h2>
          <p className="text-base text-slate-600 leading-relaxed">
            P&amp;IDs live on a network drive nobody remembers the path to. MOC requests live in someone&apos;s
            Outlook. Redlines are scanned PDFs from a printer that hasn&apos;t been serviced since 2019. When
            the auditor asks who approved revision 3, the answer is a phone call to whoever happened to be
            on shift. None of this is OSHA PSM-compliant. None of it scales. And if your document-control
            person retires, the institutional knowledge walks out with them.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4">
          <Pain
            icon={<AlertTriangle className="w-5 h-5 text-red-600" />}
            title="No revision integrity"
            body="The 'latest' PDF on the shared drive is whichever one was last saved. Superseded copies still get printed. The drawing in the operator's hand might be three revisions out of date."
          />
          <Pain
            icon={<AlertTriangle className="w-5 h-5 text-red-600" />}
            title="No approval trail"
            body="A non-engineer signs off on engineering work because the workflow doesn't enforce who's allowed to. The audit fails. Insurance gets nervous. The QC manager gets a phone call at 11pm."
          />
          <Pain
            icon={<AlertTriangle className="w-5 h-5 text-red-600" />}
            title="No exit strategy"
            body="Whatever document-management product you bought five years ago is now twice the price, and the data is in their proprietary format. Migrating is a six-figure project nobody wants to sign off on."
          />
        </div>
      </div>
    </section>
  );
}

function Pain({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
      <div className="p-1.5 bg-red-50 rounded-lg w-fit mb-3">{icon}</div>
      <h3 className="text-sm font-black text-slate-900 mb-1.5">{title}</h3>
      <p className="text-xs text-slate-600 leading-relaxed">{body}</p>
    </div>
  );
}

// ─── Capabilities ─────────────────────────────────────────────────────────

function CapabilitiesSection() {
  return (
    <section id="capabilities" className="bg-white">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <div className="max-w-3xl mb-12">
          <div className="text-xs font-black uppercase tracking-widest text-orange-600 mb-3">What it does</div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-4">
            One system. The whole drawing lifecycle.
          </h2>
          <p className="text-base text-slate-600 leading-relaxed">
            Every drawing has a controlled revision history. Every request has a tracked workflow. Every
            approval has the right engineer&apos;s signature behind it. Every action is in the audit log.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <Capability
            icon={<FileCheck2 className="w-5 h-5 text-blue-700" />}
            iconBg="bg-blue-50"
            title="Controlled Document Library"
            body="Every P&ID, isometric, plot plan, and procedure stored with full revision history. The current revision is unambiguous — superseded ones are visibly marked. IFC-stamped PDFs generated automatically."
            bullets={["Auto-incremented revision numbers", "Side-by-side rev comparison", "Bulk import + library organization", "Checkout to prevent edit conflicts"]}
          />
          <Capability
            icon={<Workflow className="w-5 h-5 text-emerald-700" />}
            iconBg="bg-emerald-50"
            title="Drafting Request Workflow"
            body="Tickets route through Initial Review → Assignment → Drafting → Engineer Approval → IFC Issue. Non-engineers route their approval through a qualified engineer — the system enforces it."
            bullets={["MOC, ISO, As-Built, RFI, Inspection types", "Engineer-routing for sign-off compliance", "Redline markup tools", "Revision request loops with categories"]}
          />
          <Capability
            icon={<GitBranch className="w-5 h-5 text-purple-700" />}
            iconBg="bg-purple-50"
            title="Projects"
            body="Bundle related documents, drawings, and tickets into a project. Track activity across the whole bundle. Onboard contractors with scoped access to just the project they're working on."
            bullets={["Multi-document containers", "Per-project member roles", "Activity feed", "External markup-request sharing"]}
          />
          <Capability
            icon={<ScrollText className="w-5 h-5 text-amber-700" />}
            iconBg="bg-amber-50"
            title="Audit Trail"
            body="Every login, every download, every revision, every approval, every credential change written to an immutable audit log. Filter by user, date, action type. Exportable for regulatory submissions."
            bullets={["Login + access tracking", "Download attribution", "Workflow state change capture", "Data-export events logged"]}
          />
          <Capability
            icon={<AtSign className="w-5 h-5 text-rose-700" />}
            iconBg="bg-rose-50"
            title="Real-time Collaboration"
            body="@-mention any teammate in a comment and they're notified in-app + by email. Watch tickets to subscribe to all activity. Mentions render as clickable chips that survive name changes."
            bullets={["@-mention autocomplete", "Watch / subscribe toggles", "Per-user notification preferences", "Email delivery (optional)"]}
          />
          <Capability
            icon={<Clock className="w-5 h-5 text-indigo-700" />}
            iconBg="bg-indigo-50"
            title="SLA Tracking"
            body="Every request gets a target completion date — either set explicitly or defaulted by request type. Past-due and due-soon badges surface on the request list so nothing gets lost."
            bullets={["Per-type SLA defaults", "Due Soon / Past Due chips", "Configurable warn-ahead windows", "Org-level SLA overrides"]}
          />
        </div>
      </div>
    </section>
  );
}

function Capability({
  icon, iconBg, title, body, bullets,
}: {
  icon: React.ReactNode; iconBg: string; title: string; body: string; bullets: string[];
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm hover:shadow-md hover:border-slate-300 transition-all">
      <div className="flex items-start gap-3 mb-3">
        <div className={`p-2 rounded-lg ${iconBg}`}>{icon}</div>
        <h3 className="text-base font-black text-slate-900 leading-tight pt-1">{title}</h3>
      </div>
      <p className="text-sm text-slate-600 leading-relaxed mb-4">{body}</p>
      <ul className="space-y-1.5">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-2 text-xs text-slate-700">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Trust / Data Portability ─────────────────────────────────────────────

function TrustSection() {
  return (
    <section id="trust" className="bg-gradient-to-b from-emerald-50 to-white border-y border-emerald-200">
      <div className="max-w-6xl mx-auto px-6 py-24">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-100 border border-emerald-300 text-emerald-800 text-xs font-bold uppercase tracking-widest mb-5">
            <ShieldCheck className="w-3.5 h-3.5" /> Your data, your choice
          </div>
          <h2 className="text-3xl md:text-5xl font-black tracking-tight mb-5">
            No lock-in. Not now, not ever.
          </h2>
          <p className="text-base md:text-lg text-slate-700 leading-relaxed mb-8">
            Industrial document control is critical infrastructure. You can&apos;t afford to wonder whether a
            vendor outage or a contract dispute will cost you years of engineering work. So we built three
            independent paths off this platform — and your administrators can use any of them, any time,
            with no special tooling, no support ticket, and no per-export cost.
          </p>
        </div>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
          <ExitPath
            icon={<Download className="w-5 h-5 text-blue-700" />}
            title="1. Direct download"
            body="One click. A single JSON file with every record, plus a manifest with 24-hour presigned URLs for every file. Or a full ZIP with the binaries inline."
          />
          <ExitPath
            icon={<Server className="w-5 h-5 text-emerald-700" />}
            title="2. Scheduled push"
            body="Point us at your own S3 / R2 bucket. We push a fresh export there daily, weekly, or monthly. Credentials encrypted with AES-256-GCM. You own the backups."
          />
          <ExitPath
            icon={<Webhook className="w-5 h-5 text-purple-700" />}
            title="3. Webhook delivery"
            body="HMAC-signed POST to your endpoint with the ZIP body. Build your own pipeline. Re-export to anywhere. Pipe into your data lake."
          />
        </div>

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
      </div>
    </section>
  );
}

function ExitPath({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
      <div className="p-2 bg-slate-100 rounded-lg w-fit mb-3">{icon}</div>
      <h3 className="text-sm font-black text-slate-900 mb-1.5">{title}</h3>
      <p className="text-xs text-slate-600 leading-relaxed">{body}</p>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-700">
      {children}
    </span>
  );
}

// ─── Security ─────────────────────────────────────────────────────────────

function SecuritySection() {
  return (
    <section id="security" className="bg-slate-950 text-white">
      <div className="max-w-6xl mx-auto px-6 py-24">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-300 text-xs font-bold uppercase tracking-widest mb-5">
            <Lock className="w-3.5 h-3.5" /> Security posture
          </div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-5">
            The same things your IT auditor is going to ask about.
          </h2>
          <p className="text-base text-slate-300 leading-relaxed mb-12">
            No vague marketing. The specific technical controls, named.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Security icon={<Lock className="w-5 h-5 text-blue-300" />} title="HTTPS-only transport" body="All traffic over TLS. No HTTP fallback." />
          <Security icon={<Database className="w-5 h-5 text-blue-300" />} title="Encryption at rest" body="Postgres encrypted at rest by Supabase. File storage encrypted at rest by Cloudflare R2." />
          <Security icon={<Server className="w-5 h-5 text-blue-300" />} title="Row-level isolation" body="Postgres RLS enforces every query to its org. No cross-tenant leakage possible at the database layer." />
          <Security icon={<KeyRound className="w-5 h-5 text-blue-300" />} title="AES-256-GCM for secrets" body="Customer-provided S3 credentials encrypted at rest with a key your data team controls." />
          <Security icon={<Users className="w-5 h-5 text-blue-300" />} title="Role-based access" body="Admin, Manager, Supervisor, Engineer (1–4), Drafter, DocCtrl, Requester. Every action gated by role + identity." />
          <Security icon={<ClipboardCheck className="w-5 h-5 text-blue-300" />} title="Audited service-role usage" body="The only code that bypasses RLS is the export endpoint — and exports log themselves to your audit trail." />
        </div>
      </div>
    </section>
  );
}

function Security({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <div className="p-1.5 bg-blue-500/10 rounded-lg w-fit mb-3">{icon}</div>
      <h3 className="text-sm font-black text-white mb-1.5">{title}</h3>
      <p className="text-xs text-slate-400 leading-relaxed">{body}</p>
    </div>
  );
}

// ─── Audience ─────────────────────────────────────────────────────────────

function AudienceSection() {
  return (
    <section className="bg-white">
      <div className="max-w-6xl mx-auto px-6 py-20">
        <div className="max-w-3xl mb-12">
          <div className="text-xs font-black uppercase tracking-widest text-orange-600 mb-3">Who runs on it</div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-4">Built for sites where the drawings matter.</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <Audience
            icon={<Factory className="w-6 h-6 text-orange-700" />}
            title="Refineries & chemical plants"
            body="OSHA PSM 1910.119-aligned workflows. Engineer-routed approvals. Revision lineage that survives audits."
          />
          <Audience
            icon={<Wrench className="w-6 h-6 text-orange-700" />}
            title="EPC firms"
            body="Project containers scope work per-client. Contractor access without exposing the rest of your library."
          />
          <Audience
            icon={<ClipboardCheck className="w-6 h-6 text-orange-700" />}
            title="In-house engineering teams"
            body="One document control system that the engineers, drafters, and supervisors actually want to use."
          />
        </div>
      </div>
    </section>
  );
}

function Audience({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-gradient-to-b from-orange-50 to-white border border-orange-200 rounded-2xl p-6">
      <div className="p-2.5 bg-white rounded-lg w-fit mb-4 shadow-sm border border-orange-100">{icon}</div>
      <h3 className="text-base font-black text-slate-900 mb-2">{title}</h3>
      <p className="text-sm text-slate-600 leading-relaxed">{body}</p>
    </div>
  );
}

// ─── Final CTA ────────────────────────────────────────────────────────────

function FinalCta() {
  return (
    <section className="bg-gradient-to-br from-orange-600 to-orange-700 text-white">
      <div className="max-w-4xl mx-auto px-6 py-20 text-center">
        <h2 className="text-3xl md:text-5xl font-black tracking-tight mb-5">
          Stop running your library off a shared drive.
        </h2>
        <p className="text-base md:text-lg text-orange-50 leading-relaxed mb-8 max-w-2xl mx-auto">
          Stand up a workspace, import your documents, configure your team&apos;s roles. The whole thing
          takes an afternoon. And the day you decide to leave, you take everything with you.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-white hover:bg-slate-50 text-orange-700 text-sm font-black shadow-lg"
          >
            Create your workspace <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-white/10 hover:bg-white/15 border border-white/30 text-white text-sm font-bold backdrop-blur"
          >
            Sign in to existing workspace
          </Link>
        </div>
      </div>
    </section>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="bg-slate-950 text-slate-400 border-t border-slate-800">
      <div className="max-w-6xl mx-auto px-6 py-12 grid grid-cols-2 md:grid-cols-4 gap-8">
        <div className="col-span-2">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-7 h-7 bg-gradient-to-br from-orange-500 to-orange-700 rounded-md flex items-center justify-center">
              <Layout className="w-3.5 h-3.5 text-white" />
            </div>
            <div className="font-black text-white text-sm">
              Manufacturing<span className="text-orange-500">OS</span>
            </div>
          </div>
          <p className="text-xs leading-relaxed max-w-sm">
            Industrial document control + drafting workflow. Built so your data is yours, your audit trail
            is real, and your exit story is one click.
          </p>
        </div>
        <div>
          <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3">Product</div>
          <ul className="space-y-2 text-xs">
            <li><a href="#capabilities" className="hover:text-white">Capabilities</a></li>
            <li><a href="#trust" className="hover:text-white">Your Data</a></li>
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
          <span className="font-mono text-slate-600">v2.1.0 — built for industrial workloads</span>
        </div>
      </div>
    </footer>
  );
}
