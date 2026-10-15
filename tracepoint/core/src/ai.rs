//! AI providers, called directly over HTTPS from the user's PC with the
//! user's own key. Supported: Anthropic (Claude), OpenAI, Google Gemini.
//!
//! The guided setup lists the models the key can actually use (live from the
//! provider) and shows a reasoning-level control only when the chosen model
//! supports it. Anthropic reports reasoning support per model; for OpenAI and
//! Gemini the setting is confirmed by a test call and dropped if rejected.
//!
//! Keys are passed in by the caller (decrypted for this call only) and are
//! never logged, stored here or returned to the interface.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Anthropic,
    Openai,
    Gemini,
}

impl Provider {
    pub fn parse(s: &str) -> Option<Provider> {
        match s.to_ascii_lowercase().as_str() {
            "anthropic" | "claude" => Some(Provider::Anthropic),
            "openai" => Some(Provider::Openai),
            "gemini" | "google" => Some(Provider::Gemini),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::Openai => "openai",
            Provider::Gemini => "gemini",
        }
    }
    pub fn host(self) -> &'static str {
        match self {
            Provider::Anthropic => "api.anthropic.com",
            Provider::Openai => "api.openai.com",
            Provider::Gemini => "generativelanguage.googleapis.com",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ProviderInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub company: &'static str,
    pub key_prefix: &'static str,
    pub key_url: &'static str,
    pub key_help: &'static str,
    pub host: &'static str,
    pub recommended_model: &'static str,
}

pub fn providers() -> Vec<ProviderInfo> {
    vec![
        ProviderInfo {
            id: "anthropic",
            name: "Claude",
            company: "Anthropic",
            key_prefix: "sk-ant-",
            key_url: "https://console.anthropic.com/settings/keys",
            key_help: "Sign in at console.anthropic.com → Settings → API keys → Create key. Keys start with sk-ant-.",
            host: "api.anthropic.com",
            recommended_model: "claude-opus-5-5",
        },
        ProviderInfo {
            id: "openai",
            name: "ChatGPT models",
            company: "OpenAI",
            key_prefix: "sk-",
            key_url: "https://platform.openai.com/api-keys",
            key_help: "Sign in at platform.openai.com → API keys → Create new secret key. Keys start with sk-.",
            host: "api.openai.com",
            recommended_model: "",
        },
        ProviderInfo {
            id: "gemini",
            name: "Gemini",
            company: "Google",
            key_prefix: "AIza",
            key_url: "https://aistudio.google.com/app/apikey",
            key_help: "Sign in at aistudio.google.com → Get API key → Create API key. Keys start with AIza.",
            host: "generativelanguage.googleapis.com",
            recommended_model: "",
        },
    ]
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Level {
    pub id: String,
    pub label: String,
    pub hint: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub context: Option<u64>,
    pub max_output: Option<u64>,
    pub reasoning: Vec<Level>,
    pub default_reasoning: Option<String>,
    pub recommended: bool,
    pub vision: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiChoice {
    pub provider: Provider,
    pub model: String,
    #[serde(default)]
    pub reasoning: Option<String>,
}

#[derive(Debug)]
pub struct AiError {
    pub message: String,
    pub status: Option<u16>,
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn ai_err<T>(m: impl Into<String>) -> Result<T, AiError> {
    Err(AiError { message: m.into(), status: None })
}

fn level(id: &str) -> Level {
    let (label, hint) = match id {
        "minimal" => ("Minimal", "Fastest answers, almost no deliberation"),
        "low" => ("Quick", "Fast, light reasoning — good for lookups"),
        "medium" => ("Balanced", "Good default for most questions"),
        "high" => ("Thorough", "Slower, more careful — technical comparisons"),
        "xhigh" => ("Deep", "Hard engineering questions across many documents"),
        "max" => ("Maximum", "Slowest and most expensive; use when correctness matters most"),
        _ => (id, ""),
    };
    Level { id: id.into(), label: label.into(), hint: hint.into() }
}

/// HTTP agent: Windows certificate store (works behind TLS inspection) and
/// the system/environment proxy.
pub fn agent(timeout_secs: u64) -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig};
    let mut cfg = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout_secs)))
        .http_status_as_error(false)
        .user_agent("TracePoint/2.0")
        .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build());
    if let Some(p) = ureq::Proxy::try_from_env() {
        cfg = cfg.proxy(Some(p));
    }
    cfg.build().into()
}

