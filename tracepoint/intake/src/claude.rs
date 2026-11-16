//! Reading pages with Claude over HTTPS (Anthropic Messages API), with the
//! user's key. Answers come back as JSON in a fixed shape (structured
//! outputs), streamed so long folders never hit a timeout.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::time::Duration;

pub const DEFAULT_MODEL: &str = "claude-opus-5-5";

/// Models offered in Settings: (id, label).
pub const MODELS: &[(&str, &str)] = &[
    ("claude-opus-5-5", "Claude Opus 5.5 (most accurate, recommended)"),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5 (about half the cost)"),
];

/// USD per million tokens: input, output, cache write, cache read.
pub fn prices(model: &str) -> (f64, f64, f64, f64) {
    match model {
        m if m.starts_with("claude-sonnet-5-5") => (2.0, 10.0, 2.5, 0.10),
        m if m.starts_with("claude-sonnet") => (2.0, 10.0, 2.5, 0.20),
        m if m.starts_with("claude-haiku-5-5") => (0.10, 0.50, 0.125, 0.01),
        m if m.starts_with("claude-fable-5-2") => (8.0, 40.0, 10.0, 0.20),
        _ => (4.0, 20.0, 5.0, 0.20),
    }
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_read_tokens: u64,
    pub cost_usd: f64,
}

impl Usage {
    pub fn add(&mut self, o: &Usage) {
        self.input_tokens += o.input_tokens;
        self.output_tokens += o.output_tokens;
        self.cache_write_tokens += o.cache_write_tokens;
        self.cache_read_tokens += o.cache_read_tokens;
        self.cost_usd += o.cost_usd;
    }
    fn price(&mut self, model: &str) {
        let (i, o, w, r) = prices(model);
        self.cost_usd = (self.input_tokens as f64 * i + self.output_tokens as f64 * o + self.cache_write_tokens as f64 * w + self.cache_read_tokens as f64 * r) / 1_000_000.0;
    }
}

#[derive(Debug)]
pub struct ClaudeError {
    pub message: String,
    /// Worth trying again later (network, overload, rate limit).
    pub retryable: bool,
    /// Seconds the API asked us to wait (rate limits).
    pub retry_after: u64,
}

impl std::fmt::Display for ClaudeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn err(m: impl Into<String>, retryable: bool) -> ClaudeError {
    ClaudeError { message: m.into(), retryable, retry_after: 0 }
}

/// The API address. Fixed to Anthropic; overridable only for testing.
fn api_base() -> String {
    std::env::var("INTAKE_API_BASE").ok().filter(|s| s.starts_with("http://127.0.0.1")).unwrap_or_else(|| "https://api.anthropic.com".into())
}

/// HTTP agent: Windows certificate store (works behind TLS inspection) and
/// the system/environment proxy.
fn agent(timeout_secs: u64) -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig};
    let mut cfg = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout_secs)))
        .http_status_as_error(false)
        .user_agent("ScanIntake/1.0")
        .tls_config(TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).build());
    if let Some(p) = ureq::Proxy::try_from_env() {
        cfg = cfg.proxy(Some(p));
    }
    cfg.build().into()
}

fn friendly(status: u16, body: &str) -> ClaudeError {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| body.chars().take(300).collect());
    match status {
        401 | 403 => err(format!("The API key was rejected. Check it in Settings. ({detail})"), false),
        402 => err("The Anthropic account has no remaining credit. Add billing at console.anthropic.com.", false),
        400 if detail.to_lowercase().contains("credit balance") => err("The Anthropic account has no remaining credit. Add billing at console.anthropic.com.", false),
        404 => err(format!("The model isn't available to this key. Pick another model in Settings. ({detail})"), false),
        408 | 409 | 429 => err(format!("Rate limit reached; will try again. ({detail})"), true),
        413 => err(format!("This folder is too large to send in one piece ({detail})."), false),
        s if s >= 500 => err(format!("Anthropic is busy or having problems (HTTP {s}); will try again."), true),
        s => err(format!("HTTP {s}: {detail}"), false),
    }
}

pub struct Request<'a> {
    pub model: &'a str,
    pub effort: &'a str,
    pub system: &'a str,
    /// User content blocks (images, text). Mark cache points yourself.
    pub content: Vec<Value>,
    pub schema: Value,
    pub max_tokens: u32,
}

pub struct Response {
    pub json: Value,
    pub usage: Usage,
    pub model: String,
}

/// Check a key with the smallest possible request.
pub fn check_key(key: &str, model: &str) -> Result<String, ClaudeError> {
    let mut resp = agent(30)
        .get(&format!("{}/v1/models/{model}", api_base()))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .call()
        .map_err(|e| err(format!("Could not reach api.anthropic.com: {e}. If your company uses a proxy, ask IT to allow api.anthropic.com."), true))?;
    let status = resp.status().as_u16();
    let body = resp.body_mut().read_to_string().unwrap_or_default();
    if status >= 400 {
        return Err(friendly(status, &body));
    }
    let v: Value = serde_json::from_str(&body).unwrap_or(json!({}));
    Ok(v["display_name"].as_str().unwrap_or(model).to_string())
}

