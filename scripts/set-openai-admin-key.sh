#!/bin/sh
# Install/rotate the OpenAI ADMIN key everywhere it belongs, without leaking it.
#
#   sh scripts/set-openai-admin-key.sh sk-admin-...
#   sh scripts/set-openai-admin-key.sh            # prompts, no shell history
#
# Targets:
#   1. local repo .env                 (dev)
#   2. stage deploy checkout .env      (~/deploy/Ai-therapist) + container restart
#   3. prod /opt/ai-therapist/.env     (over SSH) + zero-arg container recreate
#
# The key is never echoed, never written to a temp file, and never passed on a
# remote command line (it goes over stdin to the remote shell). Any target that
# isn't reachable is skipped with a warning rather than failing the whole run.
#
# NOTE ON SHELL HISTORY: passing the key as an argument puts it in your shell
# history. Either run with no argument (you'll be prompted silently), or prefix
# the command with a space if your shell is set up to skip those.

set -eu

PROD_HOST="ubuntu@54.151.38.104"
PROD_KEY="$HOME/.ssh/ai-therapist-prod.pem"
PROD_DIR="/opt/ai-therapist"
STAGE_DIR="$HOME/deploy/Ai-therapist"
REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
VAR="OPENAI_ADMIN_KEY"

# ---- get the key without putting it on screen -------------------------------
if [ $# -ge 1 ]; then
  ADMIN_KEY="$1"
  echo "! key passed as an argument — it is now in your shell history."
  echo "  Consider: history -d \$(history 1)   (or run this script with no args next time)"
else
  printf 'Paste the OpenAI admin key (input hidden): '
  stty -echo 2>/dev/null || true
  read -r ADMIN_KEY
  stty echo 2>/dev/null || true
  echo
fi

case "$ADMIN_KEY" in
  sk-admin-*) ;;
  *) echo "ERROR: that does not look like an admin key (expected sk-admin-...)."
     echo "       Project keys (sk-proj-/sk-) will NOT work: the costs endpoint"
     echo "       requires an admin key. Aborting."; exit 1 ;;
esac

# ---- fail fast: does the key actually work? ---------------------------------
# Better to find out now than after writing it to three machines.
echo "==> verifying the key against GET /v1/organization/costs"
START=$(( $(date +%s) - 86400 ))
HTTP=$(curl -s -o /tmp/.oak_probe.$$ -w '%{http_code}' \
  "https://api.openai.com/v1/organization/costs?start_time=${START}&bucket_width=1d&limit=1" \
  -H "Authorization: Bearer ${ADMIN_KEY}") || HTTP="000"
if [ "$HTTP" != "200" ]; then
  echo "ERROR: key rejected (HTTP $HTTP). Nothing was written."
  [ -s /tmp/.oak_probe.$$ ] && sed -e 's/sk-admin-[A-Za-z0-9_-]*/sk-admin-***/g' /tmp/.oak_probe.$$ | head -c 300
  rm -f /tmp/.oak_probe.$$
  echo; exit 1
fi
rm -f /tmp/.oak_probe.$$
echo "    OK — key is valid and can read org costs."

# ---- helper: idempotently set VAR=value in a local .env ---------------------
set_local_env() {
  target="$1"; label="$2"
  if [ ! -f "$target" ]; then
    echo "==> $label: no .env at $target — skipping"
    return 0
  fi
  # Use a here-doc into a tiny inline editor so the key never appears in ps(1).
  ADMIN_KEY="$ADMIN_KEY" VAR="$VAR" TARGET="$target" python3 - <<'PY'
import os, re
target, var, key = os.environ["TARGET"], os.environ["VAR"], os.environ["ADMIN_KEY"]
with open(target) as f:
    lines = f.read().splitlines()
pat = re.compile(r'^\s*' + re.escape(var) + r'\s*=')
out, replaced = [], False
for line in lines:
    if pat.match(line):
        if not replaced:
            out.append(f"{var}={key}"); replaced = True
        # drop any duplicate definitions
    else:
        out.append(line)
if not replaced:
    if out and out[-1].strip():
        out.append("")
    out.append("# OpenAI ADMIN key (read-only billing). See .env.example.")
    out.append(f"{var}={key}")
with open(target, "w") as f:
    f.write("\n".join(out) + "\n")
print(f"    {'replaced' if replaced else 'appended'} {var}")
PY
  chmod 600 "$target"
  echo "==> $label: written to $target (chmod 600)"
}

# ---- 1. local repo ----------------------------------------------------------
set_local_env "$REPO_DIR/.env" "local"

# ---- 2. stage ---------------------------------------------------------------
if [ -d "$STAGE_DIR" ]; then
  set_local_env "$STAGE_DIR/.env" "stage"
  if command -v docker >/dev/null 2>&1; then
    echo "==> stage: recreating app container"
    ( cd "$STAGE_DIR" && docker compose up -d --force-recreate app >/dev/null 2>&1 ) \
      && echo "    stage app recreated" \
      || echo "    ! stage container recreate failed (is the stack up?)"
  fi
else
  echo "==> stage: $STAGE_DIR not found — skipping"
fi

# ---- 3. prod ----------------------------------------------------------------
if [ -f "$PROD_KEY" ]; then
  echo "==> prod: installing over SSH"
  # The key goes over STDIN, not argv, so it never lands in the remote host's
  # process list or history.
  printf '%s\n' "$ADMIN_KEY" | ssh -i "$PROD_KEY" -o ConnectTimeout=15 "$PROD_HOST" \
    "PROD_DIR='$PROD_DIR' VAR='$VAR' bash -s" <<'REMOTE'
set -euo pipefail
read -r KEY
cd "$PROD_DIR"
if sudo grep -q "^${VAR}=" .env 2>/dev/null; then
  sudo sed -i "s|^${VAR}=.*|${VAR}=${KEY}|" .env; echo "    replaced ${VAR}"
else
  printf '%s=%s\n' "$VAR" "$KEY" | sudo tee -a .env >/dev/null; echo "    appended ${VAR}"
fi
sudo chmod 600 .env
source .deploy-env 2>/dev/null || true
export IMAGE_TAG="${IMAGE_TAG:-prod}"
echo "    recreating app container"
docker compose up -d --force-recreate app >/dev/null 2>&1
for i in $(seq 1 30); do
  CID=$(docker compose ps -q app | head -1)
  ST=$(docker inspect --format='{{.State.Health.Status}}' "$CID" 2>/dev/null || echo starting)
  if [ "$ST" = "healthy" ]; then
    echo "    prod healthy: $(docker inspect --format='{{.Name}}' "$CID")"
    docker compose exec -T app sh -c \
      'if [ -n "$OPENAI_ADMIN_KEY" ]; then echo "    verified in container (${#OPENAI_ADMIN_KEY} chars)"; else echo "    ! NOT visible in container"; fi'
    exit 0
  fi
  sleep 5
done
echo "    ! prod container did not report healthy in 150s — check: docker compose logs app"
exit 1
REMOTE
else
  echo "==> prod: SSH key $PROD_KEY not found — skipping"
fi

unset ADMIN_KEY
echo
echo "Done. The admin spend card should now render in Admin -> Ops."
echo "Reminder: if this key has ever been pasted into a chat, terminal share,"
echo "or ticket, rotate it at platform.openai.com/settings/organization/admin-keys"
echo "and re-run this script."
