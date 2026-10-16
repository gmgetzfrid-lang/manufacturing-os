//! The THOR integrity guard.
//!
//! TracePoint never changes anything in an indexed source (THOR). Every write
//! the program makes — settings, user database, caches, exports, indexer
//! output — goes through `Guard`, which refuses any path that:
//!   * is inside, or equal to, an indexed root (by UNC path or mapped drive), or
//!   * is outside the folders TracePoint was explicitly given to write to.
//! There is no delete or rename of anything outside TracePoint's own folders,
//! and no function here can be asked to touch a source root.
//!
//! Reads of THOR files use plain read-only opens (`std::fs::File::open`,
//! which on Windows shares read/write/delete so other users are never locked
//! out). See the About › For IT page for how to verify this.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

#[derive(Debug)]
pub enum GuardError {
    InsideSource { path: String, root: String },
    NotAllowed { path: String },
    Io(std::io::Error),
}

impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GuardError::InsideSource { path, root } => write!(f, "Refused: {path} is inside the indexed source {root}. TracePoint never writes to THOR."),
            GuardError::NotAllowed { path } => write!(f, "Refused: {path} is outside TracePoint's own data folders."),
            GuardError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for GuardError {}

impl From<std::io::Error> for GuardError {
    fn from(e: std::io::Error) -> Self {
        GuardError::Io(e)
    }
}

/// Compare-ready form of a Windows or POSIX path: lowercase, backslashes,
/// no `\\?\` prefix, `.`/`..` resolved, no trailing separator.
pub fn normalize(p: &str) -> String {
    let mut s = p.replace('/', "\\");
    if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\") {
        s = format!("\\\\{rest}");
    } else if let Some(rest) = s.strip_prefix("\\\\?\\") {
        s = rest.to_string();
    }
    let unc = s.starts_with("\\\\");
    let body = if unc { &s[2..] } else { &s[..] };
    let mut parts: Vec<&str> = Vec::new();
    for part in body.split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                // Never climb above the share (\\server\share) or drive.
                if parts.len() > if unc { 2 } else { 1 } {
                    parts.pop();
                }
            }
            x => parts.push(x),
        }
    }
    let joined = parts.join("\\");
    let out = if unc { format!("\\\\{joined}") } else if p.starts_with('/') { format!("\\{joined}") } else { joined };
    out.to_lowercase()
}

fn is_within(child: &str, parent: &str) -> bool {
    child == parent || (child.len() > parent.len() && child.starts_with(parent) && child.as_bytes()[parent.len()] == b'\\')
}

/// Maps a drive-letter path to its UNC target when the drive is a network
/// mapping (Windows only; identity elsewhere). Set by the app at startup.
pub type DriveResolver = fn(&str) -> Option<String>;

pub struct Guard {
    protected: RwLock<Vec<String>>,
    writable: RwLock<Vec<String>>,
    resolver: Option<DriveResolver>,
}

impl Guard {
    pub fn new(resolver: Option<DriveResolver>) -> Guard {
        Guard { protected: RwLock::new(Vec::new()), writable: RwLock::new(Vec::new()), resolver }
    }

    /// Source roots that must never be written (e.g. \\thor\Equipment Files).
    pub fn protect(&self, root: &str) {
        let n = normalize(root);
        let mut p = self.protected.write().unwrap();
        if !p.contains(&n) {
            p.push(n);
        }
    }

    pub fn protected_roots(&self) -> Vec<String> {
        self.protected.read().unwrap().clone()
    }

    /// Folders TracePoint may write (its data folder, the team folder, temp).
    /// Refused if the folder itself is inside a protected source.
    pub fn allow(&self, dir: &Path) -> Result<(), GuardError> {
        let n = self.resolve(&dir.to_string_lossy());
        if let Some(root) = self.protecting(&n) {
            return Err(GuardError::InsideSource { path: dir.display().to_string(), root });
        }
        let mut w = self.writable.write().unwrap();
        if !w.contains(&n) {
            w.push(n);
        }
        Ok(())
    }

    pub fn writable_dirs(&self) -> Vec<String> {
        self.writable.read().unwrap().clone()
    }

    fn resolve(&self, p: &str) -> String {
        let n = normalize(p);
        if let Some(r) = self.resolver {
            if n.len() >= 2 && n.as_bytes()[1] == b':' {
                if let Some(unc) = r(&n[..2]) {
                    return normalize(&format!("{}{}", unc, &n[2..]));
                }
            }
        }
        n
    }

    fn protecting(&self, normalized: &str) -> Option<String> {
        self.protected.read().unwrap().iter().find(|r| is_within(normalized, r)).cloned()
    }

