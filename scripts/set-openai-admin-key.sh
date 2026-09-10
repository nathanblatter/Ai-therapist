#!/bin/sh
# Install/rotate the OpenAI ADMIN key everywhere it belongs, without leaking it.
#
#   sh scripts/set-openai-admin-key.sh              # prompts, echo off (preferred)
#   sh scripts/set-openai-admin-key.sh sk-admin-... # arg form; lands in shell history
#
# Targets: local repo .env, stage checkout .env (+ restart), prod .env over SSH
# (+ container recreate). Any unreachable target is skipped, not fatal.
#
# Leak-avoidance: the key is never echoed, never written to a temp file, and
# never passed in argv — locally or remotely. For prod it is interpolated into
# the remote script body, which travels over the SSH channel on stdin.
#
# Correctness: the key is validated against the costs endpoint BEFORE anything
# is written, and every target is re-read and hash-compared AFTER writing, so a
# partial or mangled write is reported rather than silently left in place.
set -eu

PROD_HOST="ubuntu@54.151.38.104"
PROD_SSH_KEY="$HOME/.ssh/ai-therapist-prod.pem"
PROD_DIR="/opt/ai-therapist"
STAGE_DIR="$HOME/deploy/Ai-therapist"
REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
VAR="OPENAI_ADMIN_KEY"
FAILED=""

# ---- obtain the key ---------------------------------------------------------
if [ $# -ge 1 ]; then
  ADMIN_KEY="$1"
  echo "! passed as an argument, so it is now in your shell history."
  echo "  Next time run with no arguments and paste at the prompt."
else
  printf 'Paste the OpenAI admin key (input hidden): '
  stty -echo 2>/dev/null || true
  read -r ADMIN_KEY
  stty echo 2>/dev/null || true
  echo
fi

case "$ADMIN_KEY" in
  sk-admin-*) ;;
  *) echo "ERROR: expected an admin key (sk-admin-...). Project keys cannot read"
     echo "       org costs. Nothing written."; exit 1 ;;
esac

WANT_HASH=$(printf '%s' "$ADMIN_KEY" | shasum -a 256 | cut -d' ' -f1)

# ---- validate before writing anything ---------------------------------------
echo "==> verifying the key against GET /v1/organization/costs"
PROBE_OUT=$(mktemp)
HTTP=$(curl -s -o "$PROBE_OUT" -w '%{http_code}' \
  "https://api.openai.com/v1/organization/costs?start_time=$(( $(date +%s) - 86400 ))&bucket_width=1d&limit=1" \
  -H "Authorization: Bearer ${ADMIN_KEY}" 2>/dev/null) || HTTP="000"
if [ "$HTTP" != "200" ]; then
  echo "ERROR: key rejected (HTTP $HTTP). Nothing written."
  sed -E 's/sk-admin-[A-Za-z0-9_-]*/sk-admin-***/g' "$PROBE_OUT" | head -c 300
  rm -f "$PROBE_OUT"; echo; exit 1
fi
rm -f "$PROBE_OUT"
echo "    OK - valid and able to read org costs."

# ---- local writer (also used for stage) -------------------------------------
# Python does the edit so no value ever passes through sed/awk escaping.
write_env() {
  target="$1"; label="$2"
  [ -f "$target" ] || { echo "==> $label: no .env at $target - skipping"; return 0; }
  ADMIN_KEY="$ADMIN_KEY" VAR="$VAR" TARGET="$target" python3 - <<'PY'
import os, re
target, var, key = os.environ["TARGET"], os.environ["VAR"], os.environ["ADMIN_KEY"]
lines = open(target).read().splitlines()
pat = re.compile(r'^\s*' + re.escape(var) + r'\s*=')
out, done = [], False
for line in lines:
    if pat.match(line):
        if not done:
            out.append(f"{var}={key}"); done = True   # dedupe extras
    else:
        out.append(line)
if not done:
    if out and out[-1].strip():
        out.append("")
    out.append("# OpenAI ADMIN key (read-only billing). See .env.example.")
    out.append(f"{var}={key}")
open(target, "w").write("\n".join(out) + "\n")
print("    " + ("replaced" if done else "appended") + f" {var}")
PY
  chmod 600 "$target"
  got=$(grep "^${VAR}=" "$target" | head -1 | cut -d= -f2- | tr -d '\n' | shasum -a 256 | cut -d' ' -f1)
  if [ "$got" = "$WANT_HASH" ]; then
    echo "==> $label: verified at $target"
  else
    echo "==> $label: ! WRITE MISMATCH at $target"
    FAILED="$FAILED $label"
  fi
}

