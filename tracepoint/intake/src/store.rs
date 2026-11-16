//! The ledger: every scan dropped in, what happened to it, and every
//! document filed from it. Kept on the scan drive (`_INTAKE DATA`) so it
//! travels with the drive.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

pub struct Store {
    pub c: Connection,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct Scan {
    pub id: i64,
    pub file_name: String,
    pub original_path: String,
    pub sha256: String,
    pub pages: i64,
    pub status: String,
    pub stage: String,
    pub equipment: String,
    pub equipment_rel: String,
    pub new_folder: bool,
    pub problems: Vec<String>,
    pub cost: f64,
    pub added_at: i64,
    pub done_at: i64,
    pub error: String,
    pub work_dir: String,
    pub documents: i64,
}

#[derive(Clone, Debug, Serialize, Default)]
pub struct Doc {
    pub id: i64,
    pub scan_id: i64,
    pub equipment: String,
    pub equipment_rel: String,
    pub folder: String,
    pub file_rel: String,
    pub title: String,
    pub date: String,
    pub pages: i64,
    pub first_page: i64,
    pub last_page: i64,
    pub as_other: String,
    pub drawing_number: String,
    pub revision: String,
    pub summary: String,
    pub note: String,
    pub filed_at: i64,
    pub source_name: String,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        if let Some(d) = path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let c = Connection::open(path)?;
        c.busy_timeout(std::time::Duration::from_secs(10))?;
        c.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS scans(
               id INTEGER PRIMARY KEY, file_name TEXT NOT NULL, original_path TEXT NOT NULL DEFAULT '',
               sha256 TEXT NOT NULL DEFAULT '', pages INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
               stage TEXT NOT NULL DEFAULT '', equipment TEXT NOT NULL DEFAULT '', equipment_rel TEXT NOT NULL DEFAULT '',
               new_folder INTEGER NOT NULL DEFAULT 0, problems TEXT NOT NULL DEFAULT '[]', filing TEXT NOT NULL DEFAULT '',
               cost REAL NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, done_at INTEGER NOT NULL DEFAULT 0,
               error TEXT NOT NULL DEFAULT '', work_dir TEXT NOT NULL DEFAULT '');
             CREATE INDEX IF NOT EXISTS scans_sha ON scans(sha256);
             CREATE INDEX IF NOT EXISTS scans_status ON scans(status);
             CREATE TABLE IF NOT EXISTS documents(
               id INTEGER PRIMARY KEY, scan_id INTEGER NOT NULL, equipment TEXT NOT NULL, equipment_rel TEXT NOT NULL,
               folder TEXT NOT NULL, file_rel TEXT NOT NULL, title TEXT NOT NULL, date TEXT NOT NULL, pages INTEGER NOT NULL,
               first_page INTEGER NOT NULL, last_page INTEGER NOT NULL, as_other TEXT NOT NULL DEFAULT '',
               drawing_number TEXT NOT NULL DEFAULT '', revision TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
               filed_at INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS docs_scan ON documents(scan_id);
             CREATE TABLE IF NOT EXISTS created_folders(rel TEXT PRIMARY KEY, equipment TEXT NOT NULL, created_at INTEGER NOT NULL);",
        )?;
        // Columns added after the first release.
        let _ = c.execute("ALTER TABLE documents ADD COLUMN note TEXT NOT NULL DEFAULT ''", []);
        Ok(Store { c })
    }

    fn scan_row(r: &rusqlite::Row) -> rusqlite::Result<Scan> {
        let problems: String = r.get("problems")?;
        Ok(Scan {
            id: r.get("id")?,
            file_name: r.get("file_name")?,
            original_path: r.get("original_path")?,
            sha256: r.get("sha256")?,
            pages: r.get("pages")?,
            status: r.get("status")?,
            stage: r.get("stage")?,
            equipment: r.get("equipment")?,
            equipment_rel: r.get("equipment_rel")?,
            new_folder: r.get::<_, i64>("new_folder")? != 0,
            problems: serde_json::from_str(&problems).unwrap_or_default(),
            cost: r.get("cost")?,
            added_at: r.get("added_at")?,
            done_at: r.get("done_at")?,
            error: r.get("error")?,
            work_dir: r.get("work_dir")?,
            documents: r.get("ndocs").unwrap_or(0),
        })
    }