fn friendly(provider: Provider, status: u16, body: &str) -> AiError {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| body.chars().take(240).collect());
    let key_problem = status == 400 && detail.to_lowercase().contains("api key");
    let msg = match status {
        _ if key_problem => format!("{} rejected the API key. Check it was copied completely and is still active. ({detail})", provider.as_str()),
        401 | 403 => format!("{} rejected the API key. Check it was copied completely and is still active. ({detail})", provider.as_str()),
        402 => "The account has no remaining credit. Add billing on the provider's website.".to_string(),
        404 => format!("The provider doesn't recognise this model for your key. Pick another model. ({detail})"),
        429 => format!("Rate limit or quota reached. Wait a minute and try again. ({detail})"),
        400 => format!("The provider refused the request: {detail}"),
        s if s >= 500 => format!("The provider is having problems (HTTP {s}). Try again shortly."),
        s => format!("HTTP {s}: {detail}"),
    };
    AiError { message: msg, status: Some(status) }
}

fn net_err(e: ureq::Error) -> AiError {
    AiError {
        message: format!("Could not reach the AI provider: {e}. If your company uses a proxy, set HTTPS_PROXY or ask IT to allow the provider's address."),
        status: None,
    }
}

fn get_json(provider: Provider, url: &str, headers: &[(&str, &str)]) -> Result<Value, AiError> {
    let mut req = agent(30).get(url);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let mut resp = req.call().map_err(net_err)?;
    let status = resp.status().as_u16();
    let body = resp.body_mut().read_to_string().unwrap_or_default();
    if status >= 400 {
        return Err(friendly(provider, status, &body));
    }
    serde_json::from_str(&body).map_err(|e| AiError { message: format!("Unexpected reply: {e}"), status: None })
}

// ── Model lists ──────────────────────────────────────────────────────

pub fn list_models(provider: Provider, key: &str) -> Result<Vec<ModelInfo>, AiError> {
    match provider {
        Provider::Anthropic => anthropic_models(key),
        Provider::Openai => openai_models(key),
        Provider::Gemini => gemini_models(key),
    }
}

fn anthropic_models(key: &str) -> Result<Vec<ModelInfo>, AiError> {
    let mut out = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..5 {
        let url = match &after {
            Some(a) => format!("https://api.anthropic.com/v1/models?limit=100&after_id={a}"),
            None => "https://api.anthropic.com/v1/models?limit=100".to_string(),
        };
        let v = get_json(Provider::Anthropic, &url, &[("x-api-key", key), ("anthropic-version", "2023-06-01")])?;
        for m in v["data"].as_array().cloned().unwrap_or_default() {
            let id = m["id"].as_str().unwrap_or("").to_string();
            let caps = &m["capabilities"];
            let mut reasoning = Vec::new();
            if caps["effort"]["supported"].as_bool().unwrap_or(false) {
                for l in ["low", "medium", "high", "xhigh", "max"] {
                    if caps["effort"][l]["supported"].as_bool().unwrap_or(false) {
                        reasoning.push(level(l));
                    }
                }
            } else if caps["thinking"]["types"]["enabled"]["supported"].as_bool().unwrap_or(false) {
                // Older models: a thinking budget mapped from these levels.
                reasoning = vec![level("low"), level("medium"), level("high")];
            }
            let default_reasoning = if reasoning.is_empty() {
                None
            } else if id.starts_with("claude-opus-5-5") || id.starts_with("claude-haiku-5-5") {
                Some("medium".into())
            } else {
                Some("high".into())
            };
            out.push(ModelInfo {
                name: m["display_name"].as_str().unwrap_or(&id).to_string(),
                context: m["max_input_tokens"].as_u64(),
                max_output: m["max_tokens"].as_u64(),
                vision: caps["image_input"]["supported"].as_bool().unwrap_or(false),
                recommended: id == "claude-opus-5-5",
                reasoning,
                default_reasoning,
                id,
            });
        }
        if v["has_more"].as_bool().unwrap_or(false) {
            after = v["last_id"].as_str().map(|s| s.to_string());
        } else {
            break;
        }
    }
    Ok(out)
}

fn openai_reasoning(id: &str) -> bool {
    let b = id.as_bytes();
    (b.first() == Some(&b'o') && b.get(1).map(|c| c.is_ascii_digit()).unwrap_or(false)) || id.starts_with("gpt-5") || id.starts_with("gpt-6")
}

