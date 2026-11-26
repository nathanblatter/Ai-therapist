#!/usr/bin/env bash
# Create the first researcher account in a new AI Therapist Cognito pool
# (ai-therapist-398, 399).
#
#   scripts/cognito/create-first-researcher.sh <pool-id> <username>
#
# Why this exists: every other account is created from User Management, which
# needs a researcher who can already sign in. In a pool with nobody in it,
# somebody has to be first.
#
# The username must be the username of an existing researcher row in the
# app's `users` table for that environment: the app links a pool account to
# its row by username on the first sign-in, and refuses a pool account that
# has no row. The password is asked for on the terminal and is never an
# argument, so it does not land in shell history or a process list.
#
# Run with the same one-time Cognito admin credentials as create-pool.sh. It
# refuses to run outside the study account, and refuses a username the pool
# already has. On the first sign-in the app asks this account to set up an
# authenticator app (docs/cognito-auth.md, "Authenticator codes for staff").
#
# As of 2026-11-26 this script has not been run: no pool exists yet.
set -euo pipefail

POOL_ID="${1:-}"
USERNAME="${2:-}"
EXPECTED_ACCOUNT="104181502887"

if [[ ! "$POOL_ID" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]_[A-Za-z0-9]+$ ]] || [[ -z "$USERNAME" ]]; then
  echo "usage: $0 <pool-id, e.g. us-west-1_AbCdEf123> <username of an existing researcher row>" >&2
  exit 2
fi
REGION="${POOL_ID%%_*}"

export AWS_PAGER=""
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]]; then
  echo "refusing: these credentials are for account $ACCOUNT, not the study account $EXPECTED_ACCOUNT" >&2
  exit 1
fi

if aws cognito-idp admin-get-user --region "$REGION" --user-pool-id "$POOL_ID" --username "$USERNAME" >/dev/null 2>&1; then
  echo "refusing: the pool already has a user named $USERNAME (reset its password from User Management instead)" >&2
  exit 1
fi

if [[ ! -t 0 ]]; then
  echo "refusing: run this from a terminal so the password can be typed, not piped" >&2
  exit 1
fi
read -r -s -p "Password for $USERNAME (12 characters or more): " PASSWORD
echo
read -r -s -p "Again: " PASSWORD_AGAIN
echo
if [[ "$PASSWORD" != "$PASSWORD_AGAIN" ]]; then
  echo "the two passwords differ; nothing was created" >&2
  exit 1
fi
if (( ${#PASSWORD} < 12 )); then
  echo "the password is shorter than 12 characters; nothing was created" >&2
  exit 1
fi

echo "==> creating $USERNAME (no invitation is sent)"
aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$POOL_ID" \
  --username "$USERNAME" --message-action SUPPRESS >/dev/null

# From here on, a failure must not leave an account with a temporary password
# or without a role: delete it again, as the app does.
cleanup() {
  echo "a step failed; deleting the half-made user $USERNAME" >&2
  aws cognito-idp admin-delete-user --region "$REGION" --user-pool-id "$POOL_ID" --username "$USERNAME" || true
}
trap cleanup ERR

echo "==> setting the password"
# The password goes to the CLI on standard input (a JSON document), not on
# the command line (printf is a shell builtin, so it is in no process list).
printf '%s' "$PASSWORD" \
  | python3 -c 'import json,sys; print(json.dumps({"UserPoolId": sys.argv[1], "Username": sys.argv[2], "Password": sys.stdin.read(), "Permanent": True}))' \
      "$POOL_ID" "$USERNAME" \
  | aws cognito-idp admin-set-user-password --region "$REGION" --cli-input-json file:///dev/stdin >/dev/null
unset PASSWORD PASSWORD_AGAIN

echo "==> adding to the researcher group"
aws cognito-idp admin-add-user-to-group --region "$REGION" --user-pool-id "$POOL_ID" \
  --username "$USERNAME" --group-name researcher >/dev/null
trap - ERR

cat <<OUT

Done. $USERNAME can now sign in on the hosted page. The app will ask for an
authenticator app on the first sign-in. Every other account moves into the
pool when a new password is set for it in User Management.
OUT
