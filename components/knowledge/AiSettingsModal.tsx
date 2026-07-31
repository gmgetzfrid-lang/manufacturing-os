"use client";

// AI provider settings — the BYO-key panel. Workspace connection (Admin /
// DocCtrl) + an optional personal override any member can set. Keys are
// write-only: the server stores them and hands back only the last 4, so
// this modal can prove a key exists without ever holding one.
//
// Governance lives here too:
//   - Claude and OpenAI are the ONLY providers, any scope — nothing that can
//     train on submitted data is offered, and the server refuses it anyway.
//     Old rows on blocked providers show as BLOCKED (they're skipped at ask
//     time), never quietly active.
//   - the acceptable-use agreement everyone signs is enforced at first
//     question (ask flow), not here — key-saving keeps a lighter "know what
//     this key carries" confirm.
//   - the month meter: est. spend vs the monthly cap, token counts, average
//     prompt size, and (controllers) the whole team's month + cap editor.

import React, { useCallback, useEffect, useState } from "react";
import {
  X, Loader2, Plug, CheckCircle2, AlertTriangle, Trash2, KeyRound, Gauge, Users,
} from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { appConfirm } from "@/components/providers/DialogProvider";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import {
  getAiConnections, saveAiConnection, testAiConnection, removeAiConnection,
  getAiUsage, setAiCap,
  type AiConnectionInfo, type AiUsageSummary,
} from "@/lib/knowledge";
import { ALLOWED_PROVIDERS, PROVIDER_BLOCK_MESSAGE } from "@/lib/ai/pricing";

// The complete provider offering — Claude and OpenAI, nothing else, ever.
// Providers that can train on submitted data (Google AI Studio keys) are
// banned outright, so they don't even appear as a choice.
const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude)", models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] },
  { id: "openai", label: "OpenAI", models: ["gpt-5.1", "gpt-4o", "gpt-4o-mini"] },
];

const providerAllowed = (p: string) => (ALLOWED_PROVIDERS as readonly string[]).includes(p);

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const fmtTok = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  : String(n);

function ScopeEditor({ orgId, scope, current, locked, onChanged }: {
  orgId: string;
  scope: "org" | "personal";
  current: AiConnectionInfo | null;
  locked: boolean;         // true when the viewer can't edit this scope
  onChanged: () => void;
}) {
  const { showToast } = useToast();
  const normalizeProvider = (p: string) =>
    PROVIDERS.some((c) => c.id === p) ? p : PROVIDERS[0].id;

  const [provider, setProvider] = useState(normalizeProvider(current?.provider ?? "anthropic"));
  const [model, setModel] = useState(current?.model ?? "claude-opus-5");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);

  // A row saved before the allowlist existed (e.g. a Gemini key): the server
  // now ignores it at ask time — say so instead of silently pretending it
  // works.
  const grandfatheredBlocked = !!current && !providerAllowed(current.provider);

  useEffect(() => {
    setProvider(normalizeProvider(current?.provider ?? "anthropic"));
    setModel(current?.model ?? "claude-opus-5");
    setApiKey("");
    setTestResult(null);
  }, [current]);

  const providerMeta = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];

  const save = async () => {
    if (!model.trim()) { showToast({ type: "error", title: "Enter a model name." }); return; }
    if (!apiKey.trim() && !current) { showToast({ type: "error", title: "Paste an API key." }); return; }
    // Before a NEW key goes live: whatever this key sends, the provider
    // receives — questions AND excerpts of every indexed document. (The
    // recorded acceptable-use agreement is signed by each user at their
    // first question — this is the key-owner's check.)
    if (apiKey.trim()) {
      const proceed = await appConfirm({
        title: "Know what this key carries",
        message:
          "Every question — and text pulled from your indexed documents to answer it — is sent to " +
          `${PROVIDERS.find((p) => p.id === provider)?.label ?? "this provider"} under THIS key's account.\n\n` +
          "Use a key your company pays for and controls. Anthropic and OpenAI do not train on API " +
          "traffic — that's why they're the only providers allowed here.",
        confirmLabel: "Understood — save key",
      });
      if (!proceed) return;
    }
    setBusy("save");
    try {
      await saveAiConnection({
        orgId, scope, provider, model: model.trim(),
        apiKey: apiKey.trim() || undefined,
      });
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

      {grandfatheredBlocked && (
        <div className="rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-[11px] font-bold text-rose-700 dark:text-rose-300">
          This {current?.provider} key is no longer allowed and is being IGNORED — that provider can
          train on submitted data. Save a Claude or OpenAI key here, or remove it.
        </div>
      )}

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
          <p className="text-[10px] text-[var(--color-text-muted)]">{PROVIDER_BLOCK_MESSAGE}</p>
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

function ConnectionRemoveButton({ orgId, scope, onChanged }: {
  orgId: string; scope: "org" | "personal"; onChanged: () => void;
}) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await removeAiConnection(orgId, scope);
      showToast({ type: "success", title: scope === "org" ? "Workspace connection removed." : "Personal connection removed." });
      onChanged();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(false); }
  };
  return (
    <button onClick={() => void remove()} disabled={busy} title="Remove this connection"
      className="ml-auto shrink-0 inline-flex items-center gap-1 text-[10px] font-black px-2 py-1 rounded-lg border border-rose-300 text-rose-700 dark:text-rose-300 dark:border-rose-800 hover:bg-rose-500/10 transition-colors disabled:opacity-50">
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} Remove
    </button>
  );
}

