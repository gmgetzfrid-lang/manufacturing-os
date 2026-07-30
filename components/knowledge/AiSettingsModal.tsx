"use client";

// AI provider settings — the BYO-key panel. Workspace connection (Admin /
// DocCtrl) + an optional personal override any member can set. Keys are
// write-only: the server stores them and hands back only the last 4, so
// this modal can prove a key exists without ever holding one.

import React, { useCallback, useEffect, useState } from "react";
import { X, Loader2, Plug, CheckCircle2, AlertTriangle, Trash2, KeyRound } from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import {
  getAiConnections, saveAiConnection, testAiConnection, removeAiConnection,
  type AiConnectionInfo,
} from "@/lib/knowledge";

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude)", models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] },
  { id: "openai", label: "OpenAI", models: ["gpt-5.1", "gpt-4o", "gpt-4o-mini"] },
  { id: "gemini", label: "Google (Gemini)", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
];

function ScopeEditor({ orgId, scope, current, locked, onChanged }: {
  orgId: string;
  scope: "org" | "personal";
  current: AiConnectionInfo | null;
  locked: boolean;         // true when the viewer can't edit this scope
  onChanged: () => void;
}) {
  const { showToast } = useToast();
  const [provider, setProvider] = useState(current?.provider ?? "anthropic");
  const [model, setModel] = useState(current?.model ?? "claude-opus-5");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);

  useEffect(() => {
    setProvider(current?.provider ?? "anthropic");
    setModel(current?.model ?? "claude-opus-5");
    setApiKey("");
    setTestResult(null);
  }, [current]);

  const providerMeta = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];

  const save = async () => {
    if (!model.trim()) { showToast({ type: "error", title: "Enter a model name." }); return; }
    if (!apiKey.trim() && !current) { showToast({ type: "error", title: "Paste an API key." }); return; }
    setBusy("save");
    try {
      await saveAiConnection({ orgId, scope, provider, model: model.trim(), apiKey: apiKey.trim() || undefined });
      showToast({ type: "success", title: scope === "org" ? "Workspace AI connection saved." : "Your personal AI connection saved." });
      setApiKey("");
      onChanged();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const test = async () => {
    setBusy("test"); setTestResult(null);
    try {
      await testAiConnection({
        orgId, scope, provider, model: model.trim() || undefined, apiKey: apiKey.trim() || undefined,
      });
      setTestResult("ok");
      showToast({ type: "success", title: "Connection works — the model answered." });
    } catch (e) {
      setTestResult("fail");
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      await removeAiConnection(orgId, scope);
      showToast({ type: "success", title: "Connection removed." });
      onChanged();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  return (
    <div className={`rounded-xl border border-[var(--color-border)] p-4 space-y-3 ${locked ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)]">
          {scope === "org" ? "Workspace connection (everyone uses this by default)" : "Your personal override (only you)"}
        </div>
        {current && (
          <span className="inline-flex items-center gap-1 text-[10px] font-black text-emerald-700 dark:text-emerald-400">
            <KeyRound className="w-3 h-3" /> key ····{current.keyLast4 ?? "????"}
          </span>
        )}
      </div>

      {locked ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          {current
            ? `Configured: ${current.provider} · ${current.model}. Only Admin or Doc Control can change it.`
            : "Not configured yet — ask an Admin or Doc Control to add the workspace API key."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Provider</span>
              <Select value={provider} onChange={(e) => {
                setProvider(e.target.value);
                const meta = PROVIDERS.find((p) => p.id === e.target.value);
                if (meta) setModel(meta.models[0]);
              }}>
                {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            </label>
            <label className="block">
              <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Model</span>
              <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={providerMeta.models[0]} />
            </label>
          </div>
          {/* Clickable suggestions — a datalist hides options that don't match
              the pre-filled text, which made "only one model" a common
              misread. Free-text still works for anything newer. */}
          <div className="flex flex-wrap gap-1.5">
            {providerMeta.models.map((m) => (
              <button key={m} type="button" onClick={() => setModel(m)}
                className={`text-[10px] font-black px-2 py-1 rounded-lg border transition-colors ${
                  model === m
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]"
                    : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
                {m}
              </button>
            ))}
            <span className="text-[10px] text-[var(--color-text-muted)] self-center">or type any model ID</span>
          </div>
          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
              API key {current ? "(leave blank to keep the saved key)" : ""}
            </span>
            <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={current ? `Saved · ends in ${current.keyLast4 ?? "????"}` : "Paste the provider API key"} autoComplete="off" />
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={() => void save()} disabled={busy !== null}>
              {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save
            </Button>
            <Button variant="secondary" onClick={() => void test()} disabled={busy !== null || (!current && !apiKey.trim())}>
              {busy === "test" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />} Test connection
            </Button>
            {current && (
              <Button variant="secondary" onClick={() => void remove()} disabled={busy !== null}>
                {busy === "remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Remove
              </Button>
            )}
            {testResult === "ok" && <CheckCircle2 className="w-4 h-4 text-emerald-600" />}
            {testResult === "fail" && <AlertTriangle className="w-4 h-4 text-rose-600" />}
          </div>
        </>
      )}
    </div>
  );
}

export default function AiSettingsModal({ orgId, open, onClose }: {
  orgId: string; open: boolean; onClose: () => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getAiConnections>> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Bumped after every save/remove so the effect re-fetches masked state.
  const [reloadTick, setReloadTick] = useState(0);
  const refresh = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getAiConnections(orgId)
      .then((next) => { if (!cancelled) { setData(next); setLoadError(null); } })
      .catch((e) => { if (!cancelled) setLoadError((e as Error).message); });
    return () => { cancelled = true; };
  }, [open, orgId, reloadTick]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="w-full max-w-xl bg-[var(--color-surface)] rounded-2xl border border-[var(--color-border)] shadow-xl mt-10"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <div>
            <h2 className="text-base font-black text-[var(--color-text)]">AI settings</h2>
            <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
              Bring your own key — all AI cost runs on the key owner&apos;s provider account, never on this app.
              Keys are stored server-side and never shown again.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[var(--color-surface-2)]"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          {loadError && (
            <div className="rounded-xl border border-rose-300 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-xs font-bold text-rose-700 dark:text-rose-300">{loadError}</div>
          )}
          {!data && !loadError && (
            <div className="py-8 text-center text-[var(--color-text-muted)]"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
          )}
          {data && (
            <>
              <ScopeEditor orgId={orgId} scope="org" current={data.org} locked={!data.canManageOrg} onChanged={() => void refresh()} />
              <ScopeEditor orgId={orgId} scope="personal" current={data.personal} locked={false} onChanged={() => void refresh()} />
              <p className="text-[10px] text-[var(--color-text-muted)]">
                Questions use your personal connection when set, otherwise the workspace one. If a provider
                runs out of credits it simply stops answering until credits are added — nothing else breaks.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