fn openai_models(key: &str) -> Result<Vec<ModelInfo>, AiError> {
    let auth = format!("Bearer {key}");
    let v = get_json(Provider::Openai, "https://api.openai.com/v1/models", &[("Authorization", &auth)])?;
    const SKIP: &[&str] = &["embedding", "whisper", "tts", "dall-e", "image", "audio", "realtime", "moderation", "transcribe", "search", "davinci", "babbage", "instruct", "codex"];
    let mut out: Vec<ModelInfo> = v["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .filter(|id| (id.starts_with("gpt-") || id.starts_with("chatgpt-") || openai_reasoning(id)) && !SKIP.iter().any(|s| id.contains(s)))
        .map(|id| {
            let r = openai_reasoning(&id);
            ModelInfo {
                name: id.clone(),
                context: None,
                max_output: None,
                reasoning: if r { vec![level("low"), level("medium"), level("high")] } else { vec![] },
                default_reasoning: r.then(|| "medium".to_string()),
                recommended: false,
                vision: true,
                id,
            }
        })
        .collect();
    out.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(out)
}

fn gemini_models(key: &str) -> Result<Vec<ModelInfo>, AiError> {
    let v = get_json(Provider::Gemini, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", &[("x-goog-api-key", key)])?;
    let mut out: Vec<ModelInfo> = v["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m["supportedGenerationMethods"].as_array().map(|a| a.iter().any(|x| x == "generateContent")).unwrap_or(false))
        .filter(|m| {
            let n = m["name"].as_str().unwrap_or("");
            n.contains("gemini") && !n.contains("embedding") && !n.contains("image") && !n.contains("tts") && !n.contains("audio")
        })
        .map(|m| {
            let id = m["name"].as_str().unwrap_or("").trim_start_matches("models/").to_string();
            let thinks = m["thinking"].as_bool().unwrap_or(false);
            ModelInfo {
                name: m["displayName"].as_str().unwrap_or(&id).to_string(),
                context: m["inputTokenLimit"].as_u64(),
                max_output: m["outputTokenLimit"].as_u64(),
                reasoning: if thinks { vec![level("low"), level("medium"), level("high")] } else { vec![] },
                default_reasoning: thinks.then(|| "medium".to_string()),
                recommended: false,
                vision: true,
                id,
            }
        })
        .collect();
    out.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(out)
}

// ── Chat ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Msg {
    pub role: String,
    pub content: String,
    /// PNG images (base64) shown to the model before the text (page images
    /// for AI reading of scanned documents).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
}

fn anthropic_content(m: &Msg) -> Value {
    if m.images.is_empty() {
        return json!(m.content);
    }
    let mut parts: Vec<Value> = m.images.iter().map(|b| json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b}})).collect();
    parts.push(json!({"type": "text", "text": m.content}));
    Value::Array(parts)
}

fn openai_content(m: &Msg) -> Value {
    if m.images.is_empty() {
        return json!(m.content);
    }
    let mut parts: Vec<Value> = m.images.iter().map(|b| json!({"type": "image_url", "image_url": {"url": format!("data:image/png;base64,{b}"), "detail": "high"}})).collect();
    parts.push(json!({"type": "text", "text": m.content}));
    Value::Array(parts)
}

