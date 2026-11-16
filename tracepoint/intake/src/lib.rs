//! Scan Intake: turns scanned manila folders into the engineering drive's
//! equipment folders, one correctly named PDF per document.
pub mod analyze;
pub mod claude;
pub mod index;
pub mod ocr;
pub mod pages;
pub mod pdfout;
pub mod registry;
pub mod secret;
pub mod service;
pub mod spec;
pub mod store;
pub mod util;