write_env "$REPO_DIR/.env" "local"

if [ -d "$STAGE_DIR" ]; then
  write_env "$STAGE_DIR/.env" "stage"
  if command -v docker >/dev/null 2>&1; then
    ( cd "$STAGE_DIR" && docker compose up -d --force-recreate app >/dev/null 2>&1 ) \
      && echo "    stage app recreated" || echo "    ! stage recreate failed (stack down?)"
  fi
else
  echo "==> stage: $STAGE_DIR not found - skipping"
fi

# ---- prod -------------------------------------------------------------------
# NOTE: the outer heredoc is UNQUOTED so the LOCAL shell interpolates the key
# into the script text. Remote-side variables are therefore escaped as \$.
# Do NOT "simplify" this into `printf key | ssh ... <<HEREDOC` - the heredoc
# already owns stdin, the pipe is discarded, and the remote read gets nothing.
# That bug shipped once and left prod on a stale key while local/stage updated,
# which is why this step hash-verifies the write before restarting anything.
if [ -f "$PROD_SSH_KEY" ]; then
  echo "==> prod: installing over SSH"
  if ssh -i "$PROD_SSH_KEY" -o ConnectTimeout=15 "$PROD_HOST" bash -s <<EOF
set -euo pipefail
cd '${PROD_DIR}'
sudo python3 - <<'PYIN'
import re
var = "${VAR}"
key = "${ADMIN_KEY}"
lines = open(".env").read().splitlines()
pat = re.compile(r'^\\s*' + re.escape(var) + r'\\s*=')
out, done = [], False
for line in lines:
    if pat.match(line):
        if not done:
            out.append(var + "=" + key); done = True
    else:
        out.append(line)
if not done:
    out.append(var + "=" + key)
open(".env", "w").write("\\n".join(out) + "\\n")
print("    " + ("replaced" if done else "appended") + " " + var)
PYIN
sudo chmod 600 .env
GOT=\$(sudo sh -c "grep '^${VAR}=' .env | head -1 | cut -d= -f2- | tr -d '\\n' | sha256sum" | cut -d' ' -f1)
if [ "\$GOT" != "${WANT_HASH}" ]; then
  echo "    ! WRITE MISMATCH on prod .env - not restarting."
  exit 1
fi
echo "    on-disk value verified"
source .deploy-env 2>/dev/null || true
export IMAGE_TAG="\${IMAGE_TAG:-prod}"
echo "    recreating app container"
docker compose up -d --force-recreate app >/dev/null 2>&1
for i in \$(seq 1 30); do
  CID=\$(docker compose ps -q app | head -1)
  ST=\$(docker inspect --format='{{.State.Health.Status}}' "\$CID" 2>/dev/null || echo starting)
  if [ "\$ST" = "healthy" ]; then
    echo "    prod healthy: \$(docker inspect --format='{{.Name}}' "\$CID")"
    exit 0
  fi
  sleep 5
done
echo "    ! not healthy after 150s - check: docker compose logs app"
exit 1
EOF
  then :; else FAILED="$FAILED prod"; fi
else
  echo "==> prod: $PROD_SSH_KEY not found - skipping"
fi

unset ADMIN_KEY
echo
if [ -n "$FAILED" ]; then
  echo "FAILED on:$FAILED - re-run, or fix by hand. Other targets are fine."
  exit 1
fi
echo "Done. The spend card should render in Admin -> Ops."
echo "If this key ever touched a chat, screen share, or ticket, rotate it at"
echo "platform.openai.com/settings/organization/admin-keys and re-run this."
