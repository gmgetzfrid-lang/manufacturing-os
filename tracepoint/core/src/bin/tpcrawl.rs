//! Dev tool: scan a folder into an index database. `tpcrawl <db> <root> [workers]`
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
fn main() {
    let mut a = std::env::args().skip(1);
    let db = a.next().expect("db");
    let root = a.next().expect("root");
    let workers: usize = a.next().and_then(|x| x.parse().ok()).unwrap_or(8);
    let mut c = rusqlite::Connection::open(&db).unwrap();
    c.pragma_update(None, "journal_mode", "WAL").unwrap();
    c.pragma_update(None, "synchronous", "NORMAL").unwrap();
    let opts = tp_core::crawl::Options { workers, cancel: Arc::new(AtomicBool::new(false)), permissions: true };
    let s = tp_core::crawl::scan(&mut c, &root, &opts, &|p| eprint!("\r{} {} files {} dirs {:.0}/s   ", p.phase, p.files, p.dirs, p.files_per_sec)).unwrap();
    eprintln!();
    println!("{} | files {} dirs {} new {} changed {} missing {} issues {} | {:.2} s ({:.0} files/s)", s.status, s.progress.files, s.progress.dirs, s.progress.new, s.progress.changed, s.progress.missing, s.progress.issues, s.progress.elapsed_s, s.progress.files_per_sec);
}
