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
SITE_NAME="${SITE_NAME:-kaszael-ngobrol}"

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
  appName: "Kaszael Ngobrol",
  version: "1.0.0-callfix"
};
EOF

echo "[deploy] config.js injected: $(grep -o 'anonKey:."[^"]\{12\}' "$BUILD/js/config.js")...(${#ANON} chars)"

# 2b. Inject build marker (short commit SHA) into index.html so users can verify
# which commit they are running (per supabase skill frontend-integration-pitfalls).
SHA="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
sed -i "s/__BUILD_SHA__/${SHA}/g" "$BUILD/index.html"
echo "[deploy] index.html build marker: $(grep -o 'build [a-z0-9]\{7\}' "$BUILD/index.html")"

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
# Robust parse — fall back to raw output if response isn't a deploy object.
DEPLOY_ID=$(echo "$DEPLOY_OUT" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    if 'error' in d:
        sys.stderr.write('NETLIFY ERROR: ' + d['error'] + '\n')
        sys.exit(2)
    print(d.get('id', '?'))
except Exception as e:
    sys.stderr.write('PARSE ERROR: ' + str(e) + ' — raw: ' + sys.stdin.read()[:200] + '\n')
    sys.exit(1)
" 2>&1) || { echo "[deploy] FAILED: $DEPLOY_ID" >&2; echo "[deploy] raw response: $DEPLOY_OUT" >&2; exit 1; }
DEPLOY_URL=$(echo "$DEPLOY_OUT" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    print(d.get('ssl_url', d.get('url','?')))
except Exception:
    print('?')
")
echo "[deploy] deployed: $DEPLOY_ID"
echo "[deploy] url: $DEPLOY_URL"
echo "$DEPLOY_ID" > "$PROJECT_ROOT/.last-deploy-id"
