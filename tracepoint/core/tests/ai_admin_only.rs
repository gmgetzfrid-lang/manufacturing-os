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
