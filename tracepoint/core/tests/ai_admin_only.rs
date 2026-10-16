//! AI is for TracePoint administrators only, enforced in the service (the
//! interface is never trusted), within a team-wide monthly budget. A normal
//! user is refused before any request could leave the PC.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tp_core::acl::Identity;
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

fn person(name: &str, sid: &str) -> Identity {
    Identity { sid: sid.into(), account: format!("KERN\\{name}"), display: name.into(), also: vec![] }
}

#[test]
fn normal_users_cannot_use_ai() {
    let dir = std::env::temp_dir().join(format!("tp-ai-admin-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let team = dir.join("team");
    let admin = Service::new_as(Box::new(Quiet), dir.join("pc1"), person("ggetzfrid", "S-1-5-21-1-1")).unwrap();
    admin.handle("team.setup", &json!({"path": team.display().to_string()})).unwrap();
    // The admin may reach the AI commands (fails later only for lack of a key).
    assert!(admin.handle("ai.providers", &json!({})).is_ok());
    let e = admin.handle("ai.models", &json!({"provider": "anthropic"})).unwrap_err();
    assert_ne!(e.code, 403, "{}", e.message);

    std::fs::create_dir_all(dir.join("pc2")).unwrap();
    std::fs::write(dir.join("pc2/config.json"), json!({"team_folder": team.display().to_string()}).to_string()).unwrap();
    let user = Service::new_as(Box::new(Quiet), dir.join("pc2"), person("tech", "S-1-5-21-1-2")).unwrap();
    for (cmd, args) in [
        ("ai.providers", json!({})),
        ("ai.models", json!({"provider": "anthropic", "key": "sk-ant-not-real"})),
        ("ai.test", json!({"provider": "anthropic", "key": "sk-ant-not-real", "model": "x"})),
        ("ai.save", json!({"provider": "anthropic", "key": "sk-ant-not-real", "model": "x"})),
        ("ai.budget", json!({})),
        ("airead.start", json!({"count": 1})),
    ] {
        let e = user.handle(cmd, &args).expect_err(cmd);
        assert!(e.code == 403 || e.code == 400, "{cmd}: {} {}", e.code, e.message);
        assert!(e.message.contains("administrator") || e.message.contains("Set up AI"), "{cmd}: {}", e.message);
    }
    for gone in ["search.ai", "chat.threads", "chat.ask", "auth.login"] {
        assert_eq!(user.handle(gone, &json!({})).unwrap_err().code, 404, "{gone} no longer exists");
    }
    let cfg = user.handle("ai.get", &json!({})).unwrap();
    assert_eq!(cfg["can_ai"], false);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn spending_caps_refuse_before_any_request() {
    let dir = std::env::temp_dir().join(format!("tp-ai-cap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let svc = Service::new_as(Box::new(Quiet), dir.clone(), person("ggetzfrid", "S-1-5-21-1-1")).unwrap();
    // Defaults: $25 / month for the team, $0.50 per request.
    let b = svc.handle("ai.budget", &json!({})).unwrap();
    assert_eq!(b["budget_usd"], 25.0);
    assert_eq!(b["max_request_usd"], 0.5);
    assert!(b["prices"].as_array().unwrap().len() > 20);
    // A zero budget: refused with a plain explanation, no network call.
    svc.handle("ai.budget.set", &json!({"ai_budget_usd": 0.0})).unwrap();
    let e = svc.handle("ai.test", &json!({"provider": "anthropic", "key": "sk-ant-not-real", "model": "claude-sonnet-5-5"})).unwrap_err();
    assert_eq!(e.code, 402, "{}", e.message);
    assert!(e.message.contains("over the team's AI budget"), "{}", e.message);
    // A per-request limit below the worst case.
    svc.handle("ai.budget.set", &json!({"ai_budget_usd": 25.0, "ai_max_request_usd": 0.01})).unwrap();
    let e = svc.handle("ai.test", &json!({"provider": "anthropic", "key": "sk-ant-not-real", "model": "claude-opus-5-5"})).unwrap_err();
    assert_eq!(e.code, 402);
    assert!(e.message.contains("per-request limit"), "{}", e.message);
    // Out-of-range settings are rejected.
    assert_eq!(svc.handle("ai.budget.set", &json!({"ai_budget_usd": -1.0})).unwrap_err().code, 400);
    let _ = std::fs::remove_dir_all(&dir);
}
