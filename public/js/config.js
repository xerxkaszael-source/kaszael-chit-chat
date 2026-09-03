// Public (non-secret) Supabase config — shipped to the browser by design.
// The anon key grants only RLS-limited access (SELECT policies + auth-checked RPCs).
// REAL secrets (service_role key, PAT, owner password) stay in ~/.hermes/.env and NEVER here.
window.SUPABASE_CONFIG = {
  url: "https://himrvevlnbpubwmsdhya.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpbXJ2ZXZsbmJwdWJ3bXNkaHlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyODY5MDIsImV4cCI6MjEwMzg2MjkwMn0.dummy_replace_at_runtime",
  appName: "Kaszael Chit&Chat",
  version: "1.0.0"
};
