"use client";

// AI settings — PER-USER keys only. Every member brings their own API key,
// spends their own money, and is metered against their own monthly cap.
// There is no workspace key: one person's key never pays for another's
// questions, and removing someone's key affects only them.
//
// Keys are write-only: the server stores them and hands back only the last
// 4, so this modal can prove a key exists without ever holding one.
// Claude and OpenAI are the ONLY providers — nothing that can train on
// submitted data is offered, and the server refuses it anyway.

import React, { useEffect, useState } from "react";
import {
  X, Loader2, Plug, CheckCircle2, AlertTriangle, Trash2, KeyRound, Gauge, Users, Sparkles,
} from "lucide-react";
import { useToast } from "@/components/providers/ToastProvider";
import { appConfirm } from "@/components/providers/DialogProvider";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import {
  getAiConnections, saveAiConnection, testAiConnection, removeAiConnection,
  saveEmbeddingKey, removeEmbeddingKey, testEmbeddingKey,
  getAiUsage, setAiCap,
  type AiConnectionInfo, type AiUsageSummary,
} from "@/lib/knowledge";
import { ALLOWED_PROVIDERS, PROVIDER_BLOCK_MESSAGE } from "@/lib/ai/pricing";
import { EMBEDDING_PROVIDERS, defaultEmbeddingModel } from "@/lib/ai/embeddings";

// The complete provider offering — Claude and OpenAI, nothing else, ever.
const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude)", models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"] },
  { id: "openai", label: "OpenAI", models: ["gpt-5.1", "gpt-4o", "gpt-4o-mini"] },
];

const providerAllowed = (p: string) => (ALLOWED_PROVIDERS as readonly string[]).includes(p);

