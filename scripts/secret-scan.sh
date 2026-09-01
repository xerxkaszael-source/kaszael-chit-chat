#!/data/data/com.termux/files/usr/bin/bash
# secret-scan.sh — Layer 103: block commit/deploy if secrets are staged.
# Scans public/ + scripts/ + docs/ for credential patterns. Exit 1 on hit.
set -uo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

PATTERNS=(
  'eyJ[A-Za-z0-9_-]\{60,\}'            # JWT (anon/service keys)
  'sbp_[A-Za-z0-9_-]\{20,\}'           # Supabase PAT
  'sb_secret_[A-Za-z0-9_-]\{10,\}'     # service role v2
  'ghp_[A-Za-z0-9]\{30,\}'             # GitHub PAT
  'github_pat_[A-Za-z0-9_]\{20,\}'
  'nfp_[A-Za-z0-9]\{20,\}'             # Netlify token
  'sk-[A-Za-z0-9]\{20,\}'              # OpenAI-style
  'AKIA[0-9A-Z]\{16\}'                 # AWS
  '200015xerx'                          # owner bootstrap password fragment
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
)

SCAN_DIRS=("$PROJECT_DIR/public" "$PROJECT_DIR/scripts" "$PROJECT_DIR/docs")
for d in "${SCAN_DIRS[@]}"; do
  [ -d "$d" ] || continue
  for p in "${PATTERNS[@]}"; do
    HITS=$(grep -rEl "$p" "$d" 2>/dev/null | grep -v 'secret-scan.sh' || true)
    if [ -n "$HITS" ]; then
      echo "SECRET SCAN HIT: pattern '$p' in:"
      echo "$HITS"
      FAIL=1
    fi
  done
done

# config.js must still hold placeholders in the repo
if [ -f "$PROJECT_DIR/public/js/config.js" ]; then
  if ! grep -q '__SUPABASE_URL__' "$PROJECT_DIR/public/js/config.js"; then
    echo "SECRET SCAN: public/js/config.js no longer has placeholders — real config would be committed!"
    FAIL=1
  fi
fi

if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: BLOCKED — remove secrets before continuing"
  exit 1
fi
echo "secret scan: clean"
exit 0
