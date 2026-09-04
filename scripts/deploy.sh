#!/data/data/com.termux/files/usr/bin/bash
# scripts/deploy.sh — build public/, inject anon key, deploy to Vercel.
# Run from project root. Requires VERCEL_TOKEN, SUPABASE_ANON_KEY,
# SUPABASE_PROJECT_REF in env (read from ~/.hermes/.env).
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC="$PROJECT_ROOT/public"
BUILD="$PROJECT_ROOT/build"

REF="${SUPABASE_PROJECT_REF:-}"
ANON="${SUPABASE_ANON_KEY:-}"
VERCEL="${VERCEL_TOKEN:-}"
TEAM_ID="${VERCEL_TEAM_ID:-}"
PROJECT_NAME="${VERCEL_PROJECT_NAME:-kaszael-ngobrol}"

if [ -z "$REF" ] || [ -z "$ANON" ] || [ -z "$VERCEL" ]; then
  echo "Missing env: REF=$REF ANON_LEN=${#ANON} VERCEL_LEN=${#VERCEL}" >&2
  exit 1
fi

# 1. Stage public/ into build/
rm -rf "$BUILD"
mkdir -p "$BUILD"
cp -r "$PUBLIC"/. "$BUILD"/

# 2. Inject anon key into config.js
URL="https://${REF}.supabase.co"
cat > "$BUILD/js/config.js" <<EOF
// Injected by scripts/deploy.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ).
// anon key is PUBLIC (role=anon, RLS-limited) — safe to ship to the browser.
window.SUPABASE_CONFIG = {
  url: "$URL",
  anonKey: "$ANON",
  appName: "Kaszael Ngobrol",
  version: "1.0.0-callfix"
};
EOF

echo "[deploy] config.js injected: $(grep -o 'anonKey:.\"[^\"]\{12\}' "$BUILD/js/config.js")...(${#ANON} chars)"

# 2b. Inject build marker (short commit SHA) into index.html so users can verify
# which commit they are running.
SHA="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
sed -i "s/__BUILD_SHA__/${SHA}/g" "$BUILD/index.html"
echo "[deploy] index.html build marker: $(grep -o 'build [a-z0-9]\{7\}' "$BUILD/index.html")"

# 3. Deploy via Vercel CLI.
# Use 'vercel deploy --prebuilt' style: deploy the build/ directory directly.
# --prod means deploy to production alias; --yes skips confirmation.
TEAM_FLAG=""
if [ -n "$TEAM_ID" ]; then
  TEAM_FLAG="--scope $TEAM_ID"
fi

DEPLOY_OUT="$(npx --yes vercel@latest deploy "$BUILD" \
  --prod \
  --yes \
  --token "$VERCEL" \
  $TEAM_FLAG \
  --name "$PROJECT_NAME" \
  2>&1 | tee /tmp/vercel-deploy.log)"

DEPLOY_URL="$(echo "$DEPLOY_OUT" | grep -E '^https://' | tail -1 | tr -d '[:space:]')"
DEPLOY_ID="$(echo "$DEPLOY_OUT" | grep -oE 'Deployment: [a-zA-Z0-9_-]+' | head -1 | awk '{print $2}')"

if [ -z "$DEPLOY_URL" ]; then
  echo "[deploy] FAILED — no URL returned" >&2
  echo "[deploy] full output:" >&2
  cat /tmp/vercel-deploy.log >&2
  exit 1
fi

echo "[deploy] deployed: $DEPLOY_ID"
echo "[deploy] url: $DEPLOY_URL"
echo "$DEPLOY_ID" > "$PROJECT_ROOT/.last-deploy-id"
echo "$DEPLOY_URL" > "$PROJECT_ROOT/.last-deploy-url"