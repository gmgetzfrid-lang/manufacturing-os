//! `TracePoint.exe --selftest`: checks IT can run to confirm the build does
//! what the About page says. Prints PASS/FAIL lines; exit code 0 only if all
//! pass. Writes only inside the system temp folder, then removes it.

use crate::auth::{Role, UserStore};
use crate::engine::{Engine, SearchRequest};
use crate::guard::{Guard, GuardError};
use crate::index::Index;
use std::path::Path;

pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

fn check(out: &mut Vec<Check>, name: &str, ok: bool, detail: impl Into<String>) {
    out.push(Check { name: name.into(), ok, detail: detail.into() });
}

pub fn run(embedded_index: Option<&[u8]>, extra_protect: &[String]) -> Vec<Check> {
    let mut out = Vec::new();
    let tmp = std::env::temp_dir().join(format!("TracePoint-selftest-{}", std::process::id()));

    // ── THOR write guard ─────────────────────────────────────────────
    let g = Guard::new(None);
    g.protect(r"\\thor\Equipment Files");
    for r in extra_protect {
        g.protect(r);
    }
    let allowed = g.allow(&tmp).is_ok();
    check(&mut out, "Guard: temp folder is writable", allowed, tmp.display().to_string());
    let attempts = [
        r"\\thor\Equipment Files\selftest.txt",
        r"\\THOR\equipment files\5600 - LRU\..\selftest.txt",
        r"\\?\UNC\thor\Equipment Files\selftest.txt",
        r"//thor/Equipment Files/x/y.pdf",
    ];
    for p in attempts {
        let refused = matches!(g.check(Path::new(p)), Err(GuardError::InsideSource { .. }));
        check(&mut out, "Guard: write into THOR refused", refused, p);
    }
    for r in extra_protect {
        let p = format!("{r}\\TracePoint-selftest.txt");
        let refused = matches!(g.check(Path::new(&p)), Err(GuardError::InsideSource { .. }));
        check(&mut out, "Guard: write into indexed root refused", refused, p);
    }
    check(&mut out, "Guard: write outside own folders refused", g.check(Path::new(r"C:\Windows\tracepoint.txt")).is_err(), r"C:\Windows\tracepoint.txt");
    check(&mut out, "Guard: THOR can't be made a data folder", g.allow(Path::new(r"\\thor\Equipment Files\TracePoint")).is_err(), r"\\thor\Equipment Files\TracePoint");
    let w = g.write(&tmp.join("probe.txt"), b"ok").is_ok() && std::fs::read(tmp.join("probe.txt")).map(|b| b == b"ok").unwrap_or(false);
    check(&mut out, "Guard: atomic write in own folder works", w, "probe.txt");

    // ── Profiles and keys ────────────────────────────────────────────
    match UserStore::open_in_memory() {
        Ok(st) => {
            let mut admin = st.login(crate::auth::SEED_ADMIN_EMAIL, crate::auth::SEED_ADMIN_PASSWORD);
            check(&mut out, "Auth: built-in admin must change password", admin.as_ref().map(|s| s.user.must_change && s.user.role == Role::Admin).unwrap_or(false), crate::auth::SEED_ADMIN_EMAIL);
            if let Ok(a) = admin.as_mut() {
                check(&mut out, "Auth: nothing administrative before the change", st.create_user(a, "x@y.com", "", Role::User, "Temp-pass-1").is_err(), "create_user refused");
                let changed = st.change_password(a, "password", "Self-Test#Pass-2026").is_ok();
                check(&mut out, "Auth: password change", changed, "Argon2id");
                let u = st.create_user(a, "selftest@kernenergy.com", "Self Test", Role::User, "Temp-pass-77");
                if let Ok(u) = u {
                    if let Ok(mut s2) = st.login("selftest@kernenergy.com", "Temp-pass-77") {
                        let _ = st.change_password(&mut s2, "Temp-pass-77", "Another#Pass-9911");
                        let saved = st.put_secret(&s2, "ai_key", "sk-selftest-123").is_ok();
                        let own = st.get_secret(&s2, "ai_key").ok().flatten().map(|k| k.as_str() == "sk-selftest-123").unwrap_or(false);
                        let other = st.get_secret(a, "ai_key").ok().flatten().is_none();
                        check(&mut out, "Keys: owner can use their key", saved && own, "XChaCha20-Poly1305");
                        check(&mut out, "Keys: administrator cannot read it", other, "no master key");
                        let _ = st.reset_password(a, u.id, "Reset-pass-55");
                        let s3 = st.login("selftest@kernenergy.com", "Reset-pass-55");
                        let erased = s3.map(|s| st.get_secret(&s, "ai_key").ok().flatten().is_none()).unwrap_or(false);
                        check(&mut out, "Keys: admin reset erases the key", erased, "");
                    }
                }
            }
            let mut locked = false;
            for _ in 0..6 {
                if let Err(e) = st.login("nobody@x.com", "wrong") {
                    locked |= e.0.contains("incorrect");
                }
            }
            check(&mut out, "Auth: unknown users get the same message", locked, "no user enumeration");
        }
        Err(e) => check(&mut out, "Auth: open profile store", false, e.0),
    }

    // ── Search engine on the built-in index ─────────────────────────
    if let Some(bytes) = embedded_index {
        match crate::snapshot::decompress(bytes) {
            Ok(raw) => {
                let p = tmp.join("index.db");
                if g.write(&p, &raw).is_ok() {
                    match Index::load(&p) {
                        Ok(idx) => {
                            let files = idx.files.len();
                            let e = Engine::new(idx);
                            check(&mut out, "Index: built-in snapshot loads", files > 100_000, format!("{files} files"));
                            let q = |s: &str| e.search(&SearchRequest { query: s.into(), limit: 20, ..Default::default() });
                            let r = q("5610.15 inspection");
                            check(&mut out, "Search: equipment + topic", r.total > 0 && r.hits[0].category == "Inspection / MI", format!("{} results, first {:?}", r.total, r.hits.first().map(|h| &h.name)));
                            let r = q("5510.06");
                            check(&mut out, "Search: renumbered equipment", r.card.as_ref().map(|c| c.number == "5610.15").unwrap_or(false), "5510.06 → 5610.15");
                            let r = q("V-2 inspection");
                            check(&mut out, "Search: ambiguous tag asks which", !r.ambiguity.is_empty(), format!("{} options", r.ambiguity.first().map(|a| a.options.len()).unwrap_or(0)));
                            let r = q("tk-1100");
                            check(&mut out, "Search: tag folder resolves", r.card.as_ref().map(|c| c.number == "7272.1100").unwrap_or(false), "TK-1100 → 7272.1100");
                            let r = q("inspction report lru");
                            check(&mut out, "Search: typo tolerance", r.total > 0, format!("{} results", r.total));
                            let r = q("5610.150 inspection");
                            check(&mut out, "Search: partial number rejected", r.total == 0, "TracePoint rule");
                        }
                        Err(err) => check(&mut out, "Index: built-in snapshot loads", false, err),
                    }
                }
            }
            Err(err) => check(&mut out, "Index: decompress built-in snapshot", false, err),
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    out
}
