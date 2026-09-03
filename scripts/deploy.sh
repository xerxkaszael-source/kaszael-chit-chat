#!/data/data/com.termux/files/usr/bin/bash
# scripts/deploy.sh — build public/, inject anon key, zip + Netlify drop.
# Run from project root. Requires NETLIFY_AUTH_TOKEN, SUPABASE_ANON_KEY,
# SUPABASE_PROJECT_REF in env (read from ~/.hermes/.env).
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC="$PROJECT_ROOT/public"
BUILD="$PROJECT_ROOT/build"
ZIP="$PROJECT_ROOT/deploy.zip"

REF="${SUPABASE_PROJECT_REF:-}"
ANON="${SUPABASE_ANON_KEY:-}"
NETLIFY="${NETLIFY_AUTH_TOKEN:-}"
SITE_NAME="${SITE_NAME:-kaszael-chat}"

if [ -z "$REF" ] || [ -z "$ANON" ] || [ -z "$NETLIFY" ]; then
  echo "Missing env: REF=$REF ANON_LEN=${#ANON} NETLIFY_LEN=${#NETLIFY}" >&2
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
  appName: "Kaszael Chit&Chat",
  version: "1.0.0"
};
EOF

echo "[deploy] config.js injected: $(grep -o 'anonKey:."[^"]\{12\}' "$BUILD/js/config.js")...(${#ANON} chars)"

# 3. Zip (Termux has no zip; use Python)
rm -f "$ZIP"
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
print(f"[deploy] zipped {os.path.getsize(out)} bytes")
PYEOF
echo "[deploy] zipped $(du -h "$ZIP" | cut -f1)"

# 4. Netlify: list existing site
SITE_ID=$(curl -s -H "Authorization: Bearer $NETLIFY" "https://api.netlify.com/api/v1/sites?filter=name=$SITE_NAME" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
if [ -z "$SITE_ID" ]; then
  echo "[deploy] creating site $SITE_NAME"
  SITE_ID=$(curl -s -X POST -H "Authorization: Bearer $NETLIFY" -H "Content-Type: application/json" \
    -d "{\"name\":\"$SITE_NAME\"}" "https://api.netlify.com/api/v1/sites" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))")
fi
echo "[deploy] site id: $SITE_ID"

# 5. Deploy zip
DEPLOY_OUT=$(curl -s -X POST -H "Authorization: Bearer $NETLIFY" -H "Content-Type: application/zip" \
  --data-binary "@$ZIP" "https://api.netlify.com/api/v1/sites/$SITE_ID/deploys")
DEPLOY_ID=$(echo "$DEPLOY_OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','?'))")
DEPLOY_URL=$(echo "$DEPLOY_OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ssl_url', d.get('url','?')))")
echo "[deploy] deployed: $DEPLOY_ID"
echo "[deploy] url: $DEPLOY_URL"
echo "$DEPLOY_ID" > "$PROJECT_ROOT/.last-deploy-id"
