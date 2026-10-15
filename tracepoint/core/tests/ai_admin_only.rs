//! AI is for administrator profiles only, enforced in the service (the
//! interface is never trusted). A normal user is refused before any request
//! could leave the PC.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tp_core::service::{Platform, Service};

struct Quiet;
impl Platform for Quiet {
    fn open_path(&self, _: &Path) -> Result<(), String> { Err("no".into()) }
    fn reveal(&self, _: &Path) -> Result<(), String> { Err("no".into()) }
    fn save_dialog(&self, _: &str, _: &str, _: &str) -> Option<PathBuf> { None }
    fn open_dialog(&self, _: &str, _: &str) -> Option<PathBuf> { None }
    fn pick_folder(&self, _: &str) -> Option<PathBuf> { None }
    fn emit(&self, _: &str, _: Value) {}
}

#[test]
fn normal_users_cannot_use_ai() {
    let dir = std::env::temp_dir().join(format!("tp-ai-admin-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let svc = Service::new(Box::new(Quiet), dir.clone(), None).unwrap();
    svc.handle("auth.login", &json!({"email": "ggetzfrid@kernenergy.com", "password": "password"})).unwrap();
    svc.handle("auth.change_password", &json!({"current": "password", "new": "Refinery#Search2026"})).unwrap();
    svc.handle("admin.user.create", &json!({"email": "tech@kernenergy.com", "name": "Tech", "role": "user", "temp_password": "Temp-pass-77"})).unwrap();
    // The admin may reach the AI commands (fails later only for lack of a key).
    assert!(svc.handle("ai.providers", &json!({})).is_ok());
    let e = svc.handle("ai.models", &json!({"provider": "anthropic"})).unwrap_err();
    assert_ne!(e.code, 403, "{}", e.message);

    svc.handle("auth.logout", &json!({})).unwrap();
    svc.handle("auth.login", &json!({"email": "tech@kernenergy.com", "password": "Temp-pass-77"})).unwrap();
    svc.handle("auth.change_password", &json!({"current": "Temp-pass-77", "new": "Tank#Farm-7272"})).unwrap();
    for (cmd, args) in [
        ("ai.providers", json!({})),
        ("ai.models", json!({"provider": "anthropic", "key": "sk-ant-not-real"})),
        ("ai.test", json!({"provider": "anthropic", "key": "sk-ant-not-real", "model": "x"})),
        ("ai.save", json!({"provider": "anthropic", "key": "sk-ant-not-real", "model": "x"})),
        ("search.ai", json!({"query": "frac tower inspections"})),
        ("chat.threads", json!({})),
    ] {
        let e = svc.handle(cmd, &args).expect_err(cmd);
        assert!(e.code == 403 || e.code == 400, "{cmd}: {} {}", e.code, e.message);
        assert!(e.message.contains("administrator") || e.message.contains("Set up AI"), "{cmd}: {}", e.message);
    }
    let cfg = svc.handle("ai.get", &json!({})).unwrap();
    assert_eq!(cfg["can_ai"], false);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn spending_caps_refuse_before_any_request() {
    let dir = std::env::temp_dir().join(format!("tp-ai-cap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let svc = Service::new(Box::new(Quiet), dir.clone(), None).unwrap();
    svc.handle("auth.login", &json!({"email": "ggetzfrid@kernenergy.com", "password": "password"})).unwrap();
    svc.handle("auth.change_password", &json!({"current": "password", "new": "Refinery#Search2026"})).unwrap();
    // Defaults: $25 / month, 40% for indexing, $0.50 per request.
    let b = svc.handle("ai.budget", &json!({})).unwrap();
    assert_eq!(b["budget_usd"], 25.0);
    assert_eq!(b["max_request_usd"], 0.5);
    assert!(b["prices"].as_array().unwrap().len() > 20);
    // A zero budget: refused with a plain explanation, no network call.
    svc.handle("ai.budget.set", &json!({"ai_budget_usd": 0.0})).unwrap();
    let e = svc.handle("ai.test", &json!({"provider": "anthropic", "key": "sk-ant-not-real", "model": "claude-sonnet-5-5"})).unwrap_err();
    assert_eq!(e.code, 402, "{}", e.message);
    assert!(e.message.contains("over your AI budget"), "{}", e.message);
    // A per-request limit below the worst case.
    svc.handle("ai.budget.set", &json!({"ai_budget_usd": 25.0, "ai_max_request_usd": 0.01})).unwrap();
    let e = svc.handle("ai.test", &json!({"provider": "anthropic", "key": "sk-ant-not-real", "model": "claude-opus-5-5"})).unwrap_err();
    assert_eq!(e.code, 402);
    assert!(e.message.contains("per-request limit"), "{}", e.message);
    // Out-of-range settings are rejected.
    assert_eq!(svc.handle("ai.budget.set", &json!({"ai_index_share_pct": 150.0})).unwrap_err().code, 400);
    let _ = std::fs::remove_dir_all(&dir);
}
