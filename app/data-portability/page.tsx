// /data-portability — public commitment page. Anyone evaluating the
// product before signing up can read this without an account.
//
// The commitments here are policy, not features — pointing customers
// at the actual /admin/data-export feature backs them up with code.
// Drawn like the app: the answer in the title block, the facts that back
// it in ruled cells, and each list as a ruled table on a white sheet.

import Link from "next/link";
import { ExternalLink, Download } from "lucide-react";
import { PageHero, PageBody } from "@/components/ui/PageHero";
import { PublicNav, PublicFooter } from "@/components/marketing/PublicChrome";
import { btnPrimary, btnQuiet, link, tbl, Section } from "@/components/admin/kit";

export const metadata = {
  title: "Data Portability | Manufacturing OS",
  description: "Your data, exportable any time, in standard formats, with no lock-in.",
};

const INSIDE: Array<[string, string]> = [
  ["One JSON file", "Self-describing, every column preserved. Read it with jq or load it into Postgres."],
  ["Every record type", "Documents and revisions, tickets, projects, audit log, checkouts, markups, comments, history and configuration."],
  ["File manifest", "Every PDF, DWG and redline with its size and a 24-hour signed download link."],
  ["Schema DDL", "The full database schema is public at supabase/schema.sql in the source tree."],
];

const USES: Array<[string, string]> = [
  ["Offsite backup", "Run it monthly and keep it on your own S3, R2 or NAS."],
  ["Compliance archive", "Every revision and audit row, for OSHA PSM 1910.119 retention."],
  ["Moving to another system", "Standard JSON and standard PDFs. Any vendor can import them."],
  ["Disaster recovery", "If our service is down, your export still holds every file you uploaded."],
];

const SECURITY: Array<[string, string]> = [
  ["Encrypted in transit and at rest", "HTTPS only. Postgres encrypted by Supabase, files by Cloudflare R2."],
  ["Row-level isolation", "Postgres RLS limits every query to your organization's rows."],
  ["Audited service-role use", "Only the export endpoint crosses RLS, and every export is logged to your audit trail."],
];

const ALSO: Array<[string, string]> = [
  ["Scheduled exports to your bucket", "Daily, weekly or monthly pushes to S3-compatible storage, with optional pruning. Set up under Admin, Data export."],
  ["One ZIP with files inside", "The JSON and your files in one archive. Files past the size cap stay listed with their download links."],
];

function TwoCol({ head, rows }: { head: [string, string]; rows: Array<[string, string]> }) {
  return (
    <div className={tbl.wrap}>
      <table className={tbl.table}>
        <thead className={`${tbl.thead} max-sm:hidden`}>
          <tr><th className={`${tbl.th} w-[min(300px,40%)]`}>{head[0]}</th><th className={tbl.th}>{head[1]}</th></tr>
        </thead>
        <tbody className={tbl.tbody}>
          {rows.map(([a, b]) => (
            <tr key={a} className="max-sm:flex max-sm:flex-col max-sm:py-2">
              <td className={`${tbl.td} max-sm:py-0.5 font-semibold text-[var(--color-text)]`}>{a}</td>
              <td className={`${tbl.td} max-sm:py-0.5 text-[var(--color-text-muted)]`}>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DataPortabilityPage() {
  return (
    <div className="min-h-dvh bg-[var(--color-canvas)] text-[var(--color-text)]">
      <PublicNav base="/about" />
      <main className="max-w-[1200px] mx-auto px-4 sm:px-6 pt-8 pb-20">
        <PageHero
          kicker="Data portability"
          title="No lock-in, ever."
          sub="Any admin can download everything your organization put in, at any time, in standard formats, with one click."
          facts={[
            { label: "Ways to export", value: "3" },
            { label: "Formats", value: "JSON, ZIP" },
            { label: "Fee", value: "None" },
          ]}
          primary={
            <Link href="/admin/data-export" className={btnPrimary}>
              <Download className="w-4 h-4" /> Run an export
            </Link>
          }
        />

        <PageBody>
          <Section label="What's in the export">
            <TwoCol head={["Part", "What it is"]} rows={INSIDE} />
          </Section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-8">
            <Section label="What you can do with it">
              <TwoCol head={["Use", "How"]} rows={USES} />
            </Section>
            <Section label="Security">
              <TwoCol head={["Control", "What it means"]} rows={SECURITY} />
            </Section>
          </div>

          <Section label="Also available">
            <TwoCol head={["Option", "How it works"]} rows={ALSO} />
          </Section>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-6 border-t border-[var(--color-border-strong)]">
            <p className="text-[15px] text-[var(--color-text-muted)]">Have an account? Check the promise against your own data.</p>
            <Link href="/admin/data-export" className={btnQuiet}>Open Data export</Link>
            <a
              href="https://github.com/gmgetzfrid-lang/manufacturing-os/blob/master/supabase/schema.sql"
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1 text-[15px] ${link}`}
            >
              View the database schema <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <span className="sm:ml-auto text-[13px] text-[var(--color-text-muted)]">Last updated May 29, 2026</span>
          </div>
        </PageBody>
      </main>
      <PublicFooter base="/about" />
    </div>
  );
}
