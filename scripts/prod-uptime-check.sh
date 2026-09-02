#!/usr/bin/env bash
# Prod uptime check (ai-therapist-134). Runs on the home box via launchd every
# 5 minutes: curls prod /health and pages the on-call phone through the local
# iMessage bridge when it's down. Free, no third-party service, reuses the
# exact alert path crisis paging uses.
#
# Anti-spam state machine (state file in ~/docker-services):
#   - Alert only after 2 CONSECUTIVE failures (a single blip never pages).
#   - While down, re-page at most once per hour.
#   - Page once on recovery.
#
# Install (one-time):
#   cp scripts/prod-uptime-check.sh ~/docker-services/
#   cp scripts/com.nathan.ai-therapist-uptime.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.nathan.ai-therapist-uptime.plist
set -u

PROD_URL="https://ai.byuisresearch.com/health"
STATE_FILE="$HOME/docker-services/ai-therapist-uptime.state"
ENV_FILE="$HOME/docker-services/.env"          # IMESSAGE_API_KEY
PHONE_ENV_FILE="$HOME/deploy/Ai-therapist/.env" # CRISIS_ALERT_PHONE
IMESSAGE_API_URL="http://100.79.61.79:8899"
REPAGE_SECONDS=3600

now=$(date +%s)
prev_status="up"; fail_count=0; last_page=0
if [ -f "$STATE_FILE" ]; then
  read -r prev_status fail_count last_page < "$STATE_FILE"
fi

page() {
  local msg="$1"
  local key phone
  key=$(grep -E '^IMESSAGE_API_KEY=' "$ENV_FILE" | cut -d= -f2-)
  phone=$(grep -E '^CRISIS_ALERT_PHONE=' "$PHONE_ENV_FILE" | cut -d= -f2-)
  [ -z "$key" ] || [ -z "$phone" ] && { echo "$(date -Iseconds) page skipped: key/phone missing"; return 1; }
  curl -s -m 10 -X POST "$IMESSAGE_API_URL/send" \
    -H "X-API-Key: $key" -H 'Content-Type: application/json' \
    -d "{\"recipient\": \"$phone\", \"message\": \"$msg\"}" > /dev/null \
    && echo "$(date -Iseconds) paged: $msg"
}

code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$PROD_URL" 2>/dev/null || echo 000)

if [ "$code" = "200" ]; then
  if [ "$prev_status" = "down" ]; then
    page "[uptime] ai.byuisresearch.com is BACK UP (health 200)"
  fi
  echo "up 0 0" > "$STATE_FILE"
else
  fail_count=$((fail_count + 1))
  status="down"
  if [ "$fail_count" -ge 2 ] && [ $((now - last_page)) -ge $REPAGE_SECONDS ]; then
    page "[uptime] ai.byuisresearch.com DOWN (health returned $code, $fail_count consecutive failures)"
    last_page=$now
  fi
  echo "$status $fail_count $last_page" > "$STATE_FILE"
  echo "$(date -Iseconds) check failed: HTTP $code (count $fail_count)"
fi
