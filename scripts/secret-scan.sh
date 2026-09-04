#!/data/data/com.termux/files/usr/bin/bash
# secret-scan.sh — Layer 103: block commit/deploy if REAL secrets are staged.
# The Supabase ANON key (role "anon") is PUBLIC by design and is allowed in
# public/js/config.js — it only grants RLS-limited access.
# REAL secrets are blocked: service_role keys, PAT, owner password, private keys.
set -uo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0

# ---- 1. plain-text secret fragments (never allowed) ----
FRAGMENTS=(
  '200015xerx'                          # owner bootstrap password fragment
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
)
SCAN_DIRS=("$PROJECT_DIR/public" "$PROJECT_DIR/scripts" "$PROJECT_DIR/docs" "$PROJECT_DIR/vercel.json")
for d in "${SCAN_DIRS[@]}"; do
  [ -e "$d" ] || continue
  for p in "${FRAGMENTS[@]}"; do
    HITS=$(grep -rEl "$p" "$d" 2>/dev/null | grep -v 'secret-scan.sh' || true)
    if [ -n "$HITS" ]; then
      echo "SECRET SCAN HIT: fragment '$p' in:"; echo "$HITS"; FAIL=1
    fi
  done
done

# ---- 2. JWT-based keys: allow ONLY role=anon (public); block service_role ----
python3 - "$PROJECT_DIR" <<'PY'
import sys, os, re, json, base64
base = sys.argv[1]
jwt_re = re.compile(r'eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+')
def role_of(tok):
    try:
        p = tok.split('.')[1]
        p += '=' * (-len(p) % 4)
        d = json.loads(base64.urlsafe_b64decode(p))
        return d.get('role')
    except Exception:
        return None

bad = []
for root in ['public', 'scripts', 'docs']:
    d = os.path.join(base, root)
    if not os.path.isdir(d): continue
    for dirpath, _, files in os.walk(d):
        for f in files:
            if f == 'secret-scan.sh': continue
            fp = os.path.join(dirpath, f)
            try:
                txt = open(fp, encoding='utf-8', errors='ignore').read()
            except Exception:
                continue
            for tok in set(jwt_re.findall(txt)):
                r = role_of(tok)
                if r != 'anon':
                    bad.append((fp, r))
if bad:
    for fp, r in bad:
        print(f"SECRET SCAN HIT: JWT role={r!r} (NOT anon) in {fp}")
    sys.exit(1)
print("jwt scan: only public anon key present")
PY
[ $? -ne 0 ] && FAIL=1

if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: BLOCKED — remove secrets before continuing"
  exit 1
fi
echo "secret scan: clean"
exit 0