    const SCAN_COLS: &'static str = "s.*, (SELECT COUNT(*) FROM documents d WHERE d.scan_id = s.id) AS ndocs";

    pub fn add_scan(&self, file_name: &str, original: &str, sha: &str, now: i64) -> rusqlite::Result<i64> {
        self.c.execute("INSERT INTO scans(file_name, original_path, sha256, status, added_at) VALUES(?1, ?2, ?3, 'queued', ?4)", params![file_name, original, sha, now])?;
        Ok(self.c.last_insert_rowid())
    }

    pub fn by_sha(&self, sha: &str) -> rusqlite::Result<Option<Scan>> {
        self.c.query_row(&format!("SELECT {} FROM scans s WHERE sha256 = ?1 AND status NOT IN ('duplicate') ORDER BY id LIMIT 1", Self::SCAN_COLS), params![sha], Self::scan_row).optional()
    }

    pub fn scan(&self, id: i64) -> rusqlite::Result<Option<Scan>> {
        self.c.query_row(&format!("SELECT {} FROM scans s WHERE id = ?1", Self::SCAN_COLS), params![id], Self::scan_row).optional()
    }

    pub fn scans(&self, status: Option<&str>, limit: i64) -> rusqlite::Result<Vec<Scan>> {
        let (sql, p): (String, Vec<String>) = match status {
            Some(s) => (format!("SELECT {} FROM scans s WHERE status = ?1 ORDER BY id DESC LIMIT {limit}", Self::SCAN_COLS), vec![s.to_string()]),
            None => (format!("SELECT {} FROM scans s ORDER BY id DESC LIMIT {limit}", Self::SCAN_COLS), vec![]),
        };
        let mut st = self.c.prepare(&sql)?;
        let rows = st.query_map(rusqlite::params_from_iter(p.iter()), Self::scan_row)?;
        rows.collect()
    }

    pub fn set_status(&self, id: i64, status: &str, stage: &str) -> rusqlite::Result<()> {
        self.c.execute("UPDATE scans SET status = ?2, stage = ?3 WHERE id = ?1", params![id, status, stage])?;
        Ok(())
    }

    pub fn set_stage(&self, id: i64, stage: &str) -> rusqlite::Result<()> {
        self.c.execute("UPDATE scans SET stage = ?2 WHERE id = ?1", params![id, stage])?;
        Ok(())
    }

    pub fn set_read(&self, id: i64, pages: i64, work_dir: &str) -> rusqlite::Result<()> {
        self.c.execute("UPDATE scans SET pages = ?2, work_dir = ?3 WHERE id = ?1", params![id, pages, work_dir])?;
        Ok(())
    }

