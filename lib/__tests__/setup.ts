// Test setup. Sets stub env vars so lib/supabase.ts can construct
// its client at module-load time. We never actually call the client
// in tests — these are pure-function tests — but the modules that
// expose those pure functions live in files that share an import
// graph with lib/supabase.ts.

if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
}
if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
}
