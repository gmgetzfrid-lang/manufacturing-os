"use client";

// /admin/data-export — admin self-service "Download Everything" page.
//
// The visible commitment is: every customer can pull their entire dataset
// from this app at any time, in standard formats, no questions asked. This
// page makes that promise tangible — one click, one file.

import React, { useState } from "react";
import Link from "next/link";
import {
  Download, ShieldCheck, AlertTriangle, Loader2, FileJson,
  Lock, Globe, Database, Layers, Clock, ExternalLink, Inbox,
} from "lucide-react";
import { useRole } from "@/components/providers/RoleContext";
import { supabase } from "@/lib/supabase";

export default function DataExportPage() {
  const { activeOrgId, activeRole, userEmail } = useRole();
  const isAuthorized = ["Admin", "Manager", "DocCtrl"].includes(activeRole);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastExportAt, setLastExportAt] = useState<string | null>(null);
  const [lastExportSize, setLastExportSize] = useState<number | null>(null);

  const handleExport = async () => {
    if (!activeOrgId) return;
    setBusy(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Not authenticated");

      const res = await fetch(
        `/api/data-export/structured?orgId=${encodeURIComponent(activeOrgId)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`HTTP ${res.status}: ${errBody}`);
      }
      const blob = await res.blob();
      setLastExportSize(blob.size);
      // Best-effort filename derived from Content-Disposition
      const disp = res.headers.get("Content-Disposition") || "";
      const match = disp.match(/filename="([^"]+)"/);
      const filename = match?.[1] || `manufacturing-os-export-${Date.now()}.json`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setLastExportAt(new Date().toISOString());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-8 pb-20">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-black text-slate-900 flex items-center gap-3">
            <Database className="w-7 h-7 text-emerald-600" />
            Data Export
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Your data, available to you any time. No lock-in, no waiting on support, no special tools required.
          </p>
        </div>

        {/* The big action card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6">
          <div className="flex items-start gap-4">
            <div className="p-3 bg-emerald-100 rounded-xl"><Download className="w-6 h-6 text-emerald-700" /></div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-black text-slate-900">Download every record this organization owns</h2>
              <p className="text-sm text-slate-600 mt-1">
                A single self-describing JSON document with every document, every revision, every ticket, every project,
                every audit-log entry, every comment, and a manifest of every file you&apos;ve uploaded. File contents are
                fetched via 24-hour presigned URLs that work with any HTTP client (curl, wget, your S3 SDK).
              </p>
            </div>
          </div>

          {!isAuthorized ? (
            <div className="mt-5 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-start gap-2">
              <Lock className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Only <b>Admin</b>, <b>Manager</b>, or <b>DocCtrl</b> roles can run a full-org export. Your role: <b>{activeRole}</b>.</span>
            </div>
          ) : (
            <button
              onClick={handleExport}
              disabled={busy || !activeOrgId}
              className="mt-5 inline-flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-black text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 shadow-lg shadow-emerald-900/20 transition-all"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {busy ? "Generating export…" : "Download Everything"}
            </button>
          )}

          {lastExportAt && lastExportSize !== null && (
            <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              Exported {formatBytes(lastExportSize)} at {new Date(lastExportAt).toLocaleString()}. This action is recorded in your audit log.
            </div>
          )}
          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}
        </div>

        {/* Trust pillars */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <Pillar
            icon={<FileJson className="w-5 h-5 text-blue-700" />}
            title="Standard formats"
            body="Vanilla JSON — readable in any text editor or piped through jq. Postgres column names preserved. No proprietary encoding."
          />
          <Pillar
            icon={<Layers className="w-5 h-5 text-purple-700" />}
            title="Schema in the repo"
            body="The exact DDL behind the export is checked into the source repo at supabase/schema.sql. You can reconstruct the data layer in any Postgres-compatible database."
          />
          <Pillar
            icon={<Clock className="w-5 h-5 text-amber-700" />}
            title="Audited, unlimited"
            body="Every export is recorded as a DATA_EXPORT audit-log entry with timestamp, exporter, totals. There is no rate limit and no per-export cost."
          />
          <Pillar
            icon={<Inbox className="w-5 h-5 text-emerald-700" />}
            title="Files included via presigned URLs"
            body="Every PDF, DWG, attachment listed in the manifest with size + a 24-hour signed download URL. Pull the binaries to your own storage with a single wget loop."
          />
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          <h3 className="text-sm font-black text-slate-900 mb-3 flex items-center gap-2">
            <Globe className="w-4 h-4 text-slate-500" /> Public commitment
          </h3>
          <p className="text-sm text-slate-600 mb-3">
            Anyone evaluating this product before signing up can read the data-portability commitment without an account:
          </p>
          <Link
            href="/data-portability"
            target="_blank"
            className="inline-flex items-center gap-1.5 text-sm font-bold text-emerald-700 hover:text-emerald-800 underline"
          >
            View public data-portability page <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}

function Pillar({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <div className="p-1.5 bg-slate-100 rounded-md">{icon}</div>
        <div className="text-sm font-black text-slate-900">{title}</div>
      </div>
      <p className="text-xs text-slate-600 leading-relaxed">{body}</p>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
