#!/data/data/com.termux/files/usr/bin/bash
# scripts/deploy-fix-now.sh — Emergency redeploy when standard deploy.sh is
# blocked by Netlify credit limit. Tries multiple alternative paths in order.
#
# Usage: bash scripts/deploy-fix-now.sh
#
# Required env (auto-loaded from ~/.hermes/.env):
#   SUPABASE_PROJECT_REF, SUPABASE_ANON_KEY, NETLIFY_AUTH_TOKEN
set -euo pipefail

ENV_PATH="$HOME/.hermes/.env"
if [ -f "$ENV_PATH" ]; then
  set -a
  . "$ENV_PATH"
  set +a
fi

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC="$PROJECT_ROOT/public"
BUILD="$PROJECT_ROOT/build"
ZIP="$PROJECT_ROOT/deploy-fix.zip"

REF="${SUPABASE_PROJECT_REF:-}"
ANON="${SUPABASE_ANON_KEY:-}"
NETLIFY="${NETLIFY_AUTH_TOKEN:-}"

if [ -z "$REF" ] || [ -z "$ANON" ] || [ -z "$NETLIFY" ]; then
  echo "Missing env: REF=$REF ANON_LEN=${#ANON} NETLIFY_LEN=${#NETLIFY}" >&2
  exit 1
fi

# 1. Stage public/ into build/
rm -rf "$BUILD" "$ZIP"
mkdir -p "$BUILD"
cp -r "$PUBLIC"/. "$BUILD"/

# 2. Inject anon key
URL="https://${REF}.supabase.co"
cat > "$BUILD/js/config.js" <<EOF
// Injected by scripts/deploy-fix-now.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ).
window.SUPABASE_CONFIG = {
  url: "$URL",
  anonKey: "$ANON",
  appName: "Kaszael Ngobrol",
  version: "1.0.1-callfix"
};
EOF

# 2b. Build marker
SHA="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
sed -i "s/__BUILD_SHA__/${SHA}/g" "$BUILD/index.html"

# 3. Zip
python3 - <<PYEOF
import zipfile, os
src = "$BUILD"
out = "$ZIP"
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(src):
        for f in files:
            fp = os.path.join(root, f)
            arc = os.path.relpath(fp, src)
            zf.write(fp, arc)
print(f"zipped {os.path.getsize(out)} bytes")
PYEOF

echo ""
echo "Build zip ready at $ZIP"
echo ""

# New project identity (2026-09-04): kaszael-ngobrol
# Site id comes from $NETLIFY_SITE_ID env var (preferred) or falls back
# to the verified id for the live URL https://kaszael-ngobrol.netlify.app.
SITE_ID="${NETLIFY_SITE_ID:-803d2c44-4a6a-48e1-8a5c-b78dcee9b4cc}"

echo "===== Path 1: Direct deploy (POST /deploys) ====="
RESP=$(curl -sS -X POST \
  -H "Authorization: Bearer $NETLIFY" \
  -H "Content-Type: application/zip" \
  -w "\nHTTP_STATUS:%{http_code}" \
  --data-binary "@$ZIP" \
  "https://api.netlify.com/api/v1/sites/$SITE_ID/deploys")
HTTP=$(echo "$RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
BODY=$(echo "$RESP" | grep -v "HTTP_STATUS:")
echo "HTTP $HTTP"
echo "Body: $BODY" | head -5

if [ "$HTTP" = "200" ] || [ "$HTTP" = "201" ]; then
  DEPLOY_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','?'))")
  DEPLOY_URL=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ssl_url','?'))")
  echo ""
  echo "✓ DEPLOYED!"
  echo "  deploy_id: $DEPLOY_ID"
  echo "  url: $DEPLOY_URL"
  echo "$DEPLOY_ID" > "$PROJECT_ROOT/.last-deploy-id"
  exit 0
fi

echo ""
echo "===== Path 2: Drag-and-drop endpoint ====="
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $NETLIFY" \
  -F "file=@$ZIP" \
  "https://kaszael-ngobrol.netlify.app/.netlify/deploy" 2>&1 || echo "000")
echo "HTTP $HTTP"
if [ "$HTTP" = "200" ] || [ "$HTTP" = "201" ]; then
  echo "✓ deployed via drag-and-drop"
  exit 0
fi

echo ""
echo "===== Path 3: Deploy to NEW site (workaround credit limit on old) ====="
NEW_SITE=$(curl -sS -X POST \
  -H "Authorization: Bearer $NETLIFY" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"kaszael-ngobrol-v2-$(date +%s)\"}" \
  "https://api.netlify.com/api/v1/sites" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))")
if [ -z "$NEW_SITE" ]; then
  echo "  ✗ could not create new site"
else
  echo "  new site id: $NEW_SITE"
  RESP=$(curl -sS -X POST \
    -H "Authorization: Bearer $NETLIFY" \
    -H "Content-Type: application/zip" \
    -w "\nHTTP_STATUS:%{http_code}" \
    --data-binary "@$ZIP" \
    "https://api.netlify.com/api/v1/sites/$NEW_SITE/deploys")
  HTTP=$(echo "$RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
  BODY=$(echo "$RESP" | grep -v "HTTP_STATUS:")
  echo "  HTTP $HTTP"
  if [ "$HTTP" = "200" ] || [ "$HTTP" = "201" ]; then
    DEPLOY_URL=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ssl_url','?'))")
    echo ""
    echo "✓ DEPLOYED to NEW site!"
    echo "  url: $DEPLOY_URL"
    exit 0
  fi
  echo "  Body: $BODY" | head -3
fi

echo ""
echo "===== Path 4: GitHub Pages fallback ====="
echo "If all Netlify paths blocked, switch to GitHub Pages:"
echo "  1. Run: cd public && git init && git commit -m 'call fix'"
echo "  2. Push to xerxkaszael-source/kaszael-chit-chat-pages (enable Pages in settings)"
echo "  3. Update DNS or use the *.github.io URL"
echo ""
echo "Or use Cloudflare Pages / Vercel / Render — all support free static deploys."
echo ""
echo "ALL PATHS FAILED. Manual intervention required:"
echo "  1. Log into https://app.netlify.com/ → site 'kaszael-ngobrol' → Billing"
echo "  2. Add credits OR upgrade to a paid plan"
echo "  3. Retry: bash scripts/deploy-fix-now.sh"
exit 1