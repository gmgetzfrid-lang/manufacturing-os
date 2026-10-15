import { useEffect, useState, type ReactNode } from "react";
import { Ban, Check, Cpu, Eye, FileLock2, FolderLock, Globe, HardDrive, KeyRound, ListChecks, Package, ShieldCheck, Terminal, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import type { AppState } from "../lib/types";
import { Mark, Pill } from "../components/ui";

interface About { version: string; local_data: string; temp: string; profiles: string; team_folder?: string | null; protected_roots: string[]; writable: string[]; ai_hosts: string[]; exe?: string; machine: string; index: { source: string } }

export function AboutPage({ state }: { state: AppState }) {
  const [a, setA] = useState<About | null>(null);
  useEffect(() => { api<About>("about").then(setA); }, []);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-8 py-8">
        <div className="flex items-center gap-4">
          <Mark size={60} />
          <div>
            <div className="text-[24px] font-[800] tracking-[0.18em]">TRACEPOINT</div>
            <div className="text-[13px] text-[var(--color-text-muted)]">Version {state.version} · THOR document search, equipment graph and document Q&A</div>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-[color-mix(in_srgb,var(--color-ok)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-ok)_6%,transparent)] p-5">
          <div className="flex items-center gap-2 text-[15px] font-semibold"><ShieldCheck className="size-5 text-[var(--color-ok)]" /> For IT: the short version</div>
          <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
            {[
              "One portable .exe. No installer, no admin rights, no services, no drivers, no registry changes, no scheduled tasks.",
              "Never writes, renames, moves or deletes anything on THOR. Enforced in code by a single write guard.",
              "Reads THOR with the signed-in Windows user's own permissions, using normal shared read access.",
              "No telemetry, no auto-update, no license server. Works with the network unplugged (except optional AI for administrators).",
              "AI is available to administrator profiles only. Normal users' sessions never contact an AI provider.",
              "Passwords: Argon2id. Admin AI keys: XChaCha20-Poly1305 under a password-derived key. No master key.",
            ].map((t) => <li key={t} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-[var(--color-ok)]" />{t}</li>)}
          </ul>
        </div>

        <Block icon={<Eye className="size-4" />} title="What it reads">
          <Row k="THOR files" v="Read-only, with the signed-in user's own permissions: when a person previews or opens a file; when an administrator/indexer rescans (folder listings, names, sizes, dates); and when TracePoint reads document contents (each file is read into memory to extract its text, then released)." note="Never opened for writing. Rescans and content reading run at below-normal priority with a bounded number of parallel reads." />
          <Row k="Index" v={a?.index.source ?? "…"} />
          <Row k="Protected sources" v={a ? a.protected_roots.join(" · ") || "—" : "…"} mono />
        </Block>

        <Block icon={<FolderLock className="size-4" />} title="What it writes — and the only places it can">
          <Row k="Local data" v={a?.local_data ?? "…"} mono note="Settings, the index (thor_knowledge.db), document text (thor_content.db), the PDF engine (bin\\pdfium-157.0.8100.dll), caches. Per Windows user." />
          <Row k="Profiles" v={a?.profiles ?? "…"} mono note="Profile list, password hashes, encrypted AI keys, audit log." />
          <Row k="Team folder" v={a?.team_folder ?? "Not configured"} mono note="Optional shared folder chosen by an administrator. Must be outside THOR's indexed roots." />
          <Row k="Temporary" v={a?.temp ?? "…"} mono note="Read-only copies of files opened for viewing." />
          <Row k="Exports" v="Excel files are written only where the user chooses in the Save dialog (refused inside THOR)." />
        </Block>

        <Block icon={<Globe className="size-4" />} title="Network connections">
          <Row k="THOR" v="SMB to the indexed shares, as the signed-in Windows user." />
          <Row k="AI (optional)" v={a ? a.ai_hosts.join(" · ") : "…"} mono note="HTTPS 443 only, only when an administrator uses an AI feature (Ask THOR, Find with AI, approved AI reading of scanned pages) or tests their key, only to the provider they selected. Each administrator has a monthly spending cap enforced before every request; page images are sent only after the administrator approves a cost estimate. Respects HTTPS_PROXY and the Windows certificate store." />
          <Row k="Nothing else" v="No analytics, update checks, licence calls, fonts or scripts from the internet. The interface is bundled inside the exe." />
        </Block>

        <Block icon={<Cpu className="size-4" />} title="Processes and components">
          <Row k="Processes" v="TracePoint.exe plus the Microsoft Edge WebView2 processes Windows uses to draw the window (msedgewebview2.exe). The THOR indexer runs inside TracePoint.exe — no Python, no scripts, no child processes." />
          <Row k="Opening files" v="Uses the Windows default program for the file type (like double-clicking it in Explorer). By default it opens a read-only temporary copy." />
          <Row k="Built with" v="Rust · SQLite (with FTS5 full-text search) · PDFium 157.0.8100 (BSD-3, the PDF engine in Google Chrome) · Microsoft WebView2 · React · Inter font (OFL). Scanned pages are read with Windows' own OCR engine (Windows.Media.Ocr) when it is available — nothing is installed." note="PDFium is embedded in the exe and unpacked to the local data folder; its SHA-256 is checked against the embedded copy every time TracePoint starts, and replaced if it differs." />
        </Block>

        <Block icon={<KeyRound className="size-4" />} title="Accounts and security">
          <Row k="Sign-in" v="One built-in administrator (temporary password, forced change at first sign-in). Only administrators create profiles and assign roles. Five wrong passwords lock a profile for 5 minutes." />
          <Row k="Passwords" v="Argon2id (64 MiB, 3 passes). Never stored or logged in plain text." />
          <Row k="AI keys" v="Only administrator profiles can save or use an AI key (enforced in the service, not just hidden in the interface). Each key is encrypted with XChaCha20-Poly1305 using a data key that is itself encrypted with a key derived from that user's password. Ciphertexts are bound to their owner. Admin reset erases the key." />
          <Row k="Audit" v="Sign-ins, failures, profile changes, policy changes, index imports and key saves (never key contents) are logged with time, user and computer name." />
        </Block>

        <Block icon={<ListChecks className="size-4" />} title="How IT can verify this">
          <ol className="list-decimal space-y-2 pl-5 text-[13px] leading-relaxed">
            <li><b>Self-test:</b> run <Code>TracePoint.exe --selftest</Code> in a command prompt. It checks the search engine, the THOR write guard (attempts writes into protected paths and confirms they're refused), password hashing and key encryption, the PDF engine (reads a built-in test PDF in memory) and whether Windows OCR is available, and prints PASS/FAIL.</li>
            <li><b>File activity:</b> Sysinternals Process Monitor with filters <Code>Process Name is TracePoint.exe</Code> and <Code>Operation is WriteFile</Code> / <Code>SetDispositionInformationFile</Code> / <Code>SetRenameInformationFile</Code>. Use the app normally: no write, delete or rename appears on a THOR path.</li>
            <li><b>Network:</b> Resource Monitor › Network, or <Code>netstat -b</Code>. Normal users: only SMB to THOR. Administrators using AI: also 443 to the AI host listed above.</li>
            <li><b>Integrity:</b> record the SHA-256 of the exe (<Code>certutil -hashfile TracePoint.exe SHA256</Code>) for an AppLocker/WDAC hash rule if needed.</li>
            <li><b>Remove completely:</b> delete <Code>TracePoint.exe</Code> and the folder <Code>{a?.local_data ?? "%LOCALAPPDATA%\\TracePoint"}</Code>. Nothing else is left behind.</li>
          </ol>
        </Block>

        <div className="mt-6 grid grid-cols-3 gap-3 text-[12.5px]">
          <Tag icon={<Ban className="size-4" />} t="No admin rights" />
          <Tag icon={<Package className="size-4" />} t="No installer" />
          <Tag icon={<Trash2 className="size-4" />} t="Delete to uninstall" />
          <Tag icon={<FileLock2 className="size-4" />} t="Read-only on THOR" />
          <Tag icon={<HardDrive className="size-4" />} t="Works offline" />
          <Tag icon={<Terminal className="size-4" />} t="--selftest for IT" />
        </div>
        <div className="mt-6 text-[12px] text-[var(--color-text-faint)]">{a?.exe} · {a?.machine}</div>
      </div>
    </div>
  );
}

function Block({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="mt-6 card p-5">
      <div className="mb-3 flex items-center gap-2 text-[14.5px] font-semibold"><span className="flex size-7 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent)]">{icon}</span>{title}</div>
      <div className="divide-y divide-[var(--color-border)]">{children}</div>
    </section>
  );
}
function Row({ k, v, note, mono }: { k: string; v: string; note?: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-4 py-2.5 text-[13px]">
      <div className="font-medium text-[var(--color-text-muted)]">{k}</div>
      <div><div className={mono ? "break-all font-mono text-[12.5px]" : ""}>{v}</div>{note && <div className="mt-0.5 text-[12px] text-[var(--color-text-faint)]">{note}</div>}</div>
    </div>
  );
}
function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-[12px]">{children}</code>;
}
function Tag({ icon, t }: { icon: ReactNode; t: string }) {
  return <div className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] p-3"><span className="text-[var(--color-ok)]">{icon}</span>{t}<Pill color="var(--color-ok)" className="ml-auto">✓</Pill></div>;
}