fn gemini_parts(m: &Msg) -> Value {
    let mut parts: Vec<Value> = m.images.iter().map(|b| json!({"inline_data": {"mime_type": "image/png", "data": b}})).collect();
    parts.push(json!({"text": m.content}));
    Value::Array(parts)
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct ChatResult {
    pub text: String,
    pub model: String,
    /// Input tokens billed at the normal rate (cache reads/writes excluded).
    pub input_tokens: u64,
    /// Output tokens, including any thinking/reasoning tokens (billed as output).
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub stop_reason: String,
    pub reasoning_used: Option<String>,
}

/// The output-token ceiling actually sent (older Claude models raise it to
/// fit a thinking budget). Spending caps reserve against this.
pub fn effective_max_tokens(choice: &AiChoice, max_tokens: u32) -> u32 {
    let legacy_budget = choice.model.starts_with("claude-haiku-4") || choice.model.starts_with("claude-sonnet-4-5") || choice.model.starts_with("claude-opus-4-5") || choice.model.starts_with("claude-3");
    match (&choice.reasoning, choice.provider) {
        (Some(r), Provider::Anthropic) if legacy_budget => {
            let budget = match r.as_str() {
                "low" => 2048,
                "medium" => 6000,
                _ => 12000,
            };
            max_tokens.max(budget + 4000)
        }
        _ => max_tokens,
    }
}

/// Models where Anthropic's refusal fallback (server-side, "default" routing)
/// is recommended.
fn anthropic_fallback(model: &str) -> bool {
    ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"].iter().any(|m| model == *m)
}

fn sse_lines(reader: impl std::io::Read, mut on_data: impl FnMut(&str) -> bool) -> Result<(), AiError> {
    let r = BufReader::new(reader);
    for line in r.lines() {
        let line = line.map_err(|e| AiError { message: format!("Connection dropped: {e}"), status: None })?;
        if let Some(d) = line.strip_prefix("data:") {
            let d = d.trim();
            if d == "[DONE]" {
                break;
            }
            if !on_data(d) {
                break;
            }
        }
    }
    Ok(())
}

pub fn chat(choice: &AiChoice, key: &str, system: &str, messages: &[Msg], max_tokens: u32, cancel: &dyn Fn() -> bool, on_delta: &mut dyn FnMut(&str)) -> Result<ChatResult, AiError> {
    match choice.provider {
        Provider::Anthropic => chat_anthropic(choice, key, system, messages, max_tokens, cancel, on_delta, true),
        Provider::Openai => chat_openai(choice, key, system, messages, max_tokens, cancel, on_delta, true),
        Provider::Gemini => chat_gemini(choice, key, system, messages, max_tokens, cancel, on_delta, true),
    }
}

#[allow(clippy::too_many_arguments)]
fn chat_anthropic(choice: &AiChoice, key: &str, system: &str, messages: &[Msg], max_tokens: u32, cancel: &dyn Fn() -> bool, on_delta: &mut dyn FnMut(&str), with_extras: bool) -> Result<ChatResult, AiError> {
    let mut body = json!({
        "model": choice.model,
        "max_tokens": max_tokens,
        "stream": true,
        "system": system,
        "messages": messages.iter().map(|m| json!({"role": m.role, "content": anthropic_content(m)})).collect::<Vec<_>>(),
    });
    // Long, repeated instructions (Ask THOR, AI find) are cached for 5 minutes:
    // later calls read them at a tenth of the input price.
    if system.len() > 4000 {
        body["system"] = json!([{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]);
    }
    let legacy_budget = choice.model.starts_with("claude-haiku-4") || choice.model.starts_with("claude-sonnet-4-5") || choice.model.starts_with("claude-opus-4-5") || choice.model.starts_with("claude-3");
    if let Some(r) = &choice.reasoning {
        if legacy_budget {
            let budget = match r.as_str() {
                "low" => 2048,
                "medium" => 6000,
                _ => 12000,
            };
            body["thinking"] = json!({"type": "enabled", "budget_tokens": budget});
            body["max_tokens"] = json!(max_tokens.max(budget + 4000));
        } else {
            body["thinking"] = json!({"type": "adaptive"});
            body["output_config"] = json!({"effort": r});
        }
    }
    let mut req = agent(600).post("https://api.anthropic.com/v1/messages").header("x-api-key", key).header("anthropic-version", "2023-06-01").header("content-type", "application/json");
    if with_extras && anthropic_fallback(&choice.model) {
        body["fallbacks"] = json!("default");
        req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
    }
    let mut resp = req.send(body.to_string()).map_err(net_err)?;
    let status = resp.status().as_u16();
    if status >= 400 {
        let txt = resp.body_mut().read_to_string().unwrap_or_default();
        if status == 400 && with_extras && (txt.contains("fallback") || txt.contains("anthropic-beta")) {
            return chat_anthropic(choice, key, system, messages, max_tokens, cancel, on_delta, false);
        }
        return Err(friendly(Provider::Anthropic, status, &txt));
    }
    let mut res = ChatResult { model: choice.model.clone(), reasoning_used: choice.reasoning.clone(), ..Default::default() };
    let mut err: Option<String> = None;
    sse_lines(resp.into_body().into_reader(), |d| {
        if cancel() {
            return false;
        }
        let Ok(v) = serde_json::from_str::<Value>(d) else { return true };
        match v["type"].as_str().unwrap_or("") {
            "message_start" => {
                let u = &v["message"]["usage"];
                res.input_tokens = u["input_tokens"].as_u64().unwrap_or(0);
                res.cache_read_tokens = u["cache_read_input_tokens"].as_u64().unwrap_or(0);
                res.cache_write_tokens = u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                if let Some(m) = v["message"]["model"].as_str() {
                    res.model = m.to_string();
                }
            }
            "content_block_delta" => {
                if v["delta"]["type"] == "text_delta" {
                    let t = v["delta"]["text"].as_str().unwrap_or("");
                    res.text.push_str(t);
                    on_delta(t);
                }
            }
            "message_delta" => {
                res.stop_reason = v["delta"]["stop_reason"].as_str().unwrap_or("").to_string();
                res.output_tokens = v["usage"]["output_tokens"].as_u64().unwrap_or(res.output_tokens);
            }
            "error" => {
                err = Some(v["error"]["message"].as_str().unwrap_or("stream error").to_string());
                return false;
            }
            _ => {}
        }
        true
    })?;
    if let Some(e) = err {
        return ai_err(format!("The provider stopped the answer: {e}"));
    }
    if res.stop_reason == "refusal" && res.text.is_empty() {
        return ai_err("The model declined to answer this request. Try rephrasing it.");
    }
    Ok(res)
}

#[allow(clippy::too_many_arguments)]
fn chat_openai(choice: &AiChoice, key: &str, system: &str, messages: &[Msg], max_tokens: u32, cancel: &dyn Fn() -> bool, on_delta: &mut dyn FnMut(&str), with_reasoning: bool) -> Result<ChatResult, AiError> {
    let mut msgs = vec![json!({"role": "system", "content": system})];
    msgs.extend(messages.iter().map(|m| json!({"role": m.role, "content": openai_content(m)})));
    let mut body = json!({
        "model": choice.model,
        "messages": msgs,
        "stream": true,
        "stream_options": {"include_usage": true},
        "max_completion_tokens": max_tokens,
    });
    let use_reasoning = with_reasoning && choice.reasoning.is_some() && openai_reasoning(&choice.model);
    if use_reasoning {
        body["reasoning_effort"] = json!(choice.reasoning.clone().unwrap());
    }
    let auth = format!("Bearer {key}");
    let mut resp = agent(600)
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", &auth)
        .header("content-type", "application/json")
        .send(body.to_string())
        .map_err(net_err)?;
    let status = resp.status().as_u16();
    if status >= 400 {
        let txt = resp.body_mut().read_to_string().unwrap_or_default();
        if status == 400 && use_reasoning && txt.contains("reasoning") {
            return chat_openai(choice, key, system, messages, max_tokens, cancel, on_delta, false);
        }
        return Err(friendly(Provider::Openai, status, &txt));
    }
    let mut res = ChatResult { model: choice.model.clone(), reasoning_used: if use_reasoning { choice.reasoning.clone() } else { None }, ..Default::default() };
    sse_lines(resp.into_body().into_reader(), |d| {
        if cancel() {
            return false;
        }
        let Ok(v) = serde_json::from_str::<Value>(d) else { return true };
        if let Some(t) = v.pointer("/choices/0/delta/content").and_then(|t| t.as_str()) {
            res.text.push_str(t);
            on_delta(t);
        }
        if let Some(r) = v.pointer("/choices/0/finish_reason").and_then(|t| t.as_str()) {
            res.stop_reason = r.to_string();
        }
        if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
            // prompt_tokens includes cached tokens; completion_tokens includes reasoning.
            let cached = u.pointer("/prompt_tokens_details/cached_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
            res.input_tokens = u["prompt_tokens"].as_u64().unwrap_or(0).saturating_sub(cached);
            res.cache_read_tokens = cached;
            res.output_tokens = u["completion_tokens"].as_u64().unwrap_or(0);
        }
        true
    })?;
    Ok(res)
}

#[allow(clippy::too_many_arguments)]
fn chat_gemini(choice: &AiChoice, key: &str, system: &str, messages: &[Msg], max_tokens: u32, cancel: &dyn Fn() -> bool, on_delta: &mut dyn FnMut(&str), with_reasoning: bool) -> Result<ChatResult, AiError> {
    let contents: Vec<Value> = messages
        .iter()
        .map(|m| json!({"role": if m.role == "assistant" { "model" } else { "user" }, "parts": gemini_parts(m)}))
        .collect();
    let mut body = json!({
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": contents,
        "generationConfig": {"maxOutputTokens": max_tokens},
    });
    let use_reasoning = with_reasoning && choice.reasoning.is_some();
    if use_reasoning {
        let budget = match choice.reasoning.as_deref() {
            Some("low") => 1024,
            Some("medium") => 8192,
            _ => 24576,
        };
        body["generationConfig"]["thinkingConfig"] = json!({"thinkingBudget": budget});
    }
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse", choice.model);
    let mut resp = agent(600).post(&url).header("x-goog-api-key", key).header("content-type", "application/json").send(body.to_string()).map_err(net_err)?;
    let status = resp.status().as_u16();
    if status >= 400 {
        let txt = resp.body_mut().read_to_string().unwrap_or_default();
        if status == 400 && use_reasoning && txt.to_lowercase().contains("think") {
            return chat_gemini(choice, key, system, messages, max_tokens, cancel, on_delta, false);
        }
        return Err(friendly(Provider::Gemini, status, &txt));
    }
    let mut res = ChatResult { model: choice.model.clone(), reasoning_used: if use_reasoning { choice.reasoning.clone() } else { None }, ..Default::default() };
    sse_lines(resp.into_body().into_reader(), |d| {
        if cancel() {
            return false;
        }
        let Ok(v) = serde_json::from_str::<Value>(d) else { return true };
        if let Some(parts) = v.pointer("/candidates/0/content/parts").and_then(|p| p.as_array()) {
            for p in parts {
                if p["thought"].as_bool().unwrap_or(false) {
                    continue;
                }
                if let Some(t) = p["text"].as_str() {
                    res.text.push_str(t);
                    on_delta(t);
                }
            }
        }
        if let Some(r) = v.pointer("/candidates/0/finishReason").and_then(|t| t.as_str()) {
            res.stop_reason = r.to_string();
        }
        if let Some(u) = v.get("usageMetadata") {
            // Thinking tokens are billed as output but reported separately.
            let cached = u["cachedContentTokenCount"].as_u64().unwrap_or(0);
            res.input_tokens = u["promptTokenCount"].as_u64().unwrap_or(res.input_tokens + res.cache_read_tokens).saturating_sub(cached);
            res.cache_read_tokens = cached;
            res.output_tokens = u["candidatesTokenCount"].as_u64().unwrap_or(0) + u["thoughtsTokenCount"].as_u64().unwrap_or(0);
        }
        true
    })?;
    Ok(res)
}

/// One short call to prove the key, model and reasoning setting all work.
pub fn test(choice: &AiChoice, key: &str) -> Result<ChatResult, AiError> {
    let msgs = vec![Msg { role: "user".into(), content: "Reply with exactly: TracePoint connected".into(), images: vec![] }];
    chat(choice, key, "You are a connection test. Reply with the exact words requested.", &msgs, 2000, &|| false, &mut |_| {})
}

pub fn mask_key(key: &str) -> String {
    let k = key.trim();
    if k.len() <= 10 {
        return "••••".into();
    }
    format!("{}…{}", &k[..k.len().min(7)], &k[k.len() - 4..])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn basics() {
        assert!(openai_reasoning("o3-mini"));
        assert!(openai_reasoning("gpt-5.1"));
        assert!(!openai_reasoning("gpt-4o"));
        assert_eq!(mask_key("sk-ant-api03-abcdefghijklmnop"), "sk-ant-…mnop");
        assert_eq!(Provider::parse("Claude"), Some(Provider::Anthropic));
        assert!(anthropic_fallback("claude-opus-5-5"));
        let mut got = Vec::new();
        sse_lines("event: x\ndata: {\"a\":1}\n\ndata: [DONE]\ndata: {\"b\":2}\n".as_bytes(), |d| {
            got.push(d.to_string());
            true
        })
        .unwrap();
        assert_eq!(got, vec!["{\"a\":1}"]);
    }
}

#[cfg(test)]
mod live {
    #[test]
    #[ignore]
    fn bad_key_is_friendly() {
        for p in [super::Provider::Anthropic, super::Provider::Openai, super::Provider::Gemini] {
            let e = super::list_models(p, "sk-invalid-key-for-test").err().unwrap();
            println!("{:?}: {:?} {}", p, e.status, e.message);
        }
    }
}
