#!/data/data/com.termux/files/usr/bin/bash
# deploy.sh — build config injection + Netlify zip deploy (Layer 22 friendly).
# NEVER prints secrets. Reads them from ~/.hermes/.env at runtime.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$HOME/.hermes/.env"
BUILD_DIR="$PROJECT_DIR/build"

die() { echo "ERROR: $1" >&2; exit 1; }

# 1. load env
[ -f "$ENV_FILE" ] || die "~/.hermes/.env not found"
get_env() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\n\r"'"'" ; }
SUPABASE_URL="https://$(get_env SUPABASE_PROJECT_REF).supabase.co"
ANON_KEY="$(get_env SUPABASE_ANON_KEY)"
NETLIFY_TOKEN="$(get_env NETLIFY_AUTH_TOKEN)"
[ "$ANON_KEY" = "__SUPABASE_ANON_KEY__" ] && die "anon key is still the template placeholder"
[ ${#ANON_KEY} -lt 100 ] && die "anon key looks truncated (${#ANON_KEY} chars)"
[ -n "$NETLIFY_TOKEN" ] || die "NETLIFY_AUTH_TOKEN missing"

# 2. secret scan before anything leaves the machine (Layer 103)
bash "$PROJECT_DIR/scripts/secret-scan.sh" || die "secret scan failed — refusing to deploy"

# 3. build dir = public + injected config
rm -rf "$BUILD_DIR"
cp -r "$PROJECT_DIR/public" "$BUILD_DIR"
sed -i "s|__SUPABASE_URL__|$SUPABASE_URL|g; s|__SUPABASE_ANON_KEY__|$ANON_KEY|g" "$BUILD_DIR/js/config.js"

# 4. sanity: placeholders gone, key full-length
grep -q "__SUPABASE" "$BUILD_DIR/js/config.js" && die "placeholder still present after injection"
KEY_LEN=$(grep -o 'anonKey: "[^"]*"' "$BUILD_DIR/js/config.js" | sed 's/anonKey: "//;s/"$//' | wc -c)
echo "config injected (anon key length: $((KEY_LEN-1)))"

# 5. zip + Netlify deploy (create site on first run)
SITE_NAME="kaszael-chat"
cd "$BUILD_DIR"
python3 - <<'PY'
import zipfile, os
zf = zipfile.ZipFile('../deploy.zip', 'w', zipfile.ZIP_DEFLATED)
for root, dirs, files in os.walk('.'):
    for f in files:
        p = os.path.join(root, f)
        zf.write(p, os.path.relpath(p, '.'))
zf.close()
PY
cd "$PROJECT_DIR"

SITE_ID=$(curl -sf -H "Authorization: Bearer $NETLIFY_TOKEN" "https://api.netlify.com/api/v1/sites" \
  | python3 -c "import sys,json; sites=json.load(sys.stdin); print(next((s['id'] for s in sites if s.get('name')=='$SITE_NAME'),''))")

if [ -z "$SITE_ID" ]; then
  echo "site not found — creating $SITE_NAME"
  SITE_ID=$(curl -sf -X POST -H "Authorization: Bearer $NETLIFY_TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"$SITE_NAME\"}" https://api.netlify.com/api/v1/sites \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
fi

echo "deploying to site $SITE_ID"
DEPLOY=$(curl -sf -X POST -H "Authorization: Bearer $NETLIFY_TOKEN" -H "Content-Type: application/zip" \
  --data-binary @deploy.zip "https://api.netlify.com/api/v1/sites/$SITE_ID/deploys")
DEPLOY_ID=$(echo "$DEPLOY" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "deploy id: $DEPLOY_ID"

# 6. wait for ready
for i in $(seq 1 30); do
  STATE=$(curl -sf -H "Authorization: Bearer $NETLIFY_TOKEN" "https://api.netlify.com/api/v1/deploys/$DEPLOY_ID" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['state'])")
  [ "$STATE" = "ready" ] && break
  [ "$STATE" = "error" ] && die "deploy errored"
  sleep 2
done
URL=$(curl -sf -H "Authorization: Bearer $NETLIFY_TOKEN" "https://api.netlify.com/api/v1/deploys/$DEPLOY_ID" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('ssl_url') or json.load(sys.stdin).get('url',''))" 2>/dev/null || true)
[ -z "$URL" ] && URL="https://$SITE_NAME.netlify.app"
echo "LIVE: $URL"
rm -f deploy.zip
