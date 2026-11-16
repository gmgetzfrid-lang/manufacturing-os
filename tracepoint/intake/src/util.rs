//! Small helpers: time, hashing, file moves.

use std::path::{Path, PathBuf};

pub fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// (year, month, day, hour, minute, second) in UTC.
pub fn utc_parts(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, (rem / 3600) as u32, ((rem % 3600) / 60) as u32, (rem % 60) as u32)
}

pub fn iso_date(secs: i64) -> String {
    let (y, m, d, ..) = utc_parts(secs);
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn iso_time(secs: i64) -> String {
    let (y, m, d, h, mi, s) = utc_parts(secs);
    format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02}")
}

pub fn sha256_file(p: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// `dir/name.ext`, or `dir/name (2).ext`, ... if taken.
pub fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let p = dir.join(file_name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (file_name.to_string(), String::new()),
    };
    for i in 2..10_000 {
        let q = dir.join(format!("{stem} ({i}){ext}"));
        if !q.exists() {
            return q;
        }
    }
    dir.join(format!("{stem} ({}){ext}", now_secs()))
}

/// Move a file, across drives if needed (copy, verify size, delete).
pub fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(d) = to.parent() {
        std::fs::create_dir_all(d)?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to)?;
    let a = std::fs::metadata(from)?.len();
    let b = std::fs::metadata(to)?.len();
    if a != b {
        let _ = std::fs::remove_file(to);
        return Err(std::io::Error::other("copy was incomplete"));
    }
    std::fs::remove_file(from)
}

/// Write a file through a temporary name so a half-written file never
/// appears under the final name.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension(format!("partial{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn dates() {
        assert_eq!(super::iso_date(0), "1970-01-01");
        assert_eq!(super::iso_time(1_763_303_400), "2025-11-16 14:30:00");
        assert_eq!(super::iso_date(951_782_400), "2000-02-29");
    }
}
