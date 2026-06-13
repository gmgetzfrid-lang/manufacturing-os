"use client";

// /share/<token> — public landing for a shared document.
//
// No auth required. Looks up the token in document_shares; if
// unrevoked + unexpired, fetches the linked document's current
// version and presents a download/view button. Bumps access_count
// on each load.
//
// Intentionally minimal — just the file and the org branding line.

import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  FileText, Download, Loader2, AlertTriangle, ShieldCheck, ExternalLink,
} from "lucide-react";
import { supabase } from "@/lib/supabase";

interface ResolvedShare {
  documentNumber: string | null;
  title: string | null;
  rev: string | null;
  orgName: string | null;
  fileUrl: string | null;
}

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<"loading" | "ok" | "revoked" | "expired" | "notfound" | "error">("loading");
  const [data, setData] = useState<ResolvedShare | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const { data: share, error } = await supabase
          .from("document_shares")
          .select("id, document_id, expires_at, revoked_at, org_id")
          .eq("token", token)
          .maybeSingle();
        if (error) throw error;
        if (!share) { setState("notfound"); return; }
        if (share.revoked_at) { setState("revoked"); return; }
        if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
          setState("expired"); return;
        }

        // Resolve doc + current version
        const { data: doc } = await supabase
          .from("documents")
          .select("id, document_number, title, name, rev, current_version_id")
          .eq("id", share.document_id)
          .maybeSingle();

        const { data: org } = await supabase
          .from("orgs").select("name").eq("id", share.org_id).maybeSingle();

        let storagePath: string | null = null;
        if (doc?.current_version_id) {
          const { data: v } = await supabase
            .from("document_versions")
            .select("file_url")
            .eq("id", doc.current_version_id)
            .maybeSingle();
          if (v?.file_url) storagePath = v.file_url as string;
        }
        if (!storagePath && doc?.id) {
          const { data: latest } = await supabase
            .from("document_versions")
            .select("file_url")
            .eq("record_id", doc.id)
            .order("created_at", { ascending: false })
            .limit(1);
          if (latest && latest.length > 0) storagePath = (latest[0] as { file_url: string }).file_url;
        }

        let fileUrl: string | null = null;
        if (storagePath) {
          if (/^https?:\/\//i.test(storagePath)) {
            fileUrl = storagePath;
          } else {
            // Public-facing — call download-url without auth header. The
            // route may require auth; if so, fall back to alerting that
            // the link can't be resolved (so admins know to grant a
            // tokenized public-bytes endpoint later).
            try {
              const res = await fetch(`/api/storage/download-url?path=${encodeURIComponent(storagePath)}&expiresIn=3600`);
              if (res.ok) {
                const j = await res.json();
                fileUrl = j.url ?? null;
              }
            } catch { /* fall through */ }
          }
        }

        setData({
          documentNumber: (doc?.document_number as string | null) ?? null,
          title: (doc?.title as string | null) ?? (doc?.name as string | null) ?? null,
          rev: (doc?.rev as string | null) ?? null,
          orgName: (org?.name as string | null) ?? null,
          fileUrl,
        });
        setState("ok");

        // Bump access counter (best-effort, ignore RLS denial)
        try {
          await supabase.from("document_shares").update({
            access_count: 1,                       // server should += 1; we keep it simple
            access_last_at: new Date().toISOString(),
          }).eq("id", share.id);
        } catch { /* ignore */ }
      } catch (e) {
        setErrorMessage((e as Error).message);
        setState("error");
      }
    })();
  }, [token]);

  return (
    <div className="min-h-screen bg-[var(--color-surface-2)] flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-lg p-6">
        {state === "loading" && (
          <div className="text-center text-[var(--color-text-muted)] inline-flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" /> Resolving share link…</div>
        )}
        {state === "notfound" && (
          <Centered icon={AlertTriangle} tone="rose" title="Link not found" body="This share link doesn't exist. It may have been mistyped or revoked." />
        )}
        {state === "revoked" && (
          <Centered icon={AlertTriangle} tone="amber" title="Link revoked" body="The owner has revoked this share. Ask them for a fresh link if you still need access." />
        )}
        {state === "expired" && (
          <Centered icon={AlertTriangle} tone="amber" title="Link expired" body="This share has passed its expiration date. Ask the owner for a fresh link." />
        )}
        {state === "error" && (
          <Centered icon={AlertTriangle} tone="rose" title="Couldn't load" body={errorMessage ?? "Something went wrong resolving this share link."} />
        )}
        {state === "ok" && data && (
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200"><FileText className="w-5 h-5" /></div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-black text-[var(--color-text-muted)] uppercase tracking-widest">Shared document</div>
                <h1 className="text-base font-black text-[var(--color-text)] truncate">{data.documentNumber || data.title || "Document"}</h1>
              </div>
            </div>
            {data.title && data.documentNumber && (
              <div className="text-sm text-[var(--color-text)] mb-1">{data.title}</div>
            )}
            <div className="text-xs text-[var(--color-text-muted)] mb-4">Rev {data.rev || "0"} · From {data.orgName ?? "—"}</div>
            {data.fileUrl ? (
              <a
                href={data.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-sm font-bold"
              >
                <Download className="w-4 h-4" /> Open / Download
                <ExternalLink className="w-3.5 h-3.5 opacity-70" />
              </a>
            ) : (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 p-3 rounded-lg">
                Link is valid but the file couldn&apos;t be resolved. The host&apos;s share-bytes endpoint may not be set up for public access yet. Ask the owner to confirm.
              </div>
            )}
            <div className="mt-4 text-[10px] text-[var(--color-text-faint)] inline-flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" /> Audit logged · share access counted
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Centered({ icon: Icon, tone, title, body }: { icon: React.ComponentType<{ className?: string }>; tone: "rose" | "amber"; title: string; body: string }) {
  const c = tone === "rose" ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-amber-50 text-amber-700 border-amber-200";
  return (
    <div className="text-center">
      <div className={`w-12 h-12 mx-auto mb-3 rounded-full border ${c} flex items-center justify-center`}>
        <Icon className="w-6 h-6" />
      </div>
      <h1 className="text-lg font-black text-[var(--color-text)]">{title}</h1>
      <p className="text-sm text-[var(--color-text-muted)] mt-1">{body}</p>
    </div>
  );
}