    pub fn add_cost(&self, id: i64, cost: f64) -> rusqlite::Result<()> {
        self.c.execute("UPDATE scans SET cost = cost + ?2 WHERE id = ?1", params![id, cost])?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_result(&self, id: i64, status: &str, equipment: &str, rel: &str, new_folder: bool, problems: &[String], filing: &str, now: i64) -> rusqlite::Result<()> {
        self.c.execute(
            "UPDATE scans SET status = ?2, stage = '', equipment = ?3, equipment_rel = ?4, new_folder = ?5, problems = ?6, filing = ?7, done_at = ?8, error = '' WHERE id = ?1",
            params![id, status, equipment, rel, new_folder as i64, serde_json::to_string(problems).unwrap_or_default(), filing, now],
        )?;
        Ok(())
    }

    pub fn set_error(&self, id: i64, error: &str, now: i64) -> rusqlite::Result<()> {
        self.c.execute("UPDATE scans SET status = 'failed', stage = '', error = ?2, done_at = ?3 WHERE id = ?1", params![id, error, now])?;
        Ok(())
    }

    pub fn filing(&self, id: i64) -> rusqlite::Result<String> {
        self.c.query_row("SELECT filing FROM scans WHERE id = ?1", params![id], |r| r.get(0))
    }

    pub fn save_filing(&self, id: i64, filing: &str) -> rusqlite::Result<()> {
        self.c.execute("UPDATE scans SET filing = ?2 WHERE id = ?1", params![id, filing])?;
        Ok(())
    }

    pub fn add_doc(&self, d: &Doc) -> rusqlite::Result<i64> {
        self.c.execute(
            "INSERT INTO documents(scan_id, equipment, equipment_rel, folder, file_rel, title, date, pages, first_page, last_page, as_other, drawing_number, revision, summary, filed_at, note)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![d.scan_id, d.equipment, d.equipment_rel, d.folder, d.file_rel, d.title, d.date, d.pages, d.first_page, d.last_page, d.as_other, d.drawing_number, d.revision, d.summary, d.filed_at, d.note],
        )?;
        Ok(self.c.last_insert_rowid())
    }

    fn doc_row(r: &rusqlite::Row) -> rusqlite::Result<Doc> {
        Ok(Doc {
            id: r.get("id")?,
            scan_id: r.get("scan_id")?,
            equipment: r.get("equipment")?,
            equipment_rel: r.get("equipment_rel")?,
            folder: r.get("folder")?,
            file_rel: r.get("file_rel")?,
            title: r.get("title")?,
            date: r.get("date")?,
            pages: r.get("pages")?,
            first_page: r.get("first_page")?,
            last_page: r.get("last_page")?,
            as_other: r.get("as_other")?,
            drawing_number: r.get("drawing_number")?,
            revision: r.get("revision")?,
            summary: r.get("summary")?,
            note: r.get("note").unwrap_or_default(),
            filed_at: r.get("filed_at")?,
            source_name: r.get("source_name").unwrap_or_default(),
        })
    }

    pub fn docs_of_scan(&self, scan_id: i64) -> rusqlite::Result<Vec<Doc>> {
        let mut st = self.c.prepare("SELECT d.*, s.file_name AS source_name FROM documents d JOIN scans s ON s.id = d.scan_id WHERE d.scan_id = ?1 ORDER BY d.first_page")?;
        let rows = st.query_map(params![scan_id], Self::doc_row)?;
        rows.collect()
    }

    pub fn all_docs(&self) -> rusqlite::Result<Vec<Doc>> {
        let mut st = self.c.prepare("SELECT d.*, s.file_name AS source_name FROM documents d JOIN scans s ON s.id = d.scan_id ORDER BY d.equipment_rel, d.folder, d.date, d.file_rel")?;
        let rows = st.query_map([], Self::doc_row)?;
        rows.collect()
    }

    pub fn delete_docs_of_scan(&self, scan_id: i64) -> rusqlite::Result<Vec<Doc>> {
        let docs = self.docs_of_scan(scan_id)?;
        self.c.execute("DELETE FROM documents WHERE scan_id = ?1", params![scan_id])?;
        Ok(docs)
    }

    pub fn note_folder(&self, rel: &str, equipment: &str, now: i64) -> rusqlite::Result<()> {
        self.c.execute("INSERT OR IGNORE INTO created_folders(rel, equipment, created_at) VALUES(?1, ?2, ?3)", params![rel, equipment, now])?;
        Ok(())
    }

    pub fn counts(&self) -> rusqlite::Result<serde_json::Value> {
        let mut st = self.c.prepare("SELECT status, COUNT(*) FROM scans GROUP BY status")?;
        let mut m = serde_json::Map::new();
        for r in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (k, v) = r?;
            m.insert(k, v.into());
        }
        let docs: i64 = self.c.query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))?;
        let pages: i64 = self.c.query_row("SELECT COALESCE(SUM(pages),0) FROM scans WHERE status = 'filed'", [], |r| r.get(0))?;
        let cost: f64 = self.c.query_row("SELECT COALESCE(SUM(cost),0) FROM scans", [], |r| r.get(0))?;
        let folders: i64 = self.c.query_row("SELECT COUNT(*) FROM created_folders", [], |r| r.get(0))?;
        Ok(serde_json::json!({"by_status": m, "documents": docs, "pages_filed": pages, "cost": cost, "new_folders": folders}))
    }

    /// Scans that were mid-way when the program last closed go back in line.
    pub fn requeue_interrupted(&self) -> rusqlite::Result<usize> {
        self.c.execute("UPDATE scans SET status = 'queued', stage = '' WHERE status IN ('reading', 'analyzing', 'filing')", [])
    }
}