// ── Month meter: est. spend vs cap, tokens, avg prompt; controllers also
//    get the team's month and the org cap editor. ──────────────────────────
function UsagePanel({ orgId }: { orgId: string }) {
  const { showToast } = useToast();
  const [usage, setUsage] = useState<AiUsageSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [capDraft, setCapDraft] = useState<string>("");
  const [savingCap, setSavingCap] = useState(false);
  const [savingUser, setSavingUser] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAiUsage(orgId)
      .then((u) => {
        if (cancelled) return;
        setUsage(u); setFailed(false);
        if (u.orgCapUsd !== undefined) setCapDraft(String(u.orgCapUsd));
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [orgId, tick]);

  if (failed) return null; // pre-migration DB — the meter simply isn't there yet
  if (!usage) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3 text-center">
        <Loader2 className="w-4 h-4 animate-spin inline text-[var(--color-text-muted)]" />
      </div>
    );
  }

  const totalTokens = usage.inputTokens + usage.outputTokens;
  // "20k of ~200k": extrapolate the month's token budget from what the
  // spend so far actually bought at the models really being used.
  const estTokenBudget = usage.spentUsd > 0.0001 && usage.capUsd > 0
    ? Math.round(totalTokens * (usage.capUsd / usage.spentUsd))
    : null;
  const hot = usage.percent >= 80;
  const capped = usage.percent >= 100;
  const barColor = capped ? "bg-rose-600" : hot ? "bg-amber-500" : "bg-emerald-600";

  const saveCap = async () => {
    const cap = Number(capDraft);
    if (!Number.isFinite(cap) || cap < 0) {
      showToast({ type: "error", title: "Enter a cap in dollars, e.g. 10." });
      return;
    }
    setSavingCap(true);
    try {
      await setAiCap(orgId, cap);
      showToast({ type: "success", title: `Default monthly cap set to ${fmtUsd(cap)} per person.` });
      setTick((t) => t + 1);
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setSavingCap(false); }
  };

  // One person's cap: a preset picked from their row. "default" clears the
  // override so they follow the workspace default again.
  const setMemberCap = async (userId: string, name: string, value: string) => {
    setSavingUser(userId);
    try {
      if (value === "default") {
        await setAiCap(orgId, null, userId);
        showToast({ type: "success", title: `${name} follows the workspace default again.` });
      } else {
        await setAiCap(orgId, Number(value), userId);
        showToast({ type: "success", title: `${name}'s monthly cap set to $${Number(value)}.` });
      }
      setTick((t) => t + 1);
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setSavingUser(null); }
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] px-3.5 py-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] flex items-center gap-1.5">
          <Gauge className="w-3.5 h-3.5" /> Your AI usage — {usage.monthLabel}
        </div>
        <span className={`text-xs font-black ${capped ? "text-rose-600" : hot ? "text-amber-600" : "text-[var(--color-text)]"}`}>
          {fmtUsd(usage.spentUsd)} of {fmtUsd(usage.capUsd)} · {usage.percent}%
        </span>
      </div>
      <div className="h-2 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${Math.min(100, usage.percent)}%` }} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
        <span>
          <b className="text-[var(--color-text)]">{fmtTok(totalTokens)}</b>
          {estTokenBudget ? <> of ~{fmtTok(estTokenBudget)}</> : null} tokens
        </span>
        <span><b className="text-[var(--color-text)]">{usage.asks}</b> questions</span>
        {usage.asks > 0 && (
          <span>avg <b className="text-[var(--color-text)]">{fmtTok(usage.avgPromptTokens)}</b> prompt tokens / question</span>
        )}
      </div>
      {capped ? (
        <p className="text-[11px] font-bold text-rose-600">
          Cap reached — questions are locked until the 1st, unless an Admin raises the cap.
        </p>
      ) : hot ? (
        <p className="text-[11px] font-bold text-amber-600">
          Over 80% of your monthly budget — questions lock at 100% until the 1st.
        </p>
      ) : null}

      {usage.team && (
        <div className="pt-2 border-t border-[var(--color-border)] space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" /> Team this month
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-[10px] text-[var(--color-text-muted)]">Cap $/person</span>
              <Input value={capDraft} onChange={(e) => setCapDraft(e.target.value)}
                className="!w-20 !py-1 text-xs" inputMode="decimal" />
              <Button variant="secondary" onClick={() => void saveCap()} disabled={savingCap}
                className="!px-2.5 !py-1 text-xs">
                {savingCap ? <Loader2 className="w-3 h-3 animate-spin" /> : "Set"}
              </Button>
            </div>
          </div>
          <ul className="space-y-1">
            {usage.team.map((m) => {
              // Each person meters against THEIR cap (override or default).
              const pct = m.capUsd > 0 ? Math.min(100, Math.round((m.spentUsd / m.capUsd) * 100)) : 100;
              const presets = [5, 10, 15, 20, 25, 30, 35, 50, 75, 100];
              if (m.hasOverride && !presets.includes(m.capUsd)) presets.push(m.capUsd);
              return (
                <li key={m.userId} className="flex items-center gap-2 text-[11px]">
                  <span className="w-32 truncate font-bold text-[var(--color-text)]">{m.name}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-[var(--color-surface-2)] overflow-hidden">
                    <div className={`h-full rounded-full ${pct >= 100 ? "bg-rose-600" : pct >= 80 ? "bg-amber-500" : "bg-emerald-600"}`}
                      style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-[88px] text-right text-[var(--color-text-muted)] tabular-nums">
                    {fmtUsd(m.spentUsd)} · {m.asks} asks
                  </span>
                  <select
                    value={m.hasOverride ? String(m.capUsd) : "default"}
                    disabled={savingUser === m.userId}
                    onChange={(e) => void setMemberCap(m.userId, m.name, e.target.value)}
                    title={`${m.name}'s monthly cap`}
                    className={`shrink-0 w-[74px] text-[10px] font-black rounded-lg border px-1 py-0.5 bg-[var(--color-surface)] cursor-pointer disabled:opacity-50 ${
                      m.hasOverride
                        ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                        : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}>
                    <option value="default">${usage.orgCapUsd ?? usage.capUsd} def</option>
                    {presets.sort((a, b) => a - b).map((p) => (
                      <option key={p} value={String(p)}>${p}</option>
                    ))}
                  </select>
                </li>
              );
            })}
          </ul>
          <p className="text-[10px] text-[var(--color-text-muted)]">
            Each person meters against their own cap — the dropdown sets it (highlighted = personal
            override, &ldquo;def&rdquo; = the workspace default). Estimated from exact provider token counts ×
            published rates; questions lock server-side at 100% and reset on the 1st (UTC).
          </p>
        </div>
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
              <UsagePanel orgId={orgId} />
              {/* At-a-glance truth: which connections exist RIGHT NOW, which
                  one YOUR questions use, and how to remove each. The actual
                  keys are write-only by design — last 4 only. */}
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/50 px-3.5 py-3">
                <div className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)] mb-2">Your connections</div>
                {!data.org && !data.personal ? (
                  <p className="text-xs text-[var(--color-text-muted)]">None yet — add a key below.</p>
                ) : (() => {
                  // A key on a blocked provider is ignored at ask time — the
                  // badges must tell that truth, for either slot.
                  const orgUsable = !!data.org && providerAllowed(data.org.provider);
                  const personalUsable = !!data.personal && providerAllowed(data.personal.provider);
                  return (
                  <ul className="space-y-1.5">
                    {data.org && (
                      <li className="flex items-center gap-2 text-xs">
                        {!orgUsable
                          ? <span className="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded bg-rose-600 text-white">BLOCKED</span>
                          : !personalUsable
                          ? <span className="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded bg-emerald-600 text-white">ACTIVE</span>
                          : <span className="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)]">STANDBY</span>}
                        <span className="font-bold text-[var(--color-text)]">Workspace:</span>
                        <span className="text-[var(--color-text-muted)] truncate">{data.org.provider} · {data.org.model} · key ····{data.org.keyLast4 ?? "????"}</span>
                        {data.canManageOrg && (
                          <ConnectionRemoveButton orgId={orgId} scope="org" onChanged={() => void refresh()} />
                        )}
                      </li>
                    )}
                    {data.personal && (
                      <li className="flex items-center gap-2 text-xs">
                        {personalUsable
                          ? <span className="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded bg-emerald-600 text-white">ACTIVE</span>
                          : <span className="shrink-0 text-[9px] font-black px-1.5 py-0.5 rounded bg-rose-600 text-white">BLOCKED</span>}
                        <span className="font-bold text-[var(--color-text)]">Personal:</span>
                        <span className="text-[var(--color-text-muted)] truncate">{data.personal.provider} · {data.personal.model} · key ····{data.personal.keyLast4 ?? "????"}</span>
                        <ConnectionRemoveButton orgId={orgId} scope="personal" onChanged={() => void refresh()} />
                      </li>
                    )}
                  </ul>
                  );
                })()}
                <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
                  There are exactly two slots: one <b>workspace</b> connection (everyone&apos;s default) and one
                  <b> personal</b> one (just you — it wins over the workspace one whenever it exists). Saving a
                  slot again <b>replaces</b> it — that&apos;s how you switch provider or model. ACTIVE = the one
                  answering <i>your</i> questions right now.
                </p>
              </div>
              <ScopeEditor orgId={orgId} scope="org" current={data.org} locked={!data.canManageOrg} onChanged={() => void refresh()} />
              <ScopeEditor orgId={orgId} scope="personal" current={data.personal} locked={false} onChanged={() => void refresh()} />
              <p className="text-[10px] text-[var(--color-text-muted)]">
                If a provider runs out of credits it simply stops answering until credits are added — nothing
                else breaks.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