/// One structured request, retried on network trouble and overload.
pub fn ask(key: &str, req: &Request, cancel: &dyn Fn() -> bool) -> Result<Response, ClaudeError> {
    let mut last = err("no attempt", true);
    for attempt in 0..5 {
        if cancel() {
            return Err(err("Stopped", false));
        }
        match ask_once(key, req, attempt == 0) {
            Ok(r) => return Ok(r),
            Err(e) if e.retryable => {
                let wait = [10u64, 30, 60, 120, 240][attempt as usize].max(e.retry_after.min(900));
                for _ in 0..wait {
                    if cancel() {
                        return Err(err("Stopped", false));
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
                last = e;
            }
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

fn ask_once(key: &str, req: &Request, with_fallback: bool) -> Result<Response, ClaudeError> {
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "stream": true,
        "thinking": {"type": "adaptive"},
        "output_config": {
            "effort": req.effort,
            "format": {"type": "json_schema", "schema": req.schema},
        },
        "system": [{"type": "text", "text": req.system, "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": req.content}],
    });
    let mut r = agent(1800)
        .post(&format!("{}/v1/messages", api_base()))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");
    let fallback = with_fallback && (req.model.starts_with("claude-opus-5") || req.model.starts_with("claude-sonnet-5-5") || req.model.starts_with("claude-fable-5"));
    if fallback {
        body["fallbacks"] = json!("default");
        r = r.header("anthropic-beta", "server-side-fallback-2026-07-01");
    }
    let mut resp = r.send(body.to_string()).map_err(|e| err(format!("Could not reach api.anthropic.com: {e}"), true))?;
    let status = resp.status().as_u16();
    if status >= 400 {
        let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(0);
        let txt = resp.body_mut().read_to_string().unwrap_or_default();
        if status == 400 && fallback && (txt.contains("fallback") || txt.contains("anthropic-beta")) {
            return ask_once(key, req, false);
        }
        let mut e = friendly(status, &txt);
        e.retry_after = retry_after;
        return Err(e);
    }
    let mut text = String::new();
    let mut usage = Usage::default();
    let mut stop = String::new();
    let mut model = req.model.to_string();
    let mut stream_err: Option<String> = None;
    let reader = BufReader::new(resp.into_body().into_reader());
    for line in reader.lines() {
        let line = line.map_err(|e| err(format!("Connection dropped: {e}"), true))?;
        let Some(d) = line.strip_prefix("data:") else { continue };
        let Ok(v) = serde_json::from_str::<Value>(d.trim()) else { continue };
        match v["type"].as_str().unwrap_or("") {
            "message_start" => {
                let u = &v["message"]["usage"];
                usage.input_tokens += u["input_tokens"].as_u64().unwrap_or(0);
                usage.cache_read_tokens += u["cache_read_input_tokens"].as_u64().unwrap_or(0);
                usage.cache_write_tokens += u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                if let Some(m) = v["message"]["model"].as_str() {
                    model = m.to_string();
                }
            }
            "content_block_start" => {
                // A fallback switch starts a fresh answer.
                if v["content_block"]["type"] == "fallback" {
                    text.clear();
                }
            }
            "content_block_delta" => {
                if v["delta"]["type"] == "text_delta" {
                    text.push_str(v["delta"]["text"].as_str().unwrap_or(""));
                }
            }
            "message_delta" => {
                if let Some(s) = v["delta"]["stop_reason"].as_str() {
                    stop = s.to_string();
                }
                if let Some(o) = v["usage"]["output_tokens"].as_u64() {
                    usage.output_tokens = o;
                }
            }
            "error" => {
                stream_err = Some(v["error"]["message"].as_str().unwrap_or("stream error").to_string());
                break;
            }
            _ => {}
        }
    }
    if let Some(e) = stream_err {
        let overloaded = e.to_lowercase().contains("overload");
        return Err(err(format!("Anthropic stopped the answer: {e}"), overloaded || !e.is_empty()));
    }
    usage.price(&model);
    match stop.as_str() {
        "refusal" => return Err(err("The model declined to read these pages.", false)),
        "max_tokens" => return Err(err("The answer was cut off (too long).", false)),
        _ => {}
    }
    let json: Value = serde_json::from_str(text.trim()).map_err(|e| err(format!("The answer was not valid JSON ({e})."), true))?;
    Ok(Response { json, usage, model })
}

pub fn mask_key(key: &str) -> String {
    let k = key.trim();
    if k.len() < 12 {
        return "••••".into();
    }
    format!("{}…{}", &k[..7], &k[k.len() - 4..])
}