// Persistent inline status line — toasts vanish; this stays until the next
// action, so "did that work?" always has a visible answer.
function Notice({ notice }: { notice: { tone: "ok" | "err"; text: string } | null }) {
  if (!notice) return null;
  return (
    <p className={`text-[11px] font-bold flex items-start gap-1.5 ${
      notice.tone === "ok" ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
      {notice.tone === "ok"
        ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
        : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />}
      <span>{notice.text}</span>
    </p>
  );
}

const NoKeyChip = ({ label }: { label: string }) => (
  <span className="inline-flex items-center gap-1 text-[10px] font-black text-amber-700 dark:text-amber-400">
    <AlertTriangle className="w-3 h-3" /> {label}
  </span>
);

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const fmtTok = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  : String(n);

export function KeyEditor({ orgId, current, onChanged }: {
  orgId: string;
  current: AiConnectionInfo | null;
  onChanged: () => void;
}) {
  const { showToast } = useToast();
  const normalizeProvider = (p: string) =>
    PROVIDERS.some((c) => c.id === p) ? p : PROVIDERS[0].id;

  const [provider, setProvider] = useState(normalizeProvider(current?.provider ?? "anthropic"));
  const [model, setModel] = useState(current?.model ?? "claude-opus-5");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // A row saved before the allowlist existed (e.g. a Gemini key): the server
  // ignores it at ask time — say so instead of silently pretending it works.
  const grandfatheredBlocked = !!current && !providerAllowed(current.provider);

  useEffect(() => {
    setProvider(normalizeProvider(current?.provider ?? "anthropic"));
    setModel(current?.model ?? "claude-opus-5");
    setApiKey("");
  }, [current]);

  const providerMeta = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];

  const save = async () => {
    if (!model.trim()) { showToast({ type: "error", title: "Enter a model name." }); return; }
    if (!apiKey.trim() && !current) { showToast({ type: "error", title: "Paste an API key." }); return; }
    // Before a NEW key goes live: whatever this key sends, the provider
    // receives — questions AND excerpts of indexed documents. (The recorded
    // acceptable-use agreement is signed at first question.)
    if (apiKey.trim()) {
      const proceed = await appConfirm({
        title: "Know what this key carries",
        message:
          "Every question you ask — and text pulled from indexed documents to answer it — is sent to " +
          `${providerMeta.label} under THIS key's account.\n\n` +
          "Use a key you pay for and control. Anthropic and OpenAI do not train on API traffic — " +
          "that's why they're the only providers allowed here.",
        confirmLabel: "Understood — save key",
      });
      if (!proceed) return;
    }
    setBusy("save"); setNotice(null);
    const hadNewKey = !!apiKey.trim();
    try {
      // The server verifies a new key with a live call BEFORE storing it —
      // if this succeeds, the key both works and is saved.
      const last4 = apiKey.trim().slice(-4);
      await saveAiConnection({
        orgId, scope: "personal", provider, model: model.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      setNotice({
        tone: "ok",
        text: hadNewKey
          ? `Key verified and saved — ends in ····${last4}. You're set for questions.`
          : "Settings saved (your existing key is unchanged).",
      });
      showToast({ type: "success", title: hadNewKey ? "Key verified and saved." : "Settings saved." });
      setApiKey("");
      onChanged();
    } catch (e) {
      setNotice({ tone: "err", text: (e as Error).message });
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const test = async () => {
    setBusy("test"); setNotice(null);
    try {
      await testAiConnection({
        orgId, scope: "personal", provider, model: model.trim() || undefined, apiKey: apiKey.trim() || undefined,
      });
      setNotice({
        tone: "ok",
        text: apiKey.trim()
          ? "The key works — now press Save to store it. Testing alone does NOT save."
          : "Your saved key works — the model answered.",
      });
    } catch (e) {
      setNotice({ tone: "err", text: (e as Error).message });
    } finally { setBusy(null); }
  };

  const remove = async () => {
    const ok = await appConfirm({
      title: "Remove your API key?",
      message: "You won't be able to ask AI questions until you add a key again. Nobody else is affected.",
      confirmLabel: "Remove key",
    });
    if (!ok) return;
    setBusy("remove");
    try {
      await removeAiConnection(orgId, "personal");
      showToast({ type: "success", title: "Key removed." });
      onChanged();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)]">
          Your API key (only you use it, only you pay for it)
        </div>
        {current && !grandfatheredBlocked ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-black text-emerald-700 dark:text-emerald-400">
            <KeyRound className="w-3 h-3" /> ACTIVE · ····{current.keyLast4 ?? "????"}
          </span>
        ) : !current ? (
          <NoKeyChip label="NO KEY SAVED YET" />
        ) : null}
      </div>

      {grandfatheredBlocked && (
        <div className="rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 text-[11px] font-bold text-rose-700 dark:text-rose-300">
          Your saved {current?.provider} key is BLOCKED — that provider can train on submitted data.
          Save a Claude or OpenAI key to ask questions again.
        </div>
      )}

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
          placeholder={current ? `Saved · ends in ${current.keyLast4 ?? "????"}` : "Paste your API key"} autoComplete="off" />
      </label>
      <div className="flex items-center gap-2 flex-wrap">
        <Button onClick={() => void save()} disabled={busy !== null}>
          {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Verify &amp; save
        </Button>
        <Button variant="secondary" onClick={() => void test()} disabled={busy !== null || (!current && !apiKey.trim())}>
          {busy === "test" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />} Test only
        </Button>
        {current && (
          <Button variant="secondary" onClick={() => void remove()} disabled={busy !== null}>
            {busy === "remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Remove
          </Button>
        )}
      </div>
      <Notice notice={notice} />
      <p className="text-[10px] text-[var(--color-text-muted)]">
        <b>Verify &amp; save</b> makes a live call with the key first — a key that saves is a key that
        works. <b>Test only</b> never saves anything. Saving again replaces your key; if your provider
        runs out of credits it simply stops answering until you top up.
      </p>
    </div>
  );
}

// ── Embeddings key — a DIFFERENT service from the chat key ────────────────
//
// Anthropic makes no embeddings model. That is a fact about Anthropic's
// product line, not a reason a Claude user can't have meaning-based search:
// the two are unrelated services and nothing stops you holding one key for
// answers and another for vectors. Anthropic's own guidance points Claude
// users at Voyage AI, which is why it's first in the list and the default.
export function EmbeddingKeyEditor({ orgId, current, onChanged }: {
  orgId: string;
  current: AiConnectionInfo | null;
  onChanged: () => void;
}) {
  const { showToast } = useToast();
  const saved = current?.embeddingProvider ?? null;
  const [provider, setProvider] = useState(saved ?? "voyage");
  const [model, setModel] = useState(
    current?.embeddingModel ?? defaultEmbeddingModel((saved ?? "voyage") as "voyage" | "openai"),
  );
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    const p = current?.embeddingProvider ?? "voyage";
    setProvider(p);
    setModel(current?.embeddingModel ?? defaultEmbeddingModel(p as "voyage" | "openai"));
    setApiKey("");
  }, [current]);

  const meta = EMBEDDING_PROVIDERS.find((p) => p.id === provider) ?? EMBEDDING_PROVIDERS[0];
  // An OpenAI CHAT key already works for embeddings, so don't nag for a
  // second copy of the same secret.
  const reusingChatKey = !saved && current?.provider === "openai";

  const save = async () => {
    if (!apiKey.trim() && !saved) {
      setNotice({ tone: "err", text: "Paste your embeddings key first." });
      return;
    }
    setBusy("save"); setNotice(null);
    const hadNewKey = !!apiKey.trim();
    const last4 = apiKey.trim().slice(-4);
    try {
      // Server verifies a new key with a real embed call before storing.
      await saveEmbeddingKey({
        orgId, embeddingProvider: provider, embeddingModel: model.trim() || undefined,
        embeddingApiKey: apiKey.trim() || undefined,
      });
      setNotice({
        tone: "ok",
        text: hadNewKey
          ? `Embeddings key verified and saved — ends in ····${last4}. You can now build the meaning index.`
          : "Embeddings settings saved (your existing key is unchanged).",
      });
      showToast({ type: "success", title: hadNewKey ? "Embeddings key verified and saved." : "Settings saved." });
      setApiKey("");
      onChanged();
    } catch (e) {
      setNotice({ tone: "err", text: (e as Error).message });
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  const test = async () => {
    setBusy("test"); setNotice(null);
    try {
      await testEmbeddingKey({
        orgId, embeddingProvider: provider, embeddingModel: model.trim() || undefined,
        embeddingApiKey: apiKey.trim() || undefined,
      });
      setNotice({
        tone: "ok",
        text: apiKey.trim()
          ? "The key works — now press Verify & save to store it. Testing alone does NOT save."
          : "Your saved embeddings key works.",
      });
    } catch (e) {
      setNotice({ tone: "err", text: (e as Error).message });
    } finally { setBusy(null); }
  };

  const remove = async () => {
    const ok = await appConfirm({
      title: "Remove your embeddings key?",
      message:
        "Meaning-based search stops for you; keyword search is unaffected. Vectors already built "
        + "stay in place and start working again as soon as you add a key back.",
      confirmLabel: "Remove key",
    });
    if (!ok) return;
    setBusy("remove");
    try {
      await removeEmbeddingKey(orgId);
      showToast({ type: "success", title: "Embeddings key removed." });
      onChanged();
    } catch (e) {
      showToast({ type: "error", title: (e as Error).message });
    } finally { setBusy(null); }
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-black uppercase tracking-wider text-[var(--color-text-muted)] flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5" /> Meaning-based search (optional)
        </div>
        {saved ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-black text-emerald-700 dark:text-emerald-400">
            <KeyRound className="w-3 h-3" /> ACTIVE · ····{current?.embeddingKeyLast4 ?? "????"}
          </span>
        ) : reusingChatKey ? null : (
          <NoKeyChip label="NO EMBEDDINGS KEY YET" />
        )}
      </div>

      <p className="text-[11px] text-[var(--color-text-muted)]">
        Finds &ldquo;pipe supports&rdquo; in a standard that says &ldquo;hanger and support details&rdquo;.
        This is a <b>separate service from your chat key</b> — Anthropic doesn&apos;t make an
        embeddings model, so Claude answers the questions and this key builds the index.
        Without it, search stays keyword-only, which is what it has always been.
      </p>

      {reusingChatKey && !saved && (
        <div className="rounded-lg border border-cyan-300 dark:border-cyan-800 bg-cyan-50 dark:bg-cyan-950/30 px-3 py-2 text-[11px] text-cyan-900 dark:text-cyan-200">
          Your OpenAI chat key already works for embeddings — nothing to add here unless you
          want to use a different provider.
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Provider</span>
          <Select value={provider} onChange={(e) => {
            setProvider(e.target.value);
            setModel(defaultEmbeddingModel(e.target.value as "voyage" | "openai"));
          }}>
            {EMBEDDING_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </label>
        <label className="block">
          <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">Model</span>
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            {meta.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </label>
      </div>
      <p className="text-[10px] text-[var(--color-text-muted)]">{meta.hint}</p>

      <label className="block">
        <span className="text-[10px] font-black uppercase tracking-wider text-[var(--color-text-muted)]">
          Embeddings API key {saved ? "(leave blank to keep the saved key)" : ""}
        </span>
        <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
          placeholder={saved ? `Saved · ends in ${current?.embeddingKeyLast4 ?? "????"}` : "Paste your embeddings key"}
          autoComplete="off" />
      </label>

      <div className="flex items-center gap-2 flex-wrap">
        <Button onClick={() => void save()} disabled={busy !== null}>
          {busy === "save" ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Verify &amp; save
        </Button>
        <Button variant="secondary" onClick={() => void test()} disabled={busy !== null || (!saved && !apiKey.trim())}>
          {busy === "test" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />} Test only
        </Button>
        {saved && (
          <Button variant="secondary" onClick={() => void remove()} disabled={busy !== null}>
            {busy === "remove" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Remove
          </Button>
        )}
      </div>
      <Notice notice={notice} />
      <p className="text-[10px] text-[var(--color-text-muted)]">
        <b>Verify &amp; save</b> makes a real embed call with the key first — a key that saves is a key
        that works. Embedding spend bills to <b>your own account with that provider</b>; the meter&apos;s
        figure is an estimate, your provider&apos;s invoice is the real number.
      </p>
    </div>
  );
}

// ── Month meter: est. spend vs cap, tokens, avg prompt; controllers also
//    get the team's month and per-person cap dropdowns. ───────────────────
export function UsagePanel({ orgId }: { orgId: string }) {
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
      <p className="text-[10px] text-[var(--color-text-muted)]">
        These numbers are YOURS alone: every question you ask writes one metering row under your user
        id with the token counts your provider reported for that call — nobody else&apos;s asks are mixed in.
      </p>
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
  const [reloadTick, setReloadTick] = useState(0);

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
              Everyone brings their own API key — your questions run on YOUR key, your money, your
              monthly cap. Keys are stored server-side and never shown again.
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
              <KeyEditor orgId={orgId} current={data.personal}
                onChanged={() => setReloadTick((t) => t + 1)} />
              <EmbeddingKeyEditor orgId={orgId} current={data.personal}
                onChanged={() => setReloadTick((t) => t + 1)} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