    /// Decide whether a write to `path` is permitted. Returns the path to use.
    pub fn check(&self, path: &Path) -> Result<PathBuf, GuardError> {
        // Resolve symlinks/junctions of the nearest existing ancestor so a link
        // inside the data folder cannot point the write at THOR.
        let mut probe = path.to_path_buf();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        while !probe.exists() {
            match (probe.file_name().map(|s| s.to_os_string()), probe.parent()) {
                (Some(name), Some(parent)) => {
                    tail.push(name);
                    probe = parent.to_path_buf();
                }
                _ => break,
            }
        }
        let real = fs::canonicalize(&probe).unwrap_or(probe);
        let mut full = real;
        for t in tail.into_iter().rev() {
            full.push(t);
        }
        let n = self.resolve(&full.to_string_lossy());
        let n_raw = self.resolve(&path.to_string_lossy());
        for candidate in [&n, &n_raw] {
            if let Some(root) = self.protecting(candidate) {
                return Err(GuardError::InsideSource { path: path.display().to_string(), root });
            }
        }
        let ok = self.writable.read().unwrap().iter().any(|w| is_within(&n, w) || is_within(&n_raw, w));
        if !ok {
            return Err(GuardError::NotAllowed { path: path.display().to_string() });
        }
        Ok(path.to_path_buf())
    }

    pub fn create_dir_all(&self, dir: &Path) -> Result<(), GuardError> {
        self.check(dir)?;
        fs::create_dir_all(dir)?;
        Ok(())
    }

    /// Atomic write: temp file in the same folder, flush, then rename.
    pub fn write(&self, path: &Path, bytes: &[u8]) -> Result<(), GuardError> {
        self.check(path)?;
        if let Some(parent) = path.parent() {
            self.create_dir_all(parent)?;
        }
        let tmp = path.with_extension(format!("{}.tp-tmp", path.extension().and_then(|e| e.to_str()).unwrap_or("")));
        self.check(&tmp)?;
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Remove a file TracePoint itself created (caches, temp copies).
    pub fn remove_own_file(&self, path: &Path) -> Result<(), GuardError> {
        self.check(path)?;
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    /// Remove a folder TracePoint itself created (an old shared index group).
    pub fn remove_own_dir(&self, path: &Path) -> Result<(), GuardError> {
        self.check(path)?;
        if path.is_dir() {
            fs::remove_dir_all(path)?;
        }
        Ok(())
    }

    /// Copy into one of TracePoint's own folders and swap it in with a rename,
    /// so readers never see a half-written file.
    pub fn publish(&self, from: &Path, to: &Path) -> Result<u64, GuardError> {
        self.check(to)?;
        let tmp = to.with_extension("tp-publish");
        self.check(&tmp)?;
        if let Some(parent) = to.parent() {
            self.create_dir_all(parent)?;
        }
        let n = fs::copy(from, &tmp)?;
        fs::File::open(&tmp)?.sync_all()?;
        fs::rename(&tmp, to)?;
        Ok(n)
    }

    pub fn copy_into(&self, from: &Path, to: &Path) -> Result<u64, GuardError> {
        self.check(to)?;
        if let Some(parent) = to.parent() {
            self.create_dir_all(parent)?;
        }
        Ok(fs::copy(from, to)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(normalize(r"\\THOR\Equipment Files\A\..\B\"), r"\\thor\equipment files\b");
        assert_eq!(normalize(r"\\?\UNC\thor\x\y"), r"\\thor\x\y");
        assert_eq!(normalize(r"C:\Users\me\.\AppData"), r"c:\users\me\appdata");
        assert_eq!(normalize(r"\\thor\share\..\..\..\evil"), r"\\thor\share\evil");
    }

    #[test]
    fn refuses_source_and_outside() {
        let g = Guard::new(None);
        g.protect(r"\\thor\Equipment Files");
        let tmp = std::env::temp_dir().join("tp-guard-test");
        g.allow(&tmp).unwrap();
        assert!(matches!(g.check(Path::new(r"\\thor\Equipment Files\x.txt")), Err(GuardError::InsideSource { .. })));
        assert!(matches!(g.check(Path::new(r"\\THOR\equipment files\Sub\..\y.pdf")), Err(GuardError::InsideSource { .. })));
        assert!(g.check(Path::new(r"\\thor\Equipment Files Other\x.txt")).is_err(), "not allowed either");
        assert!(matches!(g.allow(Path::new(r"\\thor\Equipment Files\TracePoint")), Err(GuardError::InsideSource { .. })));
        assert!(g.check(&tmp.join("a").join("b.json")).is_ok());
        assert!(matches!(g.check(Path::new("/etc/passwd")), Err(GuardError::NotAllowed { .. })));
        g.write(&tmp.join("ok.txt"), b"hi").unwrap();
        assert_eq!(std::fs::read(tmp.join("ok.txt")).unwrap(), b"hi");
        g.remove_own_file(&tmp.join("ok.txt")).unwrap();
    }

    #[test]
    fn mapped_drive_resolves_to_source() {
        fn res(d: &str) -> Option<String> {
            (d == "t:").then(|| r"\\thor\Equipment Files".to_string())
        }
        let g = Guard::new(Some(res));
        g.protect(r"\\thor\Equipment Files");
        assert!(matches!(g.check(Path::new(r"T:\5600 - LRU\x.pdf")), Err(GuardError::InsideSource { .. })));
    }
}
