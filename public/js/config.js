// Public (non-secret) Supabase config — shipped to the browser by design.
// The anon key grants only RLS-limited access (role=anon, JWT decoded by RLS).
// REAL secrets (service_role key, PAT, owner password) stay in ~/.hermes/.env.
// For git-linked deploys (Vercel/GitHub Pages), commit the real anon key directly:
//   the build can't reach ~/.hermes/.env, so a placeholder would brick the live site.
// scripts/deploy.sh still re-injects from env when deploying (idempotent).
window.SUPABASE_CONFIG = {
  url: "https://himrvevlnbpubwmsdhya.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpbXJ2ZXZsbmJwdWJ3bXNkaHlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyODY5MDIsImV4cCI6MjEwMzg2MjkwMn0.0aCHefouzZB9bbHNVQ3UZ6WijU2OowT3PV7B3SW6pCk",
  appName: "Kaszael Ngobrol",
  version: "1.0.0-callfix"
};